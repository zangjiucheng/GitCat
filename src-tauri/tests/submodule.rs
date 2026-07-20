//! Submodule status (M1 of 4, read-only). Mirrors branch_ops.rs/workdir.rs's
//! pattern of driving the real Tauri command function directly against a
//! throwaway `TempRepo`.
//!
//! `TempRepo` has no submodule-aware constructor, so every test here builds a
//! nested fixture by hand: a "child" `TempRepo` (the eventual submodule) and a
//! "parent" `TempRepo` (the superproject), wired together with the real `git
//! submodule add` CLI — never git2 — since that's what a real user's workflow
//! produces and what we want to classify correctly.
//!
//! `-c protocol.file.allow=always` is required on every command that has git
//! transport-fetch a `file://`-ish local path submodule/clone (verified
//! empirically: without it, git refuses with "fatal: transport 'file' not
//! allowed" once `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` are pointed at
//! /dev/null the way `TempRepo::git` isolates every test repo from the host's
//! config — the default `protocol.file.allow` disallows recursive/submodule
//! fetches over `file://`).
//!
//! The 6-state classification below (conflicted / removed / not-initialized /
//! out-of-date / dirty / clean) was verified empirically against real `git
//! submodule status`'s own `-`/`+`/` `/`U` prefix conventions in a throwaway
//! fixture before writing these tests (see `src/submodule.rs`'s module doc
//! comment for the exact bit patterns observed):
//!   - conflicted: the superproject's OWN index has an unresolved merge
//!     conflict at the submodule's gitlink path (two branches bumped the
//!     tracked commit differently). Not a `SubmoduleStatus` bit at all —
//!     detected via `Index::conflicts()` instead (see
//!     `submodule_gitlink_merge_conflict_is_not_clean`).
//!   - removed: INDEX_DELETED set — `submodule_remove` already staged this
//!     submodule's removal (gitlink deleted from the index), nothing
//!     committed yet (bug-fix regression, see `bug6_submodule_status_reports_removed_not_clean_after_submodule_remove_stages_deletion`).
//!   - not-initialized ("-" prefix): produced by a fresh `git clone` of the
//!     superproject with NO `git submodule init`/`update` run afterward, OR a
//!     submodule directory manually `rm -rf`'d (not `git submodule deinit`'d)
//!     — two different git2 bits (WD_UNINITIALIZED / WD_DELETED
//!     respectively) that both map to this one classification, matching real
//!     `git submodule status`'s own `-` prefix for both. `git submodule add`
//!     itself immediately initializes+clones, so cloning fresh (not
//!     deiniting) is the faithful way to reach the WD_UNINITIALIZED case.
//!   - out-of-date ("+" prefix): the superproject's tracked gitlink (index/
//!     HEAD) was bumped to a newer child commit — via `update-index
//!     --cacheinfo` standing in for "someone else advanced the submodule
//!     pointer and you pulled it" — while the submodule's own checked-out
//!     workdir was never updated to match.
//!   - dirty (no distinct prefix in `git submodule status` — verified it
//!     stays a plain space; only shows via `git status --porcelain` as
//!     " M <path>"): an uncommitted OR staged-but-uncommitted edit inside the
//!     submodule's own working tree/index, commit unchanged.
//!   - clean: freshly added + committed, nothing else touched.

mod common;

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use common::TempRepo;
use gitcat_lib::submodule::{
    submodule_add, submodule_deinit, submodule_init, submodule_remove, submodule_status, submodule_sync,
    submodule_update,
};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// Add `child` as a submodule of `parent` at `sub_path` via the real `git
/// submodule add` CLI (never git2 — this is meant to reproduce exactly what a
/// real user's workflow leaves behind). Commits the addition. Returns the
/// submodule's tracked (== checked-out, right after `add`) commit sha.
fn add_submodule(parent: &TempRepo, child: &TempRepo, sub_path: &str) -> String {
    parent.must(&[
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        &child.path(),
        sub_path,
    ]);
    parent.must(&["commit", "-q", "-m", "add submodule"]);
    parent.must(&["-C", sub_path, "rev-parse", "HEAD"])
}

/// A disposable `git clone` of `src` into a fresh temp dir, WITHOUT
/// `--recurse-submodules` and without ever running `git submodule init` —
/// the one setup path that genuinely leaves a registered submodule
/// uninitialized (verified empirically; `git submodule add` does not, it
/// clones+inits immediately). Cleaned up on drop, same as `TempRepo`.
struct FreshClone {
    dir: PathBuf,
}

impl FreshClone {
    fn of(src: &TempRepo, tag: &str) -> Self {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join(format!("gitcat-test-clone-{tag}-{}-{}-{}", std::process::id(), nanos, seq));
        let out = Command::new("git")
            .args(["-c", "protocol.file.allow=always", "clone", "-q"])
            .arg(src.path())
            .arg(&dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .expect("failed to spawn git clone");
        assert!(out.status.success(), "git clone failed: {}", String::from_utf8_lossy(&out.stderr));
        FreshClone { dir }
    }

    fn path(&self) -> String {
        self.dir.to_string_lossy().to_string()
    }

    /// Run `git -C <dir> <args…>` inside the clone, isolated from the host's
    /// global/system config the same way `TempRepo::git` is. Only ever used
    /// here to INSPECT config/refs/status — a `FreshClone` has no configured
    /// identity, so it must never be used to commit.
    fn git(&self, args: &[&str]) -> (bool, String, String) {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .expect("failed to spawn git");
        (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        )
    }
}

impl Drop for FreshClone {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn repo_with_no_submodules_returns_empty_list() {
    let repo = TempRepo::init("submodule_none");
    let _c0 = repo.commit("f.txt", "hello\n", "c0");

    let rows = tauri::async_runtime::block_on(submodule_status(repo.path())).expect("submodule_status failed");
    assert!(rows.is_empty(), "expected no submodules, got {} rows", rows.len());
}

#[test]
fn freshly_cloned_submodule_is_not_initialized() {
    let child = TempRepo::init("submodule_ni_child");
    let child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_ni_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    // A fresh clone of the superproject, with no submodule init/update run —
    // the registered submodule's working directory is genuinely empty.
    let clone = FreshClone::of(&parent, "submodule_ni");
    assert!(
        std::fs::read_dir(PathBuf::from(clone.path()).join("sub")).unwrap().next().is_none(),
        "sub/ should be an empty directory before init"
    );

    let rows = tauri::async_runtime::block_on(submodule_status(clone.path())).expect("submodule_status failed");
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.path, "sub");
    assert_eq!(row.name, "sub");
    assert_eq!(row.status, "not-initialized");
    assert_eq!(row.head_sha.as_deref(), Some(child_c0.as_str()));
    assert!(row.workdir_sha.is_none(), "never-cloned submodule must have no workdir sha");
}

#[test]
fn submodule_in_sync_is_clean() {
    let child = TempRepo::init("submodule_clean_child");
    let child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_clean_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    let rows = tauri::async_runtime::block_on(submodule_status(parent.path())).expect("submodule_status failed");
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.status, "clean");
    assert_eq!(row.head_sha.as_deref(), Some(child_c0.as_str()));
    assert_eq!(row.workdir_sha.as_deref(), Some(child_c0.as_str()));
}

#[test]
fn submodule_with_uncommitted_change_is_dirty() {
    let child = TempRepo::init("submodule_dirty_child");
    let _child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_dirty_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    // Uncommitted edit INSIDE the submodule's own working tree; the checked
    // out commit itself does not change.
    std::fs::write(parent.dir.join("sub").join("f.txt"), "hello\nlocally edited\n")
        .expect("write inside submodule workdir");

    // Sanity: this is exactly the case real `git submodule status` does NOT
    // flag in its own prefix (stays " ", not "+"/"-") — only `git status
    // --porcelain` on the superproject shows " M sub". We assert git2 (via
    // our command) still catches it, since that's the whole point of this
    // richer classification.
    // NOTE: `TempRepo::git` trims stdout, which eats the leading space of
    // porcelain's "XY path" columns on the first line — real `git status
    // --porcelain` output is " M sub" (unstaged-modified), confirmed
    // empirically; we just can't assert the leading space back here.
    let (ok, out, _) = parent.git(&["status", "--porcelain"]);
    assert!(ok);
    assert!(out.contains("M sub"), "expected superproject to see sub as modified: {out:?}");

    let rows = tauri::async_runtime::block_on(submodule_status(parent.path())).expect("submodule_status failed");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, "dirty");
}

#[test]
fn submodule_with_bumped_tracked_commit_is_out_of_date() {
    let child = TempRepo::init("submodule_ood_child");
    let child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_ood_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    // Advance the child independently of the submodule's checked-out copy.
    let child_c1 = child.commit("f.txt", "hello\nmore\n", "c1");
    assert_ne!(child_c0, child_c1);

    // Bump the superproject's tracked gitlink straight to c1 WITHOUT touching
    // parent/sub's actual working tree (stands in for "you pulled a
    // superproject commit that advanced the submodule pointer, but haven't
    // run `git submodule update` yet") — verified empirically this reproduces
    // exactly the "+"-prefixed `git submodule status` case.
    parent.must(&["update-index", "--cacheinfo", &format!("160000,{child_c1},sub")]);
    parent.must(&["commit", "-q", "-m", "bump submodule pointer"]);

    let (_, sm_status, _) = parent.git(&["submodule", "status"]);
    assert!(sm_status.starts_with('+'), "expected a '+'-prefixed submodule status: {sm_status:?}");

    let rows = tauri::async_runtime::block_on(submodule_status(parent.path())).expect("submodule_status failed");
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.status, "out-of-date");
    assert_eq!(row.head_sha.as_deref(), Some(child_c1.as_str()), "tracked sha should be the bumped one");
    assert_eq!(
        row.workdir_sha.as_deref(),
        Some(child_c0.as_str()),
        "checked-out sha should still be the original one"
    );
}

// ---------------------------------------------------------------------------
// Regression tests (3 bugs found in review of the above; see submodule.rs's
// module doc comment / classify_status / submodule_conflicted for the fixes):
//   1. classify_status missed WD_INDEX_MODIFIED (a staged-but-uncommitted
//      change INSIDE the submodule's own index) — misreported "clean".
//   2. classify_status missed WD_DELETED (submodule dir manually rm -rf'd,
//      not `git submodule deinit`'d) — misreported "clean" with a null
//      workdir_sha, which is internally inconsistent (a "clean" row that was
//      never actually checked out).
//   3. A merge-conflicted gitlink entry in the superproject's own index sets
//      none of `SubmoduleStatus`'s bits at all (empirically verified below —
//      it comes back INDEX_DELETED | WD_ADDED, none of which classify_status
//      recognized), so it fell all the way through to "clean" despite
//      head_sha/workdir_sha genuinely differing and the repo being mid-merge.
// ---------------------------------------------------------------------------

#[test]
fn submodule_with_staged_uncommitted_change_is_dirty() {
    let child = TempRepo::init("submodule_staged_dirty_child");
    let _child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_staged_dirty_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    // Edit AND `git add` (but never commit) a change inside the submodule's
    // own working tree/index — sets WD_INDEX_MODIFIED specifically (verified
    // empirically: distinct from, and NOT accompanied by, WD_WD_MODIFIED or
    // WD_UNTRACKED — the two bits `classify_status` already checked before
    // this fix). Without the WD_INDEX_MODIFIED arm, this staged-but-
    // uncommitted change was misreported as "clean".
    std::fs::write(parent.dir.join("sub").join("f.txt"), "hello\nstaged edit\n")
        .expect("write inside submodule workdir");
    parent.must(&["-C", "sub", "add", "f.txt"]);

    let (ok, out, _) = parent.git(&["status", "--porcelain"]);
    assert!(ok);
    assert!(out.contains("M sub"), "expected superproject to see sub as modified: {out:?}");

    let rows = tauri::async_runtime::block_on(submodule_status(parent.path())).expect("submodule_status failed");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, "dirty", "a staged-but-uncommitted change inside the submodule must not read as clean");
}

