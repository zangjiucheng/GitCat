//! Live refresh: does the watcher actually fire on an externally-made git
//! change, and correctly NOT fire on an unrelated working-tree file touch.
//! Talks to gitcat_lib::watch::start_watching() directly rather than the
//! watch_repo command itself, since that needs a real Tauri AppHandle/State
//! this plain integration-test binary doesn't have — see watch.rs's own doc
//! comment on why the core logic is split out for exactly this reason.

mod common;

use common::TempRepo;
use gitcat_lib::watch::start_watching;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn wait_until(flag: &AtomicBool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if flag.load(Ordering::SeqCst) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    flag.load(Ordering::SeqCst)
}

// Arm a watcher on a freshly-created repo and let its startup settle. macOS's
// FSEvents backend can replay very recent historical events (from the
// TempRepo::init()/commit() setup that happens milliseconds before the watch
// stream is created) to a BRAND NEW stream — a real, known quirk, not
// specific to this crate. Draining a generous settle window and then
// resetting the flag right before the actual test action means any such
// catch-up noise from setup can never be mistaken for the thing the test is
// actually trying to observe. (Confirmed as the cause of a real, if rare,
// CI flake in does_not_fire_on_an_unrelated_working_tree_file_change: it
// failed once with no code change and no local reproduction across 5 retries
// — exactly the signature of a historical-replay race, not a real bug in
// is_relevant()'s filtering.)
fn arm_and_settle(path: &str, fired: &Arc<AtomicBool>) -> gitcat_lib::watch::RepoWatcher {
    let fired2 = fired.clone();
    let watcher = start_watching(path, move || fired2.store(true, Ordering::SeqCst)).expect("start_watching failed");
    std::thread::sleep(Duration::from_millis(600));
    fired.store(false, Ordering::SeqCst);
    watcher
}

#[test]
fn fires_on_a_commit_made_outside_the_watcher() {
    let repo = TempRepo::init("watch_commit");
    repo.commit("f.txt", "0\n", "c0");

    let fired = Arc::new(AtomicBool::new(false));
    let _watcher = arm_and_settle(&repo.path(), &fired);

    repo.commit("g.txt", "1\n", "c1"); // simulates "someone committed outside GitCat"

    assert!(wait_until(&fired, Duration::from_secs(3)), "watcher should have fired after an external commit moved HEAD/refs");
}

#[test]
fn fires_on_a_branch_created_outside_the_watcher() {
    let repo = TempRepo::init("watch_branch");
    repo.commit("f.txt", "0\n", "c0");

    let fired = Arc::new(AtomicBool::new(false));
    let _watcher = arm_and_settle(&repo.path(), &fired);

    repo.must(&["branch", "feature-x"]); // touches refs/heads/feature-x, not HEAD

    assert!(wait_until(&fired, Duration::from_secs(3)), "watcher should have fired after a branch was created under refs/");
}

/// Regression test for the git-dir-ROOT-watch fix (see watch.rs's own doc
/// comment): checking out an EXISTING branch only rewrites `.git/HEAD`'s own
/// symref target — it never touches `refs/heads/*` at all (the branch's own
/// ref file is untouched). This is exactly the "HEAD-only" change the old
/// single-file `HEAD` watch was meant to catch, and exactly the case a
/// rename-replace-fragile single-file watch (this fix's whole motivation)
/// would risk missing after an earlier HEAD update already replaced the
/// watched inode once.
#[test]
fn fires_on_a_checkout_that_only_changes_head_not_refs() {
    let repo = TempRepo::init("watch_checkout_head_only");
    repo.commit("f.txt", "0\n", "c0");
    repo.must(&["branch", "other"]); // exists before the watcher arms, so checkout below touches ONLY HEAD

    let fired = Arc::new(AtomicBool::new(false));
    let _watcher = arm_and_settle(&repo.path(), &fired);

    repo.must(&["checkout", "-q", "other"]); // rewrites .git/HEAD's symref target only

    assert!(wait_until(&fired, Duration::from_secs(3)), "watcher should have fired after a HEAD-only checkout");
}

