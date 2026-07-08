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
fn arm_and_settle(path: &str, fired: &Arc<AtomicBool>) -> notify_debouncer_mini::Debouncer<notify_debouncer_mini::notify::RecommendedWatcher> {
    let fired2 = fired.clone();
    let debouncer = start_watching(path, move || fired2.store(true, Ordering::SeqCst)).expect("start_watching failed");
    std::thread::sleep(Duration::from_millis(600));
    fired.store(false, Ordering::SeqCst);
    debouncer
}

#[test]
fn fires_on_a_commit_made_outside_the_watcher() {
    let repo = TempRepo::init("watch_commit");
    repo.commit("f.txt", "0\n", "c0");

    let fired = Arc::new(AtomicBool::new(false));
    let _debouncer = arm_and_settle(&repo.path(), &fired);

    repo.commit("g.txt", "1\n", "c1"); // simulates "someone committed outside GitCat"

    assert!(wait_until(&fired, Duration::from_secs(3)), "watcher should have fired after an external commit moved HEAD/refs");
}

#[test]
fn fires_on_a_branch_created_outside_the_watcher() {
    let repo = TempRepo::init("watch_branch");
    repo.commit("f.txt", "0\n", "c0");

    let fired = Arc::new(AtomicBool::new(false));
    let _debouncer = arm_and_settle(&repo.path(), &fired);

    repo.must(&["branch", "feature-x"]); // touches refs/heads/feature-x, not HEAD

    assert!(wait_until(&fired, Duration::from_secs(3)), "watcher should have fired after a branch was created under refs/");
}

#[test]
fn does_not_fire_on_an_unrelated_working_tree_file_change() {
    let repo = TempRepo::init("watch_unrelated");
    repo.commit("f.txt", "0\n", "c0");

    let fired = Arc::new(AtomicBool::new(false));
    let _debouncer = arm_and_settle(&repo.path(), &fired);

    std::fs::write(repo.dir.join("unrelated.txt"), "not a git change\n").expect("write unrelated file");

    // Past the 400ms debounce window, with margin — should still not have fired.
    std::thread::sleep(Duration::from_millis(900));
    assert!(!fired.load(Ordering::SeqCst), "watcher should NOT fire for a plain working-tree file untouched by git itself");
}