#[test]
fn manually_deleted_submodule_directory_is_not_initialized() {
    let child = TempRepo::init("submodule_deleted_child");
    let child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_deleted_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    // Manually `rm -rf` the ENTIRE submodule directory — NOT `git submodule
    // deinit`, and NOT merely emptying its contents while leaving the `sub/`
    // directory itself in place (verified empirically: an emptied-but-present
    // directory still reads as WD_UNINITIALIZED, the pre-existing "never
    // cloned" case; only removing the directory itself sets WD_DELETED,
    // "in index, not in workdir" — a distinct bit git2 sets when the gitlink
    // is registered but the workdir path is entirely gone).
    std::fs::remove_dir_all(parent.dir.join("sub")).expect("remove submodule dir");

    let rows = tauri::async_runtime::block_on(submodule_status(parent.path())).expect("submodule_status failed");
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(
        row.status, "not-initialized",
        "a manually rm -rf'd submodule dir must classify the same as never-cloned, not clean"
    );
    assert_eq!(row.head_sha.as_deref(), Some(child_c0.as_str()));
    assert!(row.workdir_sha.is_none(), "a removed submodule dir must have no workdir sha");
}

#[test]
fn submodule_gitlink_merge_conflict_is_not_clean() {
    let child = TempRepo::init("submodule_conflict_child");
    let c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_conflict_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub"); // locks the tracked gitlink to c0.

    // Advance the child AFTER add_submodule (add_submodule clones the
    // child's HEAD at call time — advancing it first would silently bake the
    // later commit into the initial clone instead of leaving c0 as the
    // common base both superproject branches diverge from).
    let c1 = child.commit("f.txt", "hello\nmore\n", "c1");
    let c2 = child.commit("f.txt", "hello\nother\n", "c2");

    // main and feature both start from the "add submodule" commit (sub ==
    // c0), then each bumps the tracked gitlink to a DIFFERENT child commit —
    // mirrors tests/merge.rs's build_conflicting_repo pattern, just at the
    // gitlink level instead of a file's content.
    parent.must(&["branch", "feature"]);

    parent.must(&["update-index", "--cacheinfo", &format!("160000,{c1},sub")]);
    parent.must(&["commit", "-q", "-m", "main -> c1"]);

    parent.must(&["checkout", "-q", "feature"]);
    parent.must(&["update-index", "--cacheinfo", &format!("160000,{c2},sub")]);
    parent.must(&["commit", "-q", "-m", "feature -> c2"]);

    parent.must(&["checkout", "-q", "main"]);
    let (ok, so, _se) = parent.git(&["merge", "-q", "feature"]);
    assert!(!ok, "expected the submodule gitlink merge to conflict");
    assert!(so.contains("CONFLICT"), "expected a real submodule conflict, got: {so:?}");
    assert_eq!(parent.open().state(), git2::RepositoryState::Merge, "expected a real mid-merge repo state");
    assert!(parent.open().index().unwrap().has_conflicts(), "expected the index to carry the unresolved gitlink");

    let rows = tauri::async_runtime::block_on(submodule_status(parent.path())).expect("submodule_status failed");
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_ne!(row.status, "clean", "a merge-conflicted gitlink must never read as clean");
    assert_eq!(row.status, "conflicted", "expected the dedicated conflicted classification");
    // head_sha/workdir_sha genuinely differ underneath the conflict: HEAD
    // (main)'s tracked commit is c1, but the submodule's own checked-out
    // working tree was never touched by the (failed) merge and is still c0.
    assert_eq!(row.head_sha.as_deref(), Some(c1.as_str()));
    assert_eq!(row.workdir_sha.as_deref(), Some(c0.as_str()));
    let _ = c2;
}

// `absolute_path`: the field that lets the frontend `invoke("load_graph", {
// path: row.absolutePath })` (etc.) to open a submodule and manage it exactly
// like the root repo — the whole point of this field. MUST be
// `Path::join`-computed (never string concatenation, which would produce a
// wrong or wrongly-separated path on Windows), so both tests below verify the
// actual on-disk path via `std::fs::canonicalize`, not just string equality.
#[test]
fn submodule_status_reports_correct_absolute_path_for_a_normal_submodule() {
    let child = TempRepo::init("submodule_abspath_child");
    let _child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_abspath_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    let rows = tauri::async_runtime::block_on(submodule_status(parent.path())).expect("submodule_status failed");
    assert_eq!(rows.len(), 1);
    let row = &rows[0];

    // Must be a real, well-formed absolute path — not empty, not relative.
    assert!(!row.absolute_path.is_empty(), "absolute_path must not be empty");
    assert!(
        std::path::Path::new(&row.absolute_path).is_absolute(),
        "absolute_path must be absolute, got {:?}",
        row.absolute_path
    );

    // The REAL, empirical check: this must be the exact on-disk path of the
    // submodule's own working directory — `parent`'s workdir joined with
    // `sub`, via `Path::join`, not a hand-rolled string concatenation.
    // Canonicalize both sides (rather than a raw string comparison) since the
    // OS temp dir itself can be a symlink (e.g. macOS's `/tmp` ->
    // `/private/tmp`) — canonicalize resolves that on both sides identically,
    // so this is purely testing the join logic, not host-specific symlink
    // trivia.
    let expected = std::fs::canonicalize(parent.dir.join("sub")).expect("canonicalize expected sub dir");
    let actual = std::fs::canonicalize(&row.absolute_path).expect("canonicalize row.absolute_path");
    assert_eq!(actual, expected, "absolute_path must equal parent workdir joined with the submodule's relative path");
}

// A submodule-of-a-submodule, empirically verified from the MID-level repo's
// own point of view (not the top-level superproject's): `submodule_status`
// only ever walks whatever repo path it is CALLED against (never recurses),
// so calling it on "sub" (itself a checked-out submodule of "parent", and
// itself a superproject of its own "nested" submodule) must compute
// `absolute_path` relative to "sub"'s OWN workdir — NOT "parent"'s. A buggy
// implementation that accidentally anchored every `absolute_path` at some
// fixed/outer workdir (e.g. always the process's cwd, or always the
// outermost repo ever opened) would still produce a plausible-looking
// string here; only comparing against the real on-disk canonical path (as
// below) catches that.
#[test]
fn submodule_status_on_a_mid_level_repo_computes_absolute_path_relative_to_its_own_workdir() {
    // grandchild <- (submodule "nested" of) <- mid <- (submodule "sub" of) <- parent
    let grandchild = TempRepo::init("submodule_abspath_nested_grandchild");
    let _gc0 = grandchild.commit("gc.txt", "grandchild\n", "gc0");

    let mid = TempRepo::init("submodule_abspath_nested_mid");
    let _mid0 = mid.commit("mid.txt", "mid\n", "mid0");
    add_submodule(&mid, &grandchild, "nested");

    let parent = TempRepo::init("submodule_abspath_nested_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &mid, "sub");

    // Sanity: from the TOP-level repo, submodule_status only sees "sub" (its
    // own direct submodule) — "nested" is one level deeper and is not a
    // top-level entry of `parent`'s own .gitmodules at all.
    let top_rows = tauri::async_runtime::block_on(submodule_status(parent.path())).expect("submodule_status (top) failed");
    assert_eq!(top_rows.len(), 1);
    assert_eq!(top_rows[0].path, "sub");
    let expected_sub = std::fs::canonicalize(parent.dir.join("sub")).expect("canonicalize sub dir");
    let actual_sub = std::fs::canonicalize(&top_rows[0].absolute_path).expect("canonicalize top row absolute_path");
    assert_eq!(actual_sub, expected_sub, "top-level row's absolute_path must be parent's workdir + \"sub\"");

    // Now call submodule_status on "sub" ITSELF (the mid-level repo — a
    // checked-out submodule of `parent` that is, simultaneously, its own
    // fully-fledged repo with its own "nested" submodule registered). This is
    // exactly what the frontend does after "opening" a submodule: it treats
    // `sub`'s own absolute_path as a brand-new active repo root.
    let sub_path = parent.dir.join("sub").to_string_lossy().to_string();
    let mid_rows = tauri::async_runtime::block_on(submodule_status(sub_path)).expect("submodule_status (mid-level) failed");
    assert_eq!(mid_rows.len(), 1, "sub's own .gitmodules registers exactly one submodule: nested");
    let nested_row = &mid_rows[0];
    assert_eq!(nested_row.path, "nested");

    // The crux of this test: "nested"'s absolute_path must be relative to
    // "sub"'s OWN workdir (parent/sub/nested), not the top-level parent's
    // workdir (which would wrongly compute to parent/nested).
    let expected_nested = std::fs::canonicalize(parent.dir.join("sub").join("nested"))
        .expect("canonicalize sub/nested dir (should exist, even if not yet checked out)");
    let actual_nested =
        std::fs::canonicalize(&nested_row.absolute_path).expect("canonicalize nested row absolute_path");
    assert_eq!(
        actual_nested, expected_nested,
        "nested submodule's absolute_path must be sub's own workdir + \"nested\", not parent's"
    );

    // Negative control: prove this genuinely differs from (rather than
    // coincidentally equaling) what a top-level-anchored bug would produce.
    let wrongly_anchored_at_parent = std::fs::canonicalize(parent.dir.join("nested"));
    assert!(
        wrongly_anchored_at_parent.is_err() || wrongly_anchored_at_parent.unwrap() != expected_nested,
        "parent/nested must not exist / must not coincide with the correct sub/nested path"
    );
}

// Both tests above only ever register a submodule at a SINGLE-component path
// ("sub", "nested") — `sm.path()` (what `absolute_path` is joined against
// `repo.workdir()` with) never itself contains a `/`, so a bug that joins
// `wd.join(&sm_path)` in ONE call (fine on Unix, where `/` already IS the
// native separator, but on Windows leaves any separator embedded INSIDE a
// multi-component `sm_path` un-renormalized — see `join_native_relative`'s
// doc comment in src/submodule.rs) can't be told apart from the fix by these
// alone. This one registers a submodule two directories deep
// ("vendor/lib-a" — "vendor" a plain, non-submodule directory that git
// itself creates on `submodule add`, "lib-a" the actual submodule)
// specifically so `sm_path` is multi-component. On THIS host (Unix), both
// the buggy single-join and the fixed per-component-join code paths produce
// byte-identical results — `/` is the native separator either way, so this
// can only exercise the SPLIT/JOIN logic's correctness, not the Windows-only
// mixed-separator symptom itself (there is no way to observe that without an
// actual Windows build — see this repo's task notes). It still locks in the
// on-disk path is correct for a nested path and guards against a future
// regression that mishandles multi-component paths in some OTHER way (e.g.
// truncating to just the last component).
#[test]
fn submodule_status_reports_correct_absolute_path_for_a_multi_component_nested_path() {
    let child = TempRepo::init("submodule_abspath_multi_component_child");
    let _child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_abspath_multi_component_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    // "vendor" is NOT itself a submodule boundary — just a plain directory
    // `git submodule add` creates on the fly to hold "lib-a" — so `sm.path()`
    // for this row comes back as the literal 2-component string "vendor/lib-a".
    add_submodule(&parent, &child, "vendor/lib-a");

    let rows = tauri::async_runtime::block_on(submodule_status(parent.path())).expect("submodule_status failed");
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.path, "vendor/lib-a");

    assert!(!row.absolute_path.is_empty(), "absolute_path must not be empty");
    assert!(
        std::path::Path::new(&row.absolute_path).is_absolute(),
        "absolute_path must be absolute, got {:?}",
        row.absolute_path
    );

    let expected = std::fs::canonicalize(parent.dir.join("vendor").join("lib-a"))
        .expect("canonicalize expected vendor/lib-a dir");
    let actual = std::fs::canonicalize(&row.absolute_path).expect("canonicalize row.absolute_path");
    assert_eq!(
        actual, expected,
        "absolute_path must equal parent workdir joined with EVERY component of the submodule's relative path"
    );

    // Extra, string-level check (not just canonicalize-based) that every
    // separator in the result is native — meaningless as a Windows-mixed-
    // separator regression check on this Unix host (where `/` already IS
    // `std::path::MAIN_SEPARATOR`), but does confirm `absolute_path` wasn't
    // truncated or reordered relative to the two components.
    assert!(row.absolute_path.ends_with(&format!("vendor{}lib-a", std::path::MAIN_SEPARATOR)));
}

