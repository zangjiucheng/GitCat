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
//! The 5-state classification below (conflicted / not-initialized /
//! out-of-date / dirty / clean) was verified empirically against real `git
//! submodule status`'s own `-`/`+`/` `/`U` prefix conventions in a throwaway
//! fixture before writing these tests (see `src/submodule.rs`'s module doc
//! comment for the exact bit patterns observed):
//!   - conflicted: the superproject's OWN index has an unresolved merge
//!     conflict at the submodule's gitlink path (two branches bumped the
//!     tracked commit differently). Not a `SubmoduleStatus` bit at all —
//!     detected via `Index::conflicts()` instead (see
//!     `submodule_gitlink_merge_conflict_is_not_clean`).
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
use std::time::{SystemTime, UNIX_EPOCH};

use common::TempRepo;
use gitcat_lib::submodule::submodule_status;

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

    let rows = submodule_status(repo.path()).expect("submodule_status failed");
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

    let rows = submodule_status(clone.path()).expect("submodule_status failed");
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

    let rows = submodule_status(parent.path()).expect("submodule_status failed");
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

    let rows = submodule_status(parent.path()).expect("submodule_status failed");
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

    let rows = submodule_status(parent.path()).expect("submodule_status failed");
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

    let rows = submodule_status(parent.path()).expect("submodule_status failed");
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

    let rows = submodule_status(parent.path()).expect("submodule_status failed");
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

    let rows = submodule_status(parent.path()).expect("submodule_status failed");
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
