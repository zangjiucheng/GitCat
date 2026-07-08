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

#[test]
fn fires_on_a_commit_made_outside_the_watcher() {
    let repo = TempRepo::init("watch_commit");
    repo.commit("f.txt", "0\n", "c0");

    let fired = Arc::new(AtomicBool::new(false));
    let fired2 = fired.clone();
    let _debouncer = start_watching(&repo.path(), move || fired2.store(true, Ordering::SeqCst)).expect("start_watching failed");

    // Give the watcher's background thread a moment to actually register
    // before making the change it's supposed to catch.
    std::thread::sleep(Duration::from_millis(200));
    repo.commit("g.txt", "1\n", "c1"); // simulates "someone committed outside GitCat"

    assert!(wait_until(&fired, Duration::from_secs(3)), "watcher should have fired after an external commit moved HEAD/refs");
}

#[test]
fn fires_on_a_branch_created_outside_the_watcher() {
    let repo = TempRepo::init("watch_branch");
    repo.commit("f.txt", "0\n", "c0");

    let fired = Arc::new(AtomicBool::new(false));
    let fired2 = fired.clone();
    let _debouncer = start_watching(&repo.path(), move || fired2.store(true, Ordering::SeqCst)).expect("start_watching failed");

    std::thread::sleep(Duration::from_millis(200));
    repo.must(&["branch", "feature-x"]); // touches refs/heads/feature-x, not HEAD

    assert!(wait_until(&fired, Duration::from_secs(3)), "watcher should have fired after a branch was created under refs/");
}

#[test]
fn does_not_fire_on_an_unrelated_working_tree_file_change() {
    let repo = TempRepo::init("watch_unrelated");
    repo.commit("f.txt", "0\n", "c0");

    let fired = Arc::new(AtomicBool::new(false));
    let fired2 = fired.clone();
    let _debouncer = start_watching(&repo.path(), move || fired2.store(true, Ordering::SeqCst)).expect("start_watching failed");

    std::thread::sleep(Duration::from_millis(200));
    std::fs::write(repo.dir.join("unrelated.txt"), "not a git change\n").expect("write unrelated file");

    // Past the 400ms debounce window, with margin — should still not have fired.
    std::thread::sleep(Duration::from_millis(900));
    assert!(!fired.load(Ordering::SeqCst), "watcher should NOT fire for a plain working-tree file untouched by git itself");
}