// ---------------------------------------------------------------------------
// M2: submodule_init / submodule_update
// ---------------------------------------------------------------------------
//
// `submodule_init`/`submodule_update`'s own git-CLI runner (submodule.rs)
// deliberately does NOT pass `-c protocol.file.allow=always` the way the
// fixture helpers above do — real submodule URLs are https/ssh, and file://
// submodule fetches are meant to stay refused by git's own default (see
// GHSA-8h47-9cfr-w2c3, the CVE this default protects against). So any test
// below that drives the real command through an actual CLONE (as opposed to
// just registering a URL, or updating an already-cloned submodule) needs
// `AllowFileProtocol::scoped()` for the DURATION of that one call — it sets
// `GIT_ALLOW_PROTOCOL=file` on the current (test) PROCESS, which
// `std::process::Command` inherits by default into the child `git` process
// spawned by `submodule::run_git` (that runner does no env isolation of its
// own, unlike `TempRepo::git`/`FreshClone::git` above).
//
// A plain save/restore-on-Drop guard (as `tests/git_revert.rs`'s `RestoreEnv`
// does for LC_ALL/LANGUAGE) is NOT safe here, and this was caught empirically
// by a genuinely flaky run, not just reasoned about: `cargo test` runs
// `#[test]` fns concurrently on separate THREADS within one process, but
// `std::env::set_var`/`remove_var` mutate that one process's SHARED
// environment table — there is no per-thread copy. With 3 different tests
// below all calling `scoped()`, one test's `Drop` restoring/removing the var
// could fire in the gap between another, still-in-flight test's `set_var`
// and its OWN later child-process spawn, so that second test's `git` child
// launches with the var already stripped back out from under it. (Observed
// directly: `fatal: transport 'file' not allowed` from a test that itself
// calls `scoped()`, on a run where two of these tests happened to overlap.)
// A process-wide `Mutex` closes this: `scoped()` blocks until any other
// in-flight guard has fully set-used-restored and released it, so the
// set/spawn/restore sequence below can never straddle two callers.
static ALLOW_FILE_PROTOCOL_LOCK: Mutex<()> = Mutex::new(());

struct AllowFileProtocol {
    prev: Option<String>,
    _guard: std::sync::MutexGuard<'static, ()>,
}

impl AllowFileProtocol {
    fn scoped() -> Self {
        let guard = ALLOW_FILE_PROTOCOL_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let prev = std::env::var("GIT_ALLOW_PROTOCOL").ok();
        std::env::set_var("GIT_ALLOW_PROTOCOL", "file");
        AllowFileProtocol { prev, _guard: guard }
    }
}

impl Drop for AllowFileProtocol {
    fn drop(&mut self) {
        // Runs BEFORE `_guard` is released (fields drop in declaration order
        // after a manual `drop()` returns), so the var is fully restored
        // while still holding the lock — no other caller can observe the
        // in-between state.
        match &self.prev {
            Some(v) => std::env::set_var("GIT_ALLOW_PROTOCOL", v),
            None => std::env::remove_var("GIT_ALLOW_PROTOCOL"),
        }
    }
}

#[test]
fn submodule_init_registers_url_without_cloning() {
    let child = TempRepo::init("submodule_init_child");
    let _child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_init_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    // A fresh clone: registered in .gitmodules, but genuinely never init'd.
    let clone = FreshClone::of(&parent, "submodule_init");
    let (has_url_before, _, _) = clone.git(&["config", "--get", "submodule.sub.url"]);
    assert!(!has_url_before, "expected no submodule.sub.url in .git/config before init");

    let rows_before = tauri::async_runtime::block_on(submodule_status(clone.path())).expect("submodule_status failed");
    assert_eq!(rows_before.len(), 1);
    assert_eq!(rows_before[0].status, "not-initialized");

    let result = tauri::async_runtime::block_on(submodule_init(clone.path(), "sub".to_string()));
    assert!(result.ok, "submodule_init failed: {}", result.message);
    assert!(result.backup_ref.is_none(), "submodule_init must never snapshot (see module doc comment)");

    // .git/config now has the URL, copied over from .gitmodules...
    let (has_url_after, url_after, _) = clone.git(&["config", "--get", "submodule.sub.url"]);
    assert!(has_url_after, "expected submodule.sub.url to be registered after init");
    assert_eq!(url_after, child.path());

    // ...but the working directory is untouched: init registers, it never clones.
    assert!(
        std::fs::read_dir(PathBuf::from(clone.path()).join("sub")).unwrap().next().is_none(),
        "sub/ should still be an empty directory after init alone"
    );
    let rows_after = tauri::async_runtime::block_on(submodule_status(clone.path())).expect("submodule_status failed");
    assert_eq!(rows_after.len(), 1);
    assert_eq!(
        rows_after[0].status, "not-initialized",
        "init alone must not change the not-initialized classification"
    );
}

#[test]
fn submodule_update_with_init_clones_and_checks_out_never_initialized_submodule() {
    let _allow = AllowFileProtocol::scoped();

    let child = TempRepo::init("submodule_updinit_child");
    let child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_updinit_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    let clone = FreshClone::of(&parent, "submodule_updinit");
    let rows_before = tauri::async_runtime::block_on(submodule_status(clone.path())).expect("submodule_status failed");
    assert_eq!(rows_before[0].status, "not-initialized");

    // init:true folds registration + clone + checkout into this one call —
    // no prior submodule_init needed.
    let result = tauri::async_runtime::block_on(submodule_update(clone.path(), Some("sub".to_string()), false, true));
    assert!(result.ok, "submodule_update failed: {}", result.message);
    assert!(result.backup_ref.is_none(), "submodule_update must never snapshot (see module doc comment)");

    let content = std::fs::read_to_string(PathBuf::from(clone.path()).join("sub").join("f.txt"))
        .expect("read cloned submodule file");
    assert_eq!(content, "hello\n");

    let rows_after = tauri::async_runtime::block_on(submodule_status(clone.path())).expect("submodule_status failed");
    assert_eq!(rows_after.len(), 1);
    let row = &rows_after[0];
    assert_eq!(row.status, "clean", "expected a freshly init+updated submodule to read as clean");
    assert_eq!(row.head_sha.as_deref(), Some(child_c0.as_str()));
    assert_eq!(row.workdir_sha.as_deref(), Some(child_c0.as_str()));
}

