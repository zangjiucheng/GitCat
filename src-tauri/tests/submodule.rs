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
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use common::TempRepo;
use gitcat_lib::submodule::{submodule_add, submodule_init, submodule_status, submodule_sync, submodule_update};

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

    let rows_before = submodule_status(clone.path()).expect("submodule_status failed");
    assert_eq!(rows_before.len(), 1);
    assert_eq!(rows_before[0].status, "not-initialized");

    let result = submodule_init(clone.path(), "sub".to_string());
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
    let rows_after = submodule_status(clone.path()).expect("submodule_status failed");
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
    let rows_before = submodule_status(clone.path()).expect("submodule_status failed");
    assert_eq!(rows_before[0].status, "not-initialized");

    // init:true folds registration + clone + checkout into this one call —
    // no prior submodule_init needed.
    let result = submodule_update(clone.path(), Some("sub".to_string()), false, true);
    assert!(result.ok, "submodule_update failed: {}", result.message);
    assert!(result.backup_ref.is_none(), "submodule_update must never snapshot (see module doc comment)");

    let content = std::fs::read_to_string(PathBuf::from(clone.path()).join("sub").join("f.txt"))
        .expect("read cloned submodule file");
    assert_eq!(content, "hello\n");

    let rows_after = submodule_status(clone.path()).expect("submodule_status failed");
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
    let result = submodule_update(clone.path(), Some("sub".to_string()), true, true);
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

    let result = submodule_update(clone.path(), Some("sub".to_string()), false, true);
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
    let result = submodule_update(parent.path(), Some("sub".to_string()), false, false);
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
    let rows_before = submodule_status(clone.path()).expect("submodule_status failed");
    assert_eq!(rows_before.len(), 2);
    assert!(rows_before.iter().all(|r| r.status == "not-initialized"));

    // submodule_path: None => update EVERY registered submodule, no path
    // restriction — the bulk "Update all" action.
    let result = submodule_update(clone.path(), None, false, true);
    assert!(result.ok, "submodule_update (all) failed: {}", result.message);

    let rows_after = submodule_status(clone.path()).expect("submodule_status failed");
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

    let result = submodule_add(parent.path(), child.path(), "sub".to_string(), None);
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
    let rows = submodule_status(parent.path()).expect("submodule_status failed");
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

    let result = submodule_add(parent.path(), child.path(), "sub".to_string(), Some("feature".to_string()));
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

    let result = submodule_add(parent.path(), child.path(), "existing.txt".to_string(), None);
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

    let result = submodule_add(parent.path(), child.path(), "../../etc/evil".to_string(), None);
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

    let result = submodule_sync(parent.path(), Some("sub".to_string()), false);
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
    let result = submodule_sync(parent.path(), None, false);
    assert!(result.ok, "submodule_sync (all) failed: {}", result.message);

    let (_, a_after, _) = parent.git(&["config", "--get", "submodule.subA.url"]);
    let (_, b_after, _) = parent.git(&["config", "--get", "submodule.subB.url"]);
    assert_eq!(a_after, child_a_new.path(), "expected subA's .git/config url to be rewritten");
    assert_eq!(b_after, child_b_new.path(), "expected subB's .git/config url to be rewritten");
}