#[test]
fn does_not_fire_on_an_unrelated_working_tree_file_change() {
    let repo = TempRepo::init("watch_unrelated");
    repo.commit("f.txt", "0\n", "c0");

    let fired = Arc::new(AtomicBool::new(false));
    let _watcher = arm_and_settle(&repo.path(), &fired);

    std::fs::write(repo.dir.join("unrelated.txt"), "not a git change\n").expect("write unrelated file");

    // Past the 400ms debounce window, with margin — should still not have fired.
    std::thread::sleep(Duration::from_millis(900));
    assert!(!fired.load(Ordering::SeqCst), "watcher should NOT fire for a plain working-tree file untouched by git itself");
}

#[test]
fn does_not_fire_on_gitcats_own_refs() {
    let repo = TempRepo::init("watch_own_refs");
    let c0 = repo.commit("f.txt", "0\n", "c0");

    let fired = Arc::new(AtomicBool::new(false));
    let _watcher = arm_and_settle(&repo.path(), &fired);

    repo.must(&["update-ref", "refs/gitgui/backup/1-2-3", &c0]);
    repo.must(&["update-ref", "refs/gitcat/oplog", &c0]);

    std::thread::sleep(Duration::from_millis(900));
    assert!(!fired.load(Ordering::SeqCst), "a snapshot or op-log write must not reload the graph");
}

/// The old filter matched path COMPONENTS anywhere in the absolute path, so a
/// repo that merely lived under a directory named `gitgui` never refreshed.
#[test]
fn fires_for_a_repo_living_under_a_directory_named_gitgui() {
    let holder = TempRepo::init("watch_gitgui_parent");
    let dir = holder.dir.join("gitgui").join("app");
    std::fs::create_dir_all(&dir).unwrap();
    let git = |args: &[&str]| {
        let ok = std::process::Command::new("git").arg("-C").arg(&dir).args(args).status().unwrap().success();
        assert!(ok, "git {args:?} failed");
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "c0"]);

    let fired = Arc::new(AtomicBool::new(false));
    let _watcher = arm_and_settle(dir.to_str().unwrap(), &fired);

    git(&["branch", "feature"]);
    assert!(wait_until(&fired, Duration::from_secs(3)), "a branch created in a repo under .../gitgui/... must still fire");
}

/// A linked worktree's branches live in the COMMON dir's refs/, which the
/// worktree's own git dir doesn't contain.
#[test]
fn a_linked_worktree_fires_on_a_branch_created_in_the_main_checkout() {
    let repo = TempRepo::init("watch_worktree");
    repo.commit("f.txt", "0\n", "c0");
    let wt = repo.dir.with_file_name(format!("{}-wt", repo.dir.file_name().unwrap().to_string_lossy()));
    repo.must(&["worktree", "add", "-q", "-b", "side", wt.to_str().unwrap()]);

    let fired = Arc::new(AtomicBool::new(false));
    let _watcher = arm_and_settle(wt.to_str().unwrap(), &fired);

    repo.must(&["branch", "from-main-checkout"]);
    let ok = wait_until(&fired, Duration::from_secs(3));
    let _ = std::fs::remove_dir_all(&wt);
    assert!(ok, "the worktree's watcher should see refs/ in the common dir");
}

/// On Linux, notify watches IN_OPEN, so merely READING HEAD or a ref is an
/// event. Treated as a change, GitCat's own refresh (which reads HEAD) queued
/// the next refresh, forever. Windows reports no reads, so this only ever bit
/// on Linux; it runs everywhere so it can't regress there.
#[test]
fn does_not_fire_when_head_and_refs_are_only_read() {
    let repo = TempRepo::init("watch_reads");
    repo.commit("f.txt", "0\n", "c0");
    repo.must(&["branch", "other"]);

    let fired = Arc::new(AtomicBool::new(false));
    let _watcher = arm_and_settle(&repo.path(), &fired);

    for _ in 0..3 {
        repo.must(&["rev-parse", "HEAD"]);
        repo.must(&["for-each-ref"]);
        repo.must(&["log", "-1", "--all"]);
        let _ = gitcat_lib::trust::open_repo(&repo.path()).unwrap().head().unwrap();
    }

    std::thread::sleep(Duration::from_millis(900));
    assert!(!fired.load(Ordering::SeqCst), "reading HEAD/refs is not a change");
}