#[test]
fn submodule_update_recursive_handles_nested_submodule_of_a_submodule() {
    let _allow = AllowFileProtocol::scoped();

    // grandchild <- (submodule "nested" of) <- mid <- (submodule "sub" of) <- parent
    let grandchild = TempRepo::init("submodule_nested_grandchild");
    let gc0 = grandchild.commit("gc.txt", "grandchild\n", "gc0");

    let mid = TempRepo::init("submodule_nested_mid");
    let _mid0 = mid.commit("mid.txt", "mid\n", "mid0");
    add_submodule(&mid, &grandchild, "nested");

    let parent = TempRepo::init("submodule_nested_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &mid, "sub");

    // A fresh clone: NEITHER "sub" nor "sub/nested" is initialized yet.
    let clone = FreshClone::of(&parent, "submodule_nested");
    assert!(
        std::fs::read_dir(PathBuf::from(clone.path()).join("sub")).unwrap().next().is_none(),
        "sub/ should be empty before update"
    );

    // recursive:true must init+clone+checkout "sub" AND recurse into "sub" to
    // do the same for ITS OWN "nested" submodule, in one call.
    let result = tauri::async_runtime::block_on(submodule_update(clone.path(), Some("sub".to_string()), true, true));
    assert!(result.ok, "submodule_update (recursive) failed: {}", result.message);

    let nested_file = PathBuf::from(clone.path()).join("sub").join("nested").join("gc.txt");
    let content = std::fs::read_to_string(&nested_file).expect("read nested (submodule-of-a-submodule) file");
    assert_eq!(content, "grandchild\n");

    // submodule_status only walks the TOP-LEVEL .gitmodules, so confirm the
    // nested checkout directly via git2 instead of expecting it in that list.
    let nested_repo = git2::Repository::open(PathBuf::from(clone.path()).join("sub").join("nested"))
        .expect("open nested submodule repo");
    let nested_head = nested_repo.head().unwrap().peel_to_commit().unwrap().id().to_string();
    assert_eq!(nested_head, gc0, "nested submodule-of-a-submodule must be checked out at its tracked commit");
}

// Negative control for the test above: proves recursive:true is doing real,
// necessary work rather than being a silent no-op that happens to pass. Same
// 3-level fixture, but recursive:false — "sub" itself must still get cloned
// (init:true covers the one level update() was scoped to), while "sub"'s OWN
// "nested" submodule must stay uninitialized since recursion into it was
// never requested.
#[test]
fn submodule_update_without_recursive_leaves_the_nested_submodule_uninitialized() {
    let _allow = AllowFileProtocol::scoped();

    let grandchild = TempRepo::init("submodule_nonrecursive_grandchild");
    let _gc0 = grandchild.commit("gc.txt", "grandchild\n", "gc0");

    let mid = TempRepo::init("submodule_nonrecursive_mid");
    let _mid0 = mid.commit("mid.txt", "mid\n", "mid0");
    add_submodule(&mid, &grandchild, "nested");

    let parent = TempRepo::init("submodule_nonrecursive_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &mid, "sub");

    let clone = FreshClone::of(&parent, "submodule_nonrecursive");

    let result = tauri::async_runtime::block_on(submodule_update(clone.path(), Some("sub".to_string()), false, true));
    assert!(result.ok, "submodule_update (non-recursive) failed: {}", result.message);

    // "sub" itself was cloned+checked out...
    let mid_file = PathBuf::from(clone.path()).join("sub").join("mid.txt");
    assert_eq!(std::fs::read_to_string(&mid_file).expect("read sub/mid.txt"), "mid\n");

    // ...but its own "nested" submodule was never recursed into, so it's
    // still a genuinely empty, uninitialized directory.
    let nested_dir = PathBuf::from(clone.path()).join("sub").join("nested");
    assert!(
        std::fs::read_dir(&nested_dir).unwrap().next().is_none(),
        "sub/nested/ should remain empty without recursive:true"
    );
}

#[test]
fn submodule_update_refuses_over_dirty_submodule_and_keeps_local_changes() {
    let child = TempRepo::init("submodule_upddirty_child");
    let child_c0 = child.commit("f.txt", "hello\n", "c0");
    let child_c1 = child.commit("f.txt", "hello\nmore\n", "c1");

    let parent = TempRepo::init("submodule_upddirty_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    // add_submodule clones the child's CURRENT head (c1) into "sub" and
    // commits the addition — sub starts out checked out AND tracked at c1.
    let tracked_at_add = add_submodule(&parent, &child, "sub");
    assert_eq!(tracked_at_add, child_c1);

    // Bump the superproject's tracked gitlink BACK to c0 WITHOUT touching
    // sub's own working tree — simulates "you pulled a superproject commit
    // that moved the submodule pointer, but haven't updated yet" (same
    // `update-index --cacheinfo` technique this file's own out-of-date
    // fixture already uses above).
    parent.must(&["update-index", "--cacheinfo", &format!("160000,{child_c0},sub")]);
    parent.must(&["commit", "-q", "-m", "bump submodule pointer back to c0"]);

    let (_, sm_status, _) = parent.git(&["submodule", "status"]);
    assert!(sm_status.starts_with('+'), "expected a '+'-prefixed (out-of-date) submodule status: {sm_status:?}");

    // Dirty the submodule's own working tree, editing the SAME file that
    // differs between c0 and c1 — a checkout to c0 would clobber this edit.
    std::fs::write(parent.dir.join("sub").join("f.txt"), "dirty-local-edit\n").expect("write dirty edit");
    let (_, dirty_status, _) = parent.git(&["status", "--porcelain"]);
    assert!(dirty_status.contains("M sub"), "expected the superproject to see sub as dirty: {dirty_status:?}");

    // EMPIRICALLY VERIFIED (see submodule.rs's module doc comment): real
    // git's own default refuses a checkout that would clobber this edit —
    // submodule_update must surface that refusal, not force past it.
    let result = tauri::async_runtime::block_on(submodule_update(parent.path(), Some("sub".to_string()), false, false));
    assert!(!result.ok, "expected submodule_update to refuse over a dirty submodule, got ok: {}", result.message);
    assert!(
        result.message.contains("overwritten") || result.message.contains("local changes"),
        "expected git's own local-changes refusal message, got: {:?}",
        result.message
    );
    assert!(result.backup_ref.is_none());

    // No data loss: the uncommitted edit is still there, verbatim.
    let content = parent.read("sub/f.txt");
    assert_eq!(content, "dirty-local-edit\n", "the dirty submodule edit must survive a refused update");

    // The submodule's own HEAD must not have moved off c1.
    let (_, sub_head, _) = parent.git(&["-C", "sub", "rev-parse", "HEAD"]);
    assert_eq!(sub_head, child_c1, "a refused update must not move the submodule's own HEAD");
}

#[test]
fn submodule_update_all_updates_multiple_submodules_in_one_call() {
    let _allow = AllowFileProtocol::scoped();

    let child_a = TempRepo::init("submodule_updall_a");
    let a0 = child_a.commit("a.txt", "a\n", "a0");
    let child_b = TempRepo::init("submodule_updall_b");
    let b0 = child_b.commit("b.txt", "b\n", "b0");

    let parent = TempRepo::init("submodule_updall_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child_a, "subA");
    add_submodule(&parent, &child_b, "subB");

    let clone = FreshClone::of(&parent, "submodule_updall");
    let rows_before = tauri::async_runtime::block_on(submodule_status(clone.path())).expect("submodule_status failed");
    assert_eq!(rows_before.len(), 2);
    assert!(rows_before.iter().all(|r| r.status == "not-initialized"));

    // submodule_path: None => update EVERY registered submodule, no path
    // restriction — the bulk "Update all" action.
    let result = tauri::async_runtime::block_on(submodule_update(clone.path(), None, false, true));
    assert!(result.ok, "submodule_update (all) failed: {}", result.message);

    let rows_after = tauri::async_runtime::block_on(submodule_status(clone.path())).expect("submodule_status failed");
    assert_eq!(rows_after.len(), 2);
    for row in &rows_after {
        assert_eq!(row.status, "clean", "expected {} to be clean after update-all", row.path);
    }
    let a = rows_after.iter().find(|r| r.path == "subA").expect("subA row");
    let b = rows_after.iter().find(|r| r.path == "subB").expect("subB row");
    assert_eq!(a.workdir_sha.as_deref(), Some(a0.as_str()));
    assert_eq!(b.workdir_sha.as_deref(), Some(b0.as_str()));
}

// ---------------------------------------------------------------------------
// M3: submodule_add / submodule_sync
// ---------------------------------------------------------------------------
//
// `submodule_add` drives a real clone over `file://`-ish local paths, so
// every test below that calls it needs `AllowFileProtocol::scoped()` for the
// same reason `submodule_update`'s own clone-driving tests above do (see the
// big comment above `AllowFileProtocol` for why it's a process-wide-locked
// guard rather than a plain save/restore).
//
// `submodule_sync` never fetches or clones anything — it only rewrites
// `.git/config` from what's already committed in `.gitmodules` — so none of
// its tests need `AllowFileProtocol`.

#[test]
fn submodule_add_clones_new_submodule_and_it_is_immediately_clean() {
    let _allow = AllowFileProtocol::scoped();

    let child = TempRepo::init("submodule_add_child");
    let child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_add_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");

    let result = tauri::async_runtime::block_on(submodule_add(parent.path(), child.path(), "sub".to_string(), None));
    assert!(result.ok, "submodule_add failed: {}", result.message);
    assert!(result.backup_ref.is_none(), "submodule_add must never snapshot (see module doc comment)");

    // Cloned into the working tree...
    let content =
        std::fs::read_to_string(parent.dir.join("sub").join("f.txt")).expect("read cloned submodule file");
    assert_eq!(content, "hello\n");
    // ...and registered + staged (NOT committed — mirrors real `git submodule
    // add` exactly, matching this module's doc comment).
    let (ok, out, _) = parent.git(&["status", "--porcelain"]);
    assert!(ok);
    assert!(out.contains("A  .gitmodules"), "expected .gitmodules to be staged as added: {out:?}");
    assert!(out.contains("A  sub"), "expected the new gitlink to be staged as added: {out:?}");

    // And it shows up in submodule_status as "clean" immediately — no commit
    // required first. EMPIRICALLY VERIFIED: `head_sha` is `None` at this
    // point (git2's `Submodule::head_id()` reads the gitlink from the HEAD
    // TREE specifically, and `git submodule add` only stages it — nothing is
    // committed yet, so HEAD's tree doesn't have it); `workdir_sha` (read
    // from the actual checked-out submodule) is already populated. Neither
    // bit-derived classification cares about `head_sha` being `None` here —
    // none of `WD_UNINITIALIZED`/`WD_DELETED`/`WD_MODIFIED` fire for a
    // freshly cloned-and-staged submodule — so the row still, correctly,
    // reads "clean".
    let rows = tauri::async_runtime::block_on(submodule_status(parent.path())).expect("submodule_status failed");
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.path, "sub");
    assert_eq!(row.status, "clean", "a freshly added submodule must read as clean right away");
    assert!(row.head_sha.is_none(), "HEAD's tree has no gitlink yet before the addition is committed");
    assert_eq!(row.workdir_sha.as_deref(), Some(child_c0.as_str()));
}

#[test]
fn submodule_add_with_branch_checks_out_that_branch_not_the_default() {
    let _allow = AllowFileProtocol::scoped();

    let child = TempRepo::init("submodule_add_branch_child");
    let _main_c0 = child.commit("f.txt", "main content\n", "main c0");
    child.must(&["checkout", "-q", "-b", "feature"]);
    let feature_c0 = child.commit("f.txt", "feature content\n", "feature c0");
    child.must(&["checkout", "-q", "main"]);

    let parent = TempRepo::init("submodule_add_branch_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");

    let result = tauri::async_runtime::block_on(submodule_add(parent.path(), child.path(), "sub".to_string(), Some("feature".to_string())));
    assert!(result.ok, "submodule_add (with branch) failed: {}", result.message);

    // The submodule's own checked-out branch is "feature", NOT the child
    // repo's default branch ("main") — and its content/HEAD matches feature's
    // commit, not main's.
    let (_, sub_branch, _) = parent.git(&["-C", "sub", "symbolic-ref", "--short", "HEAD"]);
    assert_eq!(sub_branch, "feature", "expected the submodule to have checked out the requested branch");
    let content =
        std::fs::read_to_string(parent.dir.join("sub").join("f.txt")).expect("read cloned submodule file");
    assert_eq!(content, "feature content\n", "expected the feature branch's content, not main's");
    let (_, sub_head, _) = parent.git(&["-C", "sub", "rev-parse", "HEAD"]);
    assert_eq!(sub_head, feature_c0);

    // .gitmodules records the branch too (real git's own behavior).
    let gitmodules = parent.read(".gitmodules");
    assert!(gitmodules.contains("branch = feature"), "expected .gitmodules to record the branch: {gitmodules:?}");
}

#[test]
fn submodule_add_refuses_cleanly_for_a_colliding_path() {
    let _allow = AllowFileProtocol::scoped();

    let child = TempRepo::init("submodule_add_collide_child");
    let _child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_add_collide_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    // A regular tracked file already occupies the path we'll try to add a
    // submodule at.
    let _existing = parent.commit("existing.txt", "not a submodule\n", "add existing file");

    let result = tauri::async_runtime::block_on(submodule_add(parent.path(), child.path(), "existing.txt".to_string(), None));
    assert!(!result.ok, "expected submodule_add to refuse a colliding path, got ok: {}", result.message);
    assert!(result.backup_ref.is_none());
    // EMPIRICALLY VERIFIED (git 2.53, see submodule.rs's module doc comment):
    // real `git submodule add` refuses a tracked-file collision with exactly
    // this message — asserted here rather than a vaguer substring so a
    // regression that silently changes WHICH refusal fires would be caught.
    assert!(
        result.message.contains("already exists in the index"),
        "expected git's own tracked-path collision refusal, got: {:?}",
        result.message
    );

    // Nothing was actually staged/registered by the refused attempt.
    let (ok, out, _) = parent.git(&["status", "--porcelain"]);
    assert!(ok);
    assert!(out.is_empty(), "a refused add must leave the working tree untouched: {out:?}");
    assert!(!parent.dir.join(".gitmodules").exists(), "a refused add must not create .gitmodules");
}

// validate_submodule_path itself has no `..`/absolute-path check (only
// empty/leading-dash/control-chars, per its own doc comment) — this is safe
// in practice ONLY because real `git submodule add` independently refuses a
// path outside the repository on its own, before ever cloning anything
// (EMPIRICALLY VERIFIED, git 2.53: "fatal: '<path>' is outside repository at
// '<repo>'", exit 128, nothing created outside the repo). Pin that safety net
// with a real regression test rather than leaving it implicit.
#[test]
fn submodule_add_refuses_a_path_traversal_target() {
    let _allow = AllowFileProtocol::scoped();

    let child = TempRepo::init("submodule_add_traversal_child");
    let _child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_add_traversal_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");

    let result = tauri::async_runtime::block_on(submodule_add(parent.path(), child.path(), "../../etc/evil".to_string(), None));
    assert!(!result.ok, "expected submodule_add to refuse a path-traversal target, got ok: {}", result.message);
    assert!(result.backup_ref.is_none());
    assert!(
        result.message.contains("outside repository"),
        "expected git's own outside-repository refusal, got: {:?}",
        result.message
    );
    assert!(!parent.dir.join(".gitmodules").exists(), "a refused traversal add must not create .gitmodules");
}

#[test]
fn submodule_sync_rewrites_git_config_url_after_gitmodules_is_hand_edited() {
    let child = TempRepo::init("submodule_sync_child");
    let _child_c0 = child.commit("f.txt", "hello\n", "c0");
    let child_new = TempRepo::init("submodule_sync_child_new");
    let _new_c0 = child_new.commit("g.txt", "new home\n", "c0");

    let parent = TempRepo::init("submodule_sync_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    // .git/config currently agrees with .gitmodules: both point at `child`.
    let (_, url_before, _) = parent.git(&["config", "--get", "submodule.sub.url"]);
    assert_eq!(url_before, child.path(), "expected .git/config to start out pointing at the original child repo");

    // Hand-edit ONLY .gitmodules's url field — mirrors a manual text edit or
    // a merge, never touches .git/config on its own.
    parent.must(&["config", "-f", ".gitmodules", "submodule.sub.url", &child_new.path()]);
    parent.must(&["add", ".gitmodules"]);
    parent.must(&["commit", "-q", "-m", "point sub at a new home"]);

    // Confirm the split BEFORE syncing: .gitmodules moved, .git/config did not.
    let gitmodules = parent.read(".gitmodules");
    assert!(gitmodules.contains(&child_new.path()), "expected .gitmodules to record the new url");
    let (_, url_still_stale, _) = parent.git(&["config", "--get", "submodule.sub.url"]);
    assert_eq!(url_still_stale, child.path(), ".git/config must still be stale before sync runs");

    let result = tauri::async_runtime::block_on(submodule_sync(parent.path(), Some("sub".to_string()), false));
    assert!(result.ok, "submodule_sync failed: {}", result.message);
    assert!(result.backup_ref.is_none(), "submodule_sync must never snapshot (see module doc comment)");

    // Read .git/config directly (not just trusting ok:true) — this is the
    // whole point of the command.
    let (_, url_after, _) = parent.git(&["config", "--get", "submodule.sub.url"]);
    assert_eq!(url_after, child_new.path(), "expected .git/config's url to be rewritten to match .gitmodules");
}

#[test]
fn submodule_sync_with_no_path_syncs_every_registered_submodule_in_one_call() {
    let child_a = TempRepo::init("submodule_syncall_a");
    let _a0 = child_a.commit("a.txt", "a\n", "a0");
    let child_a_new = TempRepo::init("submodule_syncall_a_new");
    let _an0 = child_a_new.commit("a.txt", "a-new\n", "a-new0");

    let child_b = TempRepo::init("submodule_syncall_b");
    let _b0 = child_b.commit("b.txt", "b\n", "b0");
    let child_b_new = TempRepo::init("submodule_syncall_b_new");
    let _bn0 = child_b_new.commit("b.txt", "b-new\n", "b-new0");

    let parent = TempRepo::init("submodule_syncall_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child_a, "subA");
    add_submodule(&parent, &child_b, "subB");

    // Hand-edit BOTH .gitmodules urls to a different home.
    parent.must(&["config", "-f", ".gitmodules", "submodule.subA.url", &child_a_new.path()]);
    parent.must(&["config", "-f", ".gitmodules", "submodule.subB.url", &child_b_new.path()]);
    parent.must(&["add", ".gitmodules"]);
    parent.must(&["commit", "-q", "-m", "repoint both submodules"]);

    // Both are stale in .git/config before sync.
    let (_, a_before, _) = parent.git(&["config", "--get", "submodule.subA.url"]);
    let (_, b_before, _) = parent.git(&["config", "--get", "submodule.subB.url"]);
    assert_eq!(a_before, child_a.path());
    assert_eq!(b_before, child_b.path());

    // submodule_path: None => sync EVERY registered submodule, no path
    // restriction — mirrors submodule_update's own None-means-all convention.
    let result = tauri::async_runtime::block_on(submodule_sync(parent.path(), None, false));
    assert!(result.ok, "submodule_sync (all) failed: {}", result.message);

    let (_, a_after, _) = parent.git(&["config", "--get", "submodule.subA.url"]);
    let (_, b_after, _) = parent.git(&["config", "--get", "submodule.subB.url"]);
    assert_eq!(a_after, child_a_new.path(), "expected subA's .git/config url to be rewritten");
    assert_eq!(b_after, child_b_new.path(), "expected subB's .git/config url to be rewritten");
}

// ---------------------------------------------------------------------------
// M4: submodule_deinit / submodule_remove
// ---------------------------------------------------------------------------
//
// Neither command needs `AllowFileProtocol::scoped()`: `submodule_deinit`
// never clones/fetches anything, and every `submodule_init`/`submodule_update`
// call below is restoring an ALREADY-cloned submodule (its objects already
// sit in `.git/modules/<name>` from the original `add_submodule` helper) —
// EMPIRICALLY VERIFIED (see submodule.rs's M4 doc comment) that this restore
// path triggers zero fetch/clone activity, so no protocol restriction is ever
// hit. This is precisely the offline-recovery property under test.

#[test]
fn submodule_deinit_clears_workdir_and_survives_in_git_modules() {
    let child = TempRepo::init("submodule_deinit_clean_child");
    let _child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_deinit_clean_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    let result = tauri::async_runtime::block_on(submodule_deinit(parent.path(), "sub".to_string(), false));
    assert!(result.ok, "submodule_deinit failed: {}", result.message);
    assert!(result.backup_ref.is_none(), "submodule_deinit must never snapshot");
    assert!(result.backup_patch.is_none(), "a clean deinit must never write a backup");

    // Working tree cleared to an empty directory.
    assert!(
        std::fs::read_dir(parent.dir.join("sub")).unwrap().next().is_none(),
        "sub/ should be an empty directory after deinit"
    );

    // .git/modules/sub survives untouched — the safety property this whole
    // milestone is built around.
    let modules_config = parent.dir.join(".git").join("modules").join("sub").join("config");
    assert!(modules_config.exists(), "expected .git/modules/sub to survive deinit");
    let config_text = std::fs::read_to_string(&modules_config).unwrap();
    assert!(config_text.contains("[remote \"origin\"]"), "expected .git/modules/sub/config to still have its remote");

    let rows = tauri::async_runtime::block_on(submodule_status(parent.path())).expect("submodule_status failed");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, "not-initialized");
}

#[test]
fn submodule_deinit_without_force_refuses_on_dirty_submodule_and_keeps_content() {
    let child = TempRepo::init("submodule_deinit_dirty_child");
    let _child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_deinit_dirty_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    std::fs::write(parent.dir.join("sub").join("f.txt"), "dirty edit\n").expect("write dirty edit");
    std::fs::write(parent.dir.join("sub").join("untracked.txt"), "new file\n").expect("write untracked file");

    let result = tauri::async_runtime::block_on(submodule_deinit(parent.path(), "sub".to_string(), false));
    assert!(!result.ok, "expected submodule_deinit to refuse a dirty submodule without force");
    assert!(
        result.message.contains("local modifications") && result.message.contains("use '-f'"),
        "expected git's own local-modifications refusal, got: {:?}",
        result.message
    );
    assert!(result.backup_patch.is_none(), "a refused, never-attempted deinit must not have backed up anything");

    assert_eq!(parent.read("sub/f.txt"), "dirty edit\n", "the dirty edit must survive a refused deinit");
    assert_eq!(parent.read("sub/untracked.txt"), "new file\n", "the untracked file must survive a refused deinit");

    let rows = tauri::async_runtime::block_on(submodule_status(parent.path())).expect("submodule_status failed");
    assert_eq!(rows[0].status, "dirty");
}

#[test]
fn submodule_deinit_with_force_backs_up_dirty_content_then_clears() {
    let child = TempRepo::init("submodule_deinit_backup_child");
    let _child_c0 = child.commit("f.txt", "hello\n", "c0");
    let _child_c0b = child.commit("g.txt", "g0\n", "c0b");

    let parent = TempRepo::init("submodule_deinit_backup_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    // Staged-but-uncommitted change to f.txt inside sub's own index.
    std::fs::write(parent.dir.join("sub").join("f.txt"), "staged edit\n").expect("write staged edit");
    parent.must(&["-C", "sub", "add", "f.txt"]);
    // Unstaged edit to g.txt (sub's own index still has the committed content).
    std::fs::write(parent.dir.join("sub").join("g.txt"), "unstaged edit\n").expect("write unstaged edit");
    // A genuinely untracked file.
    std::fs::write(parent.dir.join("sub").join("untracked.txt"), "new file\n").expect("write untracked file");

    let result = tauri::async_runtime::block_on(submodule_deinit(parent.path(), "sub".to_string(), true));
    assert!(result.ok, "submodule_deinit (force) failed: {}", result.message);
    let backup_rel = result.backup_patch.clone().expect("expected a backup_patch for a dirty force-deinit");
    assert!(backup_rel.starts_with("gitgui/submodule-backup/"), "unexpected backup path: {backup_rel:?}");

    let backup_dir = parent.dir.join(".git").join(&backup_rel);
    assert!(backup_dir.is_dir(), "expected the backup bundle directory to exist: {backup_dir:?}");
    let staged_patch = backup_dir.join("staged.patch");
    let unstaged_patch = backup_dir.join("unstaged.patch");
    let untracked_file = backup_dir.join("untracked").join("untracked.txt");
    assert!(staged_patch.is_file(), "expected staged.patch to exist");
    assert!(unstaged_patch.is_file(), "expected unstaged.patch to exist");
    assert!(untracked_file.is_file(), "expected untracked/untracked.txt to exist");
    assert_eq!(std::fs::read_to_string(&untracked_file).unwrap(), "new file\n");

    // Working tree genuinely cleared.
    assert!(
        std::fs::read_dir(parent.dir.join("sub")).unwrap().next().is_none(),
        "sub/ should be an empty directory after force deinit"
    );

    // GENUINE RECOVERY (not just "the file exists"): re-init + update restores
    // sub to its tracked commit (nothing above was ever committed, so this is
    // still c0b's content), then applying BOTH backed-up patches must bring
    // back the exact discarded content, byte for byte.
    let init_result = tauri::async_runtime::block_on(submodule_init(parent.path(), "sub".to_string()));
    assert!(init_result.ok, "submodule_init failed: {}", init_result.message);
    let update_result = tauri::async_runtime::block_on(submodule_update(parent.path(), Some("sub".to_string()), false, false));
    assert!(update_result.ok, "submodule_update failed: {}", update_result.message);
    assert_eq!(parent.read("sub/f.txt"), "hello\n", "restored checkout should be back at HEAD's content");
    assert_eq!(parent.read("sub/g.txt"), "g0\n", "restored checkout should be back at HEAD's content");

    parent.must(&["-C", "sub", "apply", staged_patch.to_str().unwrap()]);
    assert_eq!(
        parent.read("sub/f.txt"),
        "staged edit\n",
        "the staged.patch backup must restore the exact discarded staged content"
    );

    parent.must(&["-C", "sub", "apply", unstaged_patch.to_str().unwrap()]);
    assert_eq!(
        parent.read("sub/g.txt"),
        "unstaged edit\n",
        "the unstaged.patch backup must restore the exact discarded unstaged content"
    );

    std::fs::copy(&untracked_file, parent.dir.join("sub").join("untracked.txt")).expect("restore untracked file");
    assert_eq!(parent.read("sub/untracked.txt"), "new file\n");
}

#[test]
fn submodule_deinit_with_force_on_a_clean_submodule_skips_backup() {
    let child = TempRepo::init("submodule_deinit_force_clean_child");
    let _child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_deinit_force_clean_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    let result = tauri::async_runtime::block_on(submodule_deinit(parent.path(), "sub".to_string(), true));
    assert!(result.ok, "submodule_deinit (force, clean) failed: {}", result.message);
    assert!(result.backup_patch.is_none(), "a clean submodule must not get a backup even under force");

    let backup_root = parent.dir.join(".git").join("gitgui").join("submodule-backup");
    assert!(
        !backup_root.exists() || std::fs::read_dir(&backup_root).unwrap().next().is_none(),
        "no submodule-backup directory should have been created for a clean force-deinit"
    );

    assert!(std::fs::read_dir(parent.dir.join("sub")).unwrap().next().is_none());
}

#[test]
fn submodule_deinit_recovers_offline_via_init_and_update() {
    let child = TempRepo::init("submodule_deinit_offline_child");
    let _child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_deinit_offline_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    let result = tauri::async_runtime::block_on(submodule_deinit(parent.path(), "sub".to_string(), false));
    assert!(result.ok, "submodule_deinit failed: {}", result.message);

    assert!(
        parent.dir.join(".git").join("modules").join("sub").join("config").exists(),
        "expected .git/modules/sub to survive deinit"
    );

    // Simulate the original source repo becoming permanently unreachable
    // (moved/deleted) — the offline-recovery property must not depend on it.
    let moved_away = child.dir.with_file_name("submodule_deinit_offline_child_GONE");
    std::fs::rename(&child.dir, &moved_away).expect("simulate the origin going away");

    // init re-registers the (now-unreachable) url from .gitmodules — this
    // never dereferences the url, so it succeeds regardless.
    let init_result = tauri::async_runtime::block_on(submodule_init(parent.path(), "sub".to_string()));
    assert!(init_result.ok, "submodule_init failed: {}", init_result.message);

    // update restores the checkout straight from .git/modules/sub — ZERO
    // network/file access to the (now-gone) original source.
    let update_result = tauri::async_runtime::block_on(submodule_update(parent.path(), Some("sub".to_string()), false, false));
    assert!(update_result.ok, "submodule_update failed (offline recovery): {}", update_result.message);

    assert_eq!(
        parent.read("sub/f.txt"),
        "hello\n",
        "expected the submodule's content to be restored from .git/modules, fully offline"
    );

    let _ = std::fs::remove_dir_all(&moved_away);
}

#[test]
fn submodule_deinit_is_idempotent_on_an_already_deinited_submodule() {
    let child = TempRepo::init("submodule_deinit_idempotent_child");
    let _child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_deinit_idempotent_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    let first = tauri::async_runtime::block_on(submodule_deinit(parent.path(), "sub".to_string(), false));
    assert!(first.ok, "first deinit failed: {}", first.message);

    let second = tauri::async_runtime::block_on(submodule_deinit(parent.path(), "sub".to_string(), false));
    assert!(second.ok, "second (repeat) deinit must also succeed (idempotent no-op): {}", second.message);
}

#[test]
fn submodule_deinit_on_conflicted_gitlink_refuses_without_force_even_with_clean_own_tree() {
    let child = TempRepo::init("submodule_deinit_conflict_child");
    let _c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_deinit_conflict_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub"); // locks the tracked gitlink to c0.

    let c1 = child.commit("f.txt", "hello\nmore\n", "c1");
    let c2 = child.commit("f.txt", "hello\nother\n", "c2");

    parent.must(&["branch", "feature"]);
    parent.must(&["update-index", "--cacheinfo", &format!("160000,{c1},sub")]);
    parent.must(&["commit", "-q", "-m", "main -> c1"]);

    parent.must(&["checkout", "-q", "feature"]);
    parent.must(&["update-index", "--cacheinfo", &format!("160000,{c2},sub")]);
    parent.must(&["commit", "-q", "-m", "feature -> c2"]);

    parent.must(&["checkout", "-q", "main"]);
    let (ok, so, _se) = parent.git(&["merge", "-q", "feature"]);
    assert!(!ok, "expected the submodule gitlink merge to conflict");
    assert!(so.contains("CONFLICT"), "expected a real submodule conflict, got: {so:?}");

    // sub's OWN working tree is untouched/clean by this merge — the conflict
    // lives entirely in the superproject's index.
    let (sub_ok, sub_status, _) = parent.git(&["-C", "sub", "status", "--porcelain"]);
    assert!(sub_ok && sub_status.is_empty(), "expected the submodule's own tree to be clean: {sub_status:?}");

    let result = tauri::async_runtime::block_on(submodule_deinit(parent.path(), "sub".to_string(), false));
    assert!(!result.ok, "expected deinit to refuse on a conflicted gitlink even without force");
    assert!(
        result.message.contains("local modifications") && result.message.contains("use '-f'"),
        "expected git's own local-modifications refusal, got: {:?}",
        result.message
    );
    assert!(result.backup_patch.is_none());
}

#[test]
fn submodule_remove_leaves_clean_staged_status_with_no_stray_directory() {
    let child = TempRepo::init("submodule_remove_clean_child");
    let _child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_remove_clean_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    let head_before = parent.rev("HEAD");

    let result = tauri::async_runtime::block_on(submodule_remove(parent.path(), "sub".to_string()));
    assert!(result.ok, "submodule_remove failed: {}", result.message);
    assert!(result.backup_patch.is_none(), "a clean submodule must not get a backup on remove");
    assert!(result.backup_ref.is_none());

    let (ok, status, _) = parent.git(&["status", "--porcelain"]);
    assert!(ok);
    let lines: Vec<&str> = status.lines().collect();
    assert_eq!(lines.len(), 2, "expected exactly 2 status lines, got: {status:?}");
    assert!(lines.contains(&"M  .gitmodules"), "expected .gitmodules to be staged as modified: {status:?}");
    assert!(lines.contains(&"D  sub"), "expected sub's gitlink to be staged as deleted: {status:?}");

    assert!(!parent.dir.join("sub").exists(), "expected no stray sub/ directory left on disk");
    assert!(
        parent.dir.join(".git").join("modules").join("sub").join("config").exists(),
        "expected .git/modules/sub to survive remove"
    );

    assert_eq!(parent.rev("HEAD"), head_before, "submodule_remove must never auto-commit");
}

#[test]
fn submodule_remove_backs_up_dirty_content_before_removing() {
    let child = TempRepo::init("submodule_remove_dirty_child");
    let _child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_remove_dirty_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    std::fs::write(parent.dir.join("sub").join("f.txt"), "dirty edit\n").expect("write dirty edit");
    std::fs::write(parent.dir.join("sub").join("untracked.txt"), "new file\n").expect("write untracked file");

    let result = tauri::async_runtime::block_on(submodule_remove(parent.path(), "sub".to_string()));
    assert!(result.ok, "submodule_remove (dirty) failed: {}", result.message);
    let backup_rel = result.backup_patch.clone().expect("expected a backup_patch for a dirty remove");

    let backup_dir = parent.dir.join(".git").join(&backup_rel);
    assert!(backup_dir.is_dir(), "expected the backup bundle directory to exist: {backup_dir:?}");
    let unstaged_patch = backup_dir.join("unstaged.patch");
    let untracked_file = backup_dir.join("untracked").join("untracked.txt");
    assert!(unstaged_patch.is_file(), "expected unstaged.patch (f.txt's unstaged edit)");
    assert!(untracked_file.is_file(), "expected untracked/untracked.txt");
    assert_eq!(std::fs::read_to_string(&untracked_file).unwrap(), "new file\n");
    let patch_text = std::fs::read_to_string(&unstaged_patch).unwrap();
    assert!(
        patch_text.contains("-hello") && patch_text.contains("+dirty edit"),
        "unexpected patch content: {patch_text:?}"
    );

    let (ok, status, _) = parent.git(&["status", "--porcelain"]);
    assert!(ok);
    assert!(status.lines().any(|l| l == "M  .gitmodules"));
    assert!(status.lines().any(|l| l == "D  sub"));
    assert!(!parent.dir.join("sub").exists());
    assert!(parent.dir.join(".git").join("modules").join("sub").join("config").exists());
}

#[test]
fn submodule_remove_strips_only_the_matching_gitmodules_section_with_multiple_submodules() {
    let child_a = TempRepo::init("submodule_remove_multi_a");
    let _a0 = child_a.commit("a.txt", "a\n", "a0");
    let child_b = TempRepo::init("submodule_remove_multi_b");
    let _b0 = child_b.commit("b.txt", "b\n", "b0");

    let parent = TempRepo::init("submodule_remove_multi_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child_a, "subA");
    add_submodule(&parent, &child_b, "subB");

    let result = tauri::async_runtime::block_on(submodule_remove(parent.path(), "subA".to_string()));
    assert!(result.ok, "submodule_remove failed: {}", result.message);

    let gitmodules = parent.read(".gitmodules");
    assert!(!gitmodules.contains("subA"), "expected subA's section to be gone: {gitmodules:?}");
    assert!(gitmodules.contains("subB"), "expected subB's section to survive verbatim: {gitmodules:?}");

    // subB untouched: still registered + still checked out.
    let (_, url, _) = parent.git(&["config", "--get", "submodule.subB.url"]);
    assert_eq!(url, child_b.path());
    assert_eq!(parent.read("subB/b.txt"), "b\n");
}

#[test]
fn submodule_remove_handles_a_registered_name_different_from_its_path() {
    let child = TempRepo::init("submodule_remove_name_child");
    let _child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_remove_name_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    // submodule_add has no `name` param, so drive the real CLI directly, same
    // as this file's own precedent for reproducing exact real-world shapes.
    parent.must(&[
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        "--name",
        "customname",
        &child.path(),
        "sub",
    ]);
    parent.must(&["commit", "-q", "-m", "add submodule with custom name"]);

    let gitmodules_before = parent.read(".gitmodules");
    assert!(gitmodules_before.contains("[submodule \"customname\"]"), "unexpected .gitmodules: {gitmodules_before:?}");

    let result = tauri::async_runtime::block_on(submodule_remove(parent.path(), "sub".to_string()));
    assert!(result.ok, "submodule_remove failed: {}", result.message);

    let gitmodules_after = parent.read(".gitmodules");
    assert!(
        !gitmodules_after.contains("customname"),
        "expected the custom-named section to be gone: {gitmodules_after:?}"
    );

    assert!(
        parent.dir.join(".git").join("modules").join("customname").join("config").exists(),
        "expected .git/modules/customname (keyed by NAME, not path) to survive remove"
    );
}

#[test]
fn submodule_remove_on_conflicted_gitlink_resolves_that_one_conflict() {
    let child = TempRepo::init("submodule_remove_conflict_child");
    let _c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_remove_conflict_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    let c1 = child.commit("f.txt", "hello\nmore\n", "c1");
    let c2 = child.commit("f.txt", "hello\nother\n", "c2");

    parent.must(&["branch", "feature"]);
    parent.must(&["update-index", "--cacheinfo", &format!("160000,{c1},sub")]);
    parent.must(&["commit", "-q", "-m", "main -> c1"]);

    parent.must(&["checkout", "-q", "feature"]);
    parent.must(&["update-index", "--cacheinfo", &format!("160000,{c2},sub")]);
    parent.must(&["commit", "-q", "-m", "feature -> c2"]);

    parent.must(&["checkout", "-q", "main"]);
    let (ok, so, _se) = parent.git(&["merge", "-q", "feature"]);
    assert!(!ok, "expected the submodule gitlink merge to conflict");
    assert!(so.contains("CONFLICT"), "expected a real submodule conflict, got: {so:?}");
    assert!(parent.open().index().unwrap().has_conflicts(), "expected the index to carry the unresolved gitlink");

    let result = tauri::async_runtime::block_on(submodule_remove(parent.path(), "sub".to_string()));
    assert!(result.ok, "submodule_remove should resolve the conflicted gitlink: {}", result.message);

    assert!(
        !parent.open().index().unwrap().has_conflicts(),
        "expected the gitlink conflict to be resolved by the removal"
    );
    let (_, unmerged, _) = parent.git(&["ls-files", "-u"]);
    assert!(unmerged.is_empty(), "expected no unmerged stages left for sub: {unmerged:?}");

    // The superproject is still mid-merge (the merge commit itself hasn't
    // been made yet) — matches real git's own "All conflicts fixed but you
    // are still merging" state after the same manual sequence (see this
    // section's doc comment).
    assert_eq!(parent.open().state(), git2::RepositoryState::Merge);
}

#[test]
fn submodule_remove_never_snapshots() {
    let child = TempRepo::init("submodule_remove_snapshot_child");
    let _child_c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_remove_snapshot_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    let result = tauri::async_runtime::block_on(submodule_remove(parent.path(), "sub".to_string()));
    assert!(result.ok, "submodule_remove failed: {}", result.message);
    assert!(result.backup_ref.is_none(), "submodule_remove must never take a Safety-Manager ref snapshot");
}

#[test]
fn submodule_deinit_and_remove_reject_flag_like_or_control_char_paths() {
    let parent = TempRepo::init("submodule_deinit_remove_validate_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");

    let deinit_flag = tauri::async_runtime::block_on(submodule_deinit(parent.path(), "--force".to_string(), false));
    assert!(!deinit_flag.ok, "expected a flag-like path to be rejected");
    assert!(deinit_flag.backup_patch.is_none());

    let deinit_control = tauri::async_runtime::block_on(submodule_deinit(parent.path(), "sub\u{7}".to_string(), true));
    assert!(!deinit_control.ok, "expected a control-char path to be rejected");
    assert!(deinit_control.backup_patch.is_none());

    let remove_flag = tauri::async_runtime::block_on(submodule_remove(parent.path(), "-x".to_string()));
    assert!(!remove_flag.ok, "expected a flag-like path to be rejected");
    assert!(remove_flag.backup_patch.is_none());

    let remove_control = tauri::async_runtime::block_on(submodule_remove(parent.path(), "sub\ncontrol".to_string()));
    assert!(!remove_control.ok, "expected a control-char path to be rejected");
    assert!(remove_control.backup_patch.is_none());
}

// ---------------------------------------------------------------------------
// Regression tests: 6 real bugs found by adversarial review of M4
// (deinit/remove), fixed in submodule.rs. Each test below reproduces the
// ORIGINAL bug (verified empirically against the pre-fix code before the fix
// was written) and would fail without its corresponding fix.
// ---------------------------------------------------------------------------

#[test]
fn bug1_force_deinit_refuses_when_submodule_repo_unreadable_but_workdir_has_content() {
    // BUG 1: `open_submodule_repo` returning `None` on ANY error from
    // `Submodule::open()` (not just "genuinely not checked out") used to be
    // treated by `backup_submodule_dirty_content` as "nothing to lose",
    // letting force-deinit/remove proceed straight to wiping real content
    // with NO backup. EMPIRICALLY VERIFIED (throwaway fixture, during the fix)
    // that a submodule's own `.git` gitfile pointer being corrupted/unreadable
    // produces the exact same error SHAPE `Submodule::open()` gives for a
    // genuinely-never-checked-out submodule — so the fix falls back to a
    // direct filesystem check instead of trusting the error alone. Reproduces
    // the dangerous case: corrupt the submodule's own `.git` pointer while
    // real, uncommitted content still sits in its working tree.
    let child = TempRepo::init("submodule_bug1_child");
    let _c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_bug1_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    // Real, uncommitted work sitting in the submodule's own working tree —
    // this is exactly what must NOT be silently discarded.
    std::fs::write(parent.dir.join("sub").join("f.txt"), "important uncommitted work\n")
        .expect("write uncommitted edit");

    // Corrupt the submodule's OWN .git gitfile pointer — EMPIRICALLY VERIFIED
    // (see submodule.rs's `open_submodule_repo` doc comment) this makes
    // `Submodule::open()` fail while the real file above remains untouched.
    std::fs::write(parent.dir.join("sub").join(".git"), "garbage not a gitfile\n")
        .expect("corrupt the submodule's own .git pointer");

    let result = tauri::async_runtime::block_on(submodule_deinit(parent.path(), "sub".to_string(), true));
    assert!(
        !result.ok,
        "expected force-deinit to REFUSE when the submodule's own repo can't be opened but its workdir has \
         real content, got ok: {}",
        result.message
    );
    assert!(result.backup_patch.is_none(), "a refused deinit must never claim to have backed anything up");

    // The uncommitted content must survive untouched — no wipe, no backup.
    assert_eq!(
        parent.read("sub/f.txt"),
        "important uncommitted work\n",
        "the uncommitted edit must survive when the operation correctly refuses"
    );
}

#[test]
fn bug1_force_deinit_still_proceeds_when_the_unreadable_submodule_dir_is_genuinely_empty() {
    // Negative control for Bug 1's fix: an empty/nonexistent directory really
    // is nothing to lose, even if `Submodule::open()` also fails for it (the
    // ordinary never-checked-out case) — the fallback filesystem check must
    // not turn EVERY open() failure into a refusal, only ones where real
    // content is actually at risk.
    let child = TempRepo::init("submodule_bug1_neg_child");
    let _c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_bug1_neg_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    let clone = FreshClone::of(&parent, "submodule_bug1_neg");
    assert!(std::fs::read_dir(PathBuf::from(clone.path()).join("sub")).unwrap().next().is_none());

    let result = tauri::async_runtime::block_on(submodule_deinit(clone.path(), "sub".to_string(), true));
    assert!(result.ok, "a genuinely empty/never-checked-out submodule must not be refused: {}", result.message);
    assert!(result.backup_patch.is_none(), "nothing to back up for a never-checked-out submodule");
}

#[test]
fn bug2_force_deinit_refuses_when_a_nested_submodule_of_a_submodule_is_dirty() {
    // BUG 2: a submodule-of-a-submodule's own dirty content was never even
    // looked at by `backup_submodule_dirty_content` — only the TARGET
    // submodule's own top-level tracked/staged/untracked state was inspected,
    // so a nested submodule registered INSIDE it was treated as an opaque
    // gitlink and silently wiped by `git submodule deinit -f` (which has NO
    // `--recursive` flag at all — verified in the design phase). Reproduces:
    // grandchild <- (submodule "nested" of) <- mid <- (submodule "sub" of) <-
    // parent, with "sub" itself perfectly clean but its OWN "nested"
    // submodule dirty.
    let _allow = AllowFileProtocol::scoped();

    let grandchild = TempRepo::init("submodule_bug2_grandchild");
    let _gc0 = grandchild.commit("gc.txt", "grandchild\n", "gc0");

    let mid = TempRepo::init("submodule_bug2_mid");
    let _mid0 = mid.commit("mid.txt", "mid\n", "mid0");
    add_submodule(&mid, &grandchild, "nested");

    let parent = TempRepo::init("submodule_bug2_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &mid, "sub");

    // "sub" is cloned+checked out by add_submodule, but its OWN "nested"
    // submodule is NOT (`git submodule add` never recurses) — init+update it
    // recursively first so there's something real to dirty.
    let update_result = tauri::async_runtime::block_on(submodule_update(parent.path(), Some("sub".to_string()), true, true));
    assert!(update_result.ok, "recursive submodule_update failed: {}", update_result.message);
    assert_eq!(parent.read("sub/nested/gc.txt"), "grandchild\n");

    // "sub" itself is perfectly clean — only its OWN nested "nested"
    // submodule carries an uncommitted edit.
    std::fs::write(parent.dir.join("sub").join("nested").join("gc.txt"), "important nested uncommitted work\n")
        .expect("write nested submodule's own uncommitted edit");

    let result = tauri::async_runtime::block_on(submodule_deinit(parent.path(), "sub".to_string(), true));
    assert!(
        !result.ok,
        "expected force-deinit of 'sub' to REFUSE because its OWN nested submodule 'nested' is dirty, got ok: {}",
        result.message
    );
    assert!(
        result.message.contains("nested"),
        "expected the refusal to name the dirty nested submodule: {:?}",
        result.message
    );
    assert!(result.backup_patch.is_none());

    // Nothing touched: the nested submodule's content must survive untouched,
    // and "sub" itself must still be fully checked out (deinit never ran).
    assert_eq!(parent.read("sub/nested/gc.txt"), "important nested uncommitted work\n");
    assert!(parent.dir.join("sub").join("mid.txt").exists());
}

#[test]
fn bug2_remove_refuses_when_a_nested_submodule_of_a_submodule_is_dirty() {
    // Same reproduction as above, but through submodule_remove — it calls the
    // identical `backup_submodule_dirty_content` internally and must get the
    // same protection.
    let _allow = AllowFileProtocol::scoped();

    let grandchild = TempRepo::init("submodule_bug2b_grandchild");
    let _gc0 = grandchild.commit("gc.txt", "grandchild\n", "gc0");

    let mid = TempRepo::init("submodule_bug2b_mid");
    let _mid0 = mid.commit("mid.txt", "mid\n", "mid0");
    add_submodule(&mid, &grandchild, "nested");

    let parent = TempRepo::init("submodule_bug2b_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &mid, "sub");

    let update_result = tauri::async_runtime::block_on(submodule_update(parent.path(), Some("sub".to_string()), true, true));
    assert!(update_result.ok, "recursive submodule_update failed: {}", update_result.message);

    std::fs::write(parent.dir.join("sub").join("nested").join("gc.txt"), "important nested uncommitted work\n")
        .expect("write nested submodule's own uncommitted edit");

    // Captured BEFORE the call: dirtying "nested" already makes the
    // superproject itself see "sub" as modified (its own workdir differs
    // because of what's nested inside it) — that's pre-existing state, not
    // something submodule_remove is expected to change either way.
    let (_, status_before, _) = parent.git(&["status", "--porcelain"]);

    let result = tauri::async_runtime::block_on(submodule_remove(parent.path(), "sub".to_string()));
    assert!(!result.ok, "expected submodule_remove to REFUSE because sub's own nested submodule is dirty");
    assert!(result.message.contains("nested"), "expected the refusal to name the dirty nested submodule: {:?}", result.message);
    assert!(result.backup_patch.is_none());

    // "sub" must still be fully present — remove never even reached deinit/rm.
    assert!(parent.dir.join("sub").join("mid.txt").exists());
    let (_, status_after, _) = parent.git(&["status", "--porcelain"]);
    assert_eq!(
        status_after, status_before,
        "a refused remove must leave the superproject's own status exactly as it was: {status_after:?}"
    );
    assert!(!status_after.contains("D  sub"), "sub's gitlink must not have been staged for deletion: {status_after:?}");
}

#[test]
fn bug3_remove_propagates_a_failed_gitmodules_fallback_instead_of_reporting_ok() {
    // BUG 3: the `.gitmodules` section-removal fallback (for when `git rm -f`
    // itself doesn't auto-strip the section) used `if let Ok`/`let _ =` for
    // BOTH `git config --remove-section` and the follow-up `git add --
    // .gitmodules`, and `submodule_remove` never checked whether the fallback
    // actually succeeded before returning ok:true. Reproduces a REAL failure
    // of the fallback (not hypothetical): chmod the repo ROOT directory
    // read-only and register the submodule at a NESTED path ("vendor/sub") —
    // EMPIRICALLY VERIFIED this lets `git rm -f` still succeed at removing
    // the nested working-tree directory and staging `D vendor/sub` (that only
    // needs write access to "vendor/", untouched), while its own attempt to
    // rewrite `.gitmodules` (which lives directly in repo root) fails with
    // "could not lock config file .gitmodules" — leaving the section behind,
    // unstaged.
    let child = TempRepo::init("submodule_bug3_child");
    let _c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_bug3_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "vendor/sub");

    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(&parent.dir).unwrap().permissions();
    perms.set_mode(0o555);
    std::fs::set_permissions(&parent.dir, perms).expect("chmod repo root read-only");

    let result = tauri::async_runtime::block_on(submodule_remove(parent.path(), "vendor/sub".to_string()));

    // Restore perms UNCONDITIONALLY (before any assertion) so TempRepo's own
    // Drop cleanup can still remove the dir even if an assertion below panics.
    let mut perms2 = std::fs::metadata(&parent.dir).unwrap().permissions();
    perms2.set_mode(0o755);
    std::fs::set_permissions(&parent.dir, perms2).expect("restore repo root perms");

    assert!(
        !result.ok,
        "expected submodule_remove to report failure when it can't strip+stage .gitmodules's section, got ok: {}",
        result.message
    );

    let gitmodules = parent.read(".gitmodules");
    assert!(gitmodules.contains("vendor/sub"), "expected the stale section to still be present: {gitmodules:?}");

    let (_, status, _) = parent.git(&["status", "--porcelain"]);
    assert!(status.contains("D  vendor/sub"), "expected the gitlink deletion to still be staged: {status:?}");
    assert!(
        !status.contains("M  .gitmodules"),
        ".gitmodules was never actually staged by the failed fallback, so it must not show as modified: {status:?}"
    );
}

#[test]
fn bug4_force_deinit_backs_up_a_dangling_symlinks_target_instead_of_refusing() {
    // BUG 4: the untracked-file backup loop called `fs::read(&src)`, which
    // FOLLOWS a symlink and errors on a dangling one — a stray broken symlink
    // (its target since deleted) shouldn't be able to block an otherwise-safe
    // force-deinit. Reproduces: an untracked symlink inside the submodule's
    // own working tree pointing at a target that doesn't exist.
    let child = TempRepo::init("submodule_bug4_child");
    let _c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_bug4_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    std::os::unix::fs::symlink("this-target-does-not-exist", parent.dir.join("sub").join("dangling-link"))
        .expect("create a dangling symlink inside the submodule");

    let result = tauri::async_runtime::block_on(submodule_deinit(parent.path(), "sub".to_string(), true));
    assert!(
        result.ok,
        "expected a dangling symlink to NOT block an otherwise-safe force-deinit, got: {}",
        result.message
    );
    let backup_rel =
        result.backup_patch.clone().expect("expected a backup_patch (the dangling link counts as untracked content)");

    let backup_dir = parent.dir.join(".git").join(&backup_rel);
    let backed_up = backup_dir.join("untracked").join("dangling-link");
    assert!(backed_up.is_file(), "expected the symlink's TARGET PATH to be recorded as a plain backup file");
    let recorded_target = std::fs::read_to_string(&backed_up).expect("read the recorded symlink target");
    assert_eq!(
        recorded_target, "this-target-does-not-exist",
        "expected the backup to record where the dangling link pointed"
    );

    assert!(
        std::fs::read_dir(parent.dir.join("sub")).unwrap().next().is_none(),
        "sub/ should be cleared to empty after a successful force-deinit"
    );
}

#[test]
fn bug5_force_deinit_backs_up_gitignored_files_that_deinit_f_actually_wipes() {
    // BUG 5 (the most serious gap: real data loss with zero trace): the
    // untracked-file backup scan didn't include ignored files, but `git
    // submodule deinit -f` clears them too — EMPIRICALLY CONFIRMED separately
    // that a .gitignore'd file inside a submodule vanishes on `deinit -f` with
    // NO backup at all before this fix. Reproduces the full round trip:
    // create a gitignored file with real content inside the submodule,
    // force-deinit, and confirm BOTH (a) the file is actually gone from the
    // working tree (proving `deinit -f` really does wipe it, so this isn't a
    // no-op test) AND (b) its content is fully recoverable from the backup
    // afterward.
    let child = TempRepo::init("submodule_bug5_child");
    let _c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_bug5_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    // A .gitignore'd file INSIDE the submodule (its own .gitignore, not the
    // superproject's) with real, important content.
    std::fs::write(parent.dir.join("sub").join(".gitignore"), "ignored-secret.env\n")
        .expect("write submodule .gitignore");
    std::fs::write(parent.dir.join("sub").join("ignored-secret.env"), "API_KEY=super-important-value\n")
        .expect("write the gitignored file");

    // Sanity: confirm it really IS ignored from the submodule's own
    // perspective before relying on that.
    let (_, sub_status, _) = parent.git(&["-C", "sub", "status", "--porcelain", "--ignored"]);
    assert!(sub_status.contains("ignored-secret.env"), "expected the file to show up as ignored: {sub_status:?}");

    let result = tauri::async_runtime::block_on(submodule_deinit(parent.path(), "sub".to_string(), true));
    assert!(result.ok, "submodule_deinit (force) failed: {}", result.message);
    let backup_rel = result
        .backup_patch
        .clone()
        .expect("expected a backup_patch — the ignored file counts as dirty content to preserve");

    // Confirm deinit -f REALLY DID wipe it (not a no-op assertion): the
    // submodule's working tree is cleared to empty, including .gitignore
    // itself and the file it ignored.
    assert!(
        std::fs::read_dir(parent.dir.join("sub")).unwrap().next().is_none(),
        "sub/ should be cleared to empty, including its own .gitignore and the file it ignored"
    );

    // And its content IS recoverable from the backup.
    let backup_dir = parent.dir.join(".git").join(&backup_rel);
    let backed_up_file = backup_dir.join("untracked").join("ignored-secret.env");
    assert!(backed_up_file.is_file(), "expected the gitignored file's content to be backed up");
    assert_eq!(
        std::fs::read_to_string(&backed_up_file).unwrap(),
        "API_KEY=super-important-value\n",
        "expected the exact gitignored content to be recoverable from the backup"
    );
    // The submodule's own .gitignore is itself untracked-but-not-ignored (it's
    // the file that DOES the ignoring) — also backed up, same as any other
    // untracked file.
    let backed_up_gitignore = backup_dir.join("untracked").join(".gitignore");
    assert!(backed_up_gitignore.is_file(), "expected the submodule's own untracked .gitignore to be backed up too");
}

#[test]
fn bug6_submodule_status_reports_removed_not_clean_after_submodule_remove_stages_deletion() {
    // BUG 6: `classify_status` only checked `SubmoduleStatus`'s WD_* bits,
    // never INDEX_DELETED — so right after `submodule_remove` STAGES its
    // removal (nothing committed yet), `submodule_status` kept reporting the
    // row as an ordinary "clean" one (a ghost row), even though there is
    // nothing left to act on and re-clicking Deinit/Remove on it would
    // produce a confusing error.
    let child = TempRepo::init("submodule_bug6_child");
    let _c0 = child.commit("f.txt", "hello\n", "c0");

    let parent = TempRepo::init("submodule_bug6_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &child, "sub");

    let remove_result = tauri::async_runtime::block_on(submodule_remove(parent.path(), "sub".to_string()));
    assert!(remove_result.ok, "submodule_remove failed: {}", remove_result.message);

    let rows = tauri::async_runtime::block_on(submodule_status(parent.path())).expect("submodule_status failed");
    assert_eq!(
        rows.len(),
        1,
        "the row should still show up: HEAD's own committed .gitmodules is unchanged (nothing committed yet)"
    );
    let row = &rows[0];
    assert_eq!(row.status, "removed", "expected the new 'removed' classification, not a stale 'clean'");
    assert_ne!(row.status, "clean", "a staged-for-removal submodule must never read as an ordinary clean row");
}

// ---------------------------------------------------------------------------
// CRASH FIX regression: `submodule_status_inner` unconditionally called
// `repo.submodule_status(name, ..)` for every top-level submodule, with no
// cycle check of its own. That call itself stack-overflows the whole process
// (a real, reproduced crash, not just an `Err`) when asked about a submodule
// whose own resolved git directory — or ANYTHING reachable in its own
// nested-submodule subtree, at any depth — is cyclic (a malformed or
// maliciously crafted `.git` gitfile pointer that redirects back at an
// ancestor already being walked), and, more surprisingly, the identical
// crash fires for any ANCESTOR of the cyclic node too. `submodule_status`
// runs automatically on every repo-open (the sidebar's own
// `refreshSubmodules()`), so simply OPENING a repository containing a
// malformed/hostile submodule crashed the entire app — no opt-in action
// required. Fixed by `check_submodule_safe_for_status` (src/submodule.rs),
// which uses the canonicalize-and-track-visited-paths mechanism
// (`check_safe_to_recurse`/`discover_nested_targets`) to verify a
// submodule's entire reachable subtree is cycle-free BEFORE ever calling
// `submodule_status` on it, reporting a new "unreadable" classification
// instead of crashing (and instead of ever guessing "clean").
// ---------------------------------------------------------------------------

#[test]
fn submodule_status_on_cyclic_nested_submodule_terminates_cleanly_instead_of_crashing() {
    let _allow = AllowFileProtocol::scoped();

    // Identical malformed fixture to
    // `cyclic_nested_submodule_reference_terminates_cleanly_instead_of_crashing`
    // above (grandchild <- (submodule "nested" of) <- mid <- (submodule "sub"
    // of) <- parent, "sub/nested"'s own `.git` gitfile hand-corrupted to
    // redirect back at "sub"'s own containing git directory) — but this test
    // drives `submodule_status` DIRECTLY, never `submodule_foreach_run`, to
    // confirm the crash is independently fixed on this call path too, not
    // merely inherited from the foreach fix.
    let grandchild = TempRepo::init("submodule_status_cycle_grandchild");
    let _gc0 = grandchild.commit("gc.txt", "grandchild\n", "gc0");

    let mid = TempRepo::init("submodule_status_cycle_mid");
    let _mid0 = mid.commit("mid.txt", "mid\n", "mid0");
    add_submodule(&mid, &grandchild, "nested");

    let parent = TempRepo::init("submodule_status_cycle_parent");
    let _p0 = parent.commit("root.txt", "root\n", "p0");
    add_submodule(&parent, &mid, "sub");

    // A second, entirely UNRELATED and ordinary top-level submodule in the
    // same superproject — proves the cyclic "sub" being unreadable doesn't
    // take the whole listing down with it (no early return / no aborted
    // Vec), and that a normal submodule right next to a corrupted one still
    // classifies correctly.
    let other_child = TempRepo::init("submodule_status_cycle_other_child");
    let other_c0 = other_child.commit("o.txt", "other\n", "o0");
    add_submodule(&parent, &other_child, "sub2");

    // `add_submodule` leaves "sub" itself cloned+checked out, but its OWN
    // "nested" submodule is NOT (`git submodule add` never recurses) — init +
    // update it recursively first so there is a real, normal nested-submodule
    // checkout to corrupt.
    let update_result = tauri::async_runtime::block_on(submodule_update(parent.path(), Some("sub".to_string()), true, true));
    assert!(update_result.ok, "recursive submodule_update failed: {}", update_result.message);
    assert_eq!(parent.read("sub/nested/gc.txt"), "grandchild\n");

    let nested_git_file = parent.dir.join("sub").join("nested").join(".git");
    let original = std::fs::read_to_string(&nested_git_file).expect("read nested's original .git gitfile");
    assert!(
        original.trim_start().starts_with("gitdir:"),
        "expected a real gitfile pointer (not a nested .git directory) at sub/nested/.git: {original:?}"
    );
    let sub_own_git_dir = parent.dir.join(".git").join("modules").join("sub");
    assert!(sub_own_git_dir.is_dir(), "expected sub's own storage under .git/modules/sub: {sub_own_git_dir:?}");
    std::fs::write(&nested_git_file, format!("gitdir: {}\n", sub_own_git_dir.display()))
        .expect("corrupt nested's .git gitfile to redirect back at its own containing repo (sub)");

    // THE ACTUAL REGRESSION CHECK: `submodule_status` — not
    // `submodule_foreach_run` — called directly on a repo containing the
    // cyclic submodule. Must terminate cleanly (no crash, no hang) and return
    // a full, sorted Vec covering BOTH submodules.
    let rows = tauri::async_runtime::block_on(submodule_status(parent.path()))
        .expect("submodule_status must terminate cleanly (Ok), not hang or crash, on a cyclic nested submodule");
    assert_eq!(
        rows.len(),
        2,
        "expected exactly 'sub' and 'sub2' (submodule_status only ever reports TOP-LEVEL rows), got: {:?}",
        rows.iter().map(|r| &r.path).collect::<Vec<_>>()
    );

    // "sub": the top-level submodule whose OWN reachable subtree is cyclic.
    // Must be reported as the new, distinct "unreadable" classification —
    // never "clean" (which would silently hide a submodule this code could
    // not safely inspect), and never any of the other 6 ordinary statuses
    // either, since none of them could be safely computed.
    let sub_row = rows.iter().find(|r| r.path == "sub").expect("expected a 'sub' row");
    assert_eq!(sub_row.status, "unreadable", "a cyclic submodule's own status must never be guessed, and must not silently read as clean");
    assert_ne!(sub_row.status, "clean");
    // head_sha/workdir_sha are plain OID reads (the gitlink's recorded commit,
    // and the submodule's own checked-out HEAD) — neither calls
    // `submodule_status()` internally, so both stay populated even though the
    // status classification itself had to be skipped.
    assert!(sub_row.head_sha.is_some(), "head_sha should still be readable even when status is unreadable");
    assert!(sub_row.workdir_sha.is_some(), "workdir_sha should still be readable even when status is unreadable");

    // "sub2": a completely unrelated, ordinary submodule in the SAME
    // repository — must classify normally, proving the cyclic "sub" entry
    // doesn't take the rest of the listing down with it.
    let sub2_row = rows.iter().find(|r| r.path == "sub2").expect("expected a 'sub2' row");
    assert_eq!(sub2_row.status, "clean", "an unrelated, freshly-added submodule must classify normally");
    assert_eq!(sub2_row.head_sha.as_deref(), Some(other_c0.as_str()));
    assert_eq!(sub2_row.workdir_sha.as_deref(), Some(other_c0.as_str()));
}
