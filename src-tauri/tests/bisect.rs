//! Bisect (adapted from examples/bisectcheck.rs, which already carried real
//! assert!/assert_eq! — this converts that logic into #[test] fns).
//!
//! Builds a fresh disposable 15-commit linear repo (commit #7 / index 6 = K,
//! a deliberate "bug" commit), drives bisect_start/status/mark to convergence
//! against a pure git2-ancestry oracle, asserts first_bad.sha == short(K), then
//! bisect_reset and asserts full HEAD/branch/tree/RepositoryState recovery.
//! A second test exercises the `skip` mode regression guard: `current` must
//! track the checked-out HEAD (BISECT_EXPECTED_REV) even after a skip, never
//! the skip-blind `bisect_rev`.

mod common;

use common::TempRepo;
use git2::{Oid, Repository, RepositoryState};
use gitcat_lib::git_bisect::{
    bisect_mark, bisect_reset, bisect_start, bisect_status, run_bisect, try_run_bisect, BisectRunState, BisectStatus,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const N: usize = 15;
const K_IDX: usize = 6;

fn short(oid: Oid) -> String {
    oid.to_string().chars().take(7).collect()
}

/// Returns (repo, original branch, root oid = good, K oid = first-bad, head oid = bad).
fn build_repo(tag: &str) -> (TempRepo, String, Oid, Oid, Oid) {
    let repo = TempRepo::init(tag);
    let (mut root, mut k, mut head) = (Oid::zero(), Oid::zero(), Oid::zero());
    for i in 0..N {
        std::fs::write(repo.dir.join("history.txt"), format!("line {i}\n")).unwrap();
        if i == K_IDX {
            std::fs::write(repo.dir.join("bug.txt"), "BUG: regression introduced here\n").unwrap();
        }
        repo.must(&["add", "-A"]);
        let msg = format!("c{i}");
        repo.must(&["commit", "-q", "--no-verify", "-m", &msg]);
        let oid = Oid::from_str(&repo.must(&["rev-parse", "HEAD"])).unwrap();
        if i == 0 {
            root = oid;
        }
        if i == K_IDX {
            k = oid;
        }
        if i == N - 1 {
            head = oid;
        }
    }
    let branch = repo.current_branch();
    (repo, branch, root, k, head)
}

/// Ground truth: `cur` is bad iff it IS K or K is an ancestor of it.
fn is_bad(repo: &Repository, cur: Oid, k: Oid) -> bool {
    cur == k || repo.graph_descendant_of(cur, k).unwrap_or(false)
}

fn head_oid(repo: &TempRepo) -> Oid {
    repo.open().head().unwrap().peel_to_commit().unwrap().id()
}

/// Drives good/bad/skip marking until convergence, returning the first-bad sha.
fn converge(repo: &TempRepo, k: Oid, git2repo: &Repository, skip_mode: bool) -> String {
    let path = repo.path();
    let mut did_skip = false;

    for step in 0..60 {
        let st: BisectStatus = tauri::async_runtime::block_on(bisect_status(path.clone()));
        assert!(st.in_progress, "status should be in-progress at loop top: {}", st.message);
        assert!(st.first_bad.is_none(), "status should be running (no firstBad yet) at loop top");

        let cur = head_oid(repo);
        let cur_short = short(cur);
        assert_eq!(
            st.current.as_ref().map(|c| c.sha.as_str()),
            Some(cur_short.as_str()),
            "status.current must equal the checked-out HEAD (skip-safe) at step {step}"
        );

        let bad = is_bad(git2repo, cur, k);
        let term = if skip_mode && !did_skip && bad && cur != k {
            did_skip = true;
            "skip"
        } else if bad {
            "bad"
        } else {
            "good"
        };

        let m: BisectStatus = tauri::async_runtime::block_on(bisect_mark(path.clone(), term.to_string()));
        assert!(m.ok, "bisect_mark {term} failed: {}", m.message);
        if let Some(fb) = m.first_bad {
            return fb.sha;
        }
        assert!(m.in_progress, "mark should still be in-progress until converged");
    }
    panic!("bisect never converged within 60 steps");
}

#[test]
fn bisect_converges_to_first_bad_commit() {
    std::env::set_var("LC_ALL", "C");
    let (repo, branch, root, k, head) = build_repo("bisect_goodbad");
    let path = repo.path();
    let git2repo = repo.open();
    let orig_head = git2repo.head().unwrap().peel_to_commit().unwrap().id();
    assert_eq!(orig_head, head, "sanity: HEAD should be the final commit");
    let k_short = short(k);

    let start: BisectStatus = tauri::async_runtime::block_on(bisect_start(path.clone(), head.to_string(), vec![root.to_string()]));
    assert!(start.ok, "bisect_start failed: {}", start.message);
    assert!(start.in_progress);
    assert!(start.first_bad.is_none());
    assert!(start.backup_ref.is_some(), "bisect_start MUST snapshot first");
    assert_eq!(git2repo.state(), RepositoryState::Bisect);

    let fb = converge(&repo, k, &git2repo, false);
    assert_eq!(fb, k_short, "FIRST-BAD MISMATCH: bisect reported {fb}, expected K {k_short}");

    let reset: BisectStatus = tauri::async_runtime::block_on(bisect_reset(path.clone()));
    assert!(reset.ok, "bisect_reset failed: {}", reset.message);
    assert!(!reset.in_progress);

    let repo2 = Repository::open(&repo.dir).unwrap();
    assert_eq!(repo2.state(), RepositoryState::Clean, "repo not Clean after reset");
    let h = repo2.head().unwrap();
    assert!(h.is_branch(), "HEAD should be on a branch again (was detached during bisect)");
    assert_eq!(h.shorthand(), Some(branch.as_str()), "HEAD not back on original branch");
    assert_eq!(h.peel_to_commit().unwrap().id(), orig_head, "HEAD oid not restored");
    assert!(repo.is_clean(), "working tree dirty after reset");
}

#[test]
fn bisect_skip_tracks_checked_out_head_not_stale_bisect_rev() {
    std::env::set_var("LC_ALL", "C");
    let (repo, _branch, root, k, head) = build_repo("bisect_skip");
    let path = repo.path();
    let git2repo = repo.open();
    let k_short = short(k);

    let start: BisectStatus = tauri::async_runtime::block_on(bisect_start(path.clone(), head.to_string(), vec![root.to_string()]));
    assert!(start.ok, "bisect_start failed: {}", start.message);

    let fb = converge(&repo, k, &git2repo, true);
    assert_eq!(fb, k_short, "skip-mode FIRST-BAD MISMATCH: got {fb}, expected K {k_short}");

    let reset: BisectStatus = tauri::async_runtime::block_on(bisect_reset(path.clone()));
    assert!(reset.ok, "bisect_reset failed: {}", reset.message);
    assert!(!reset.in_progress);
}

// ---------------------------------------------------------------------------
// Automated mode (`git bisect run <command>` equivalent): drives
// gitcat_lib::git_bisect::run_bisect directly, the same way tests/watch.rs
// drives watch::start_watching directly instead of the #[tauri::command]
// wrapper — a plain integration test has no real AppHandle/State to hand
// `bisect_run_start` itself.
// ---------------------------------------------------------------------------

#[test]
fn bisect_run_converges_via_scripted_good_bad_command() {
    std::env::set_var("LC_ALL", "C");
    let (repo, _branch, root, k, head) = build_repo("bisect_run_goodbad");
    let path = repo.path();
    let k_short = short(k);

    let start: BisectStatus = tauri::async_runtime::block_on(bisect_start(path.clone(), head.to_string(), vec![root.to_string()]));
    assert!(start.ok, "bisect_start failed: {}", start.message);

    // Deterministic stand-in for a real regression test: "good" (exit 0) iff
    // bug.txt (introduced at K and present in every descendant) is absent.
    let mut progress_calls = 0usize;
    let result: BisectStatus = run_bisect(&path, "test ! -f bug.txt", || false, |_status| progress_calls += 1);

    assert!(result.first_bad.is_some(), "automated run did not converge: {}", result.message);
    assert_eq!(
        result.first_bad.as_ref().unwrap().sha,
        k_short,
        "FIRST-BAD MISMATCH: automated run reported {:?}, expected K {k_short}",
        result.first_bad.as_ref().map(|c| &c.sha)
    );
    assert!(result.ok, "a converged run should report ok=true: {}", result.message);
    assert!(
        result.message.to_lowercase().contains("converged"),
        "message should distinguish convergence: {}",
        result.message
    );
    assert!(progress_calls >= 1, "on_progress should fire at least once as steps are applied");

    let reset: BisectStatus = tauri::async_runtime::block_on(bisect_reset(path.clone()));
    assert!(reset.ok, "bisect_reset failed: {}", reset.message);
    assert!(!reset.in_progress);
    assert!(repo.is_clean(), "working tree dirty after reset");
}

#[test]
fn bisect_run_handles_a_skip_exit_code_and_still_converges() {
    std::env::set_var("LC_ALL", "C");
    let (repo, _branch, root, k, head) = build_repo("bisect_run_skip");
    let path = repo.path();
    let k_short = short(k);

    let start: BisectStatus = tauri::async_runtime::block_on(bisect_start(path.clone(), head.to_string(), vec![root.to_string()]));
    assert!(start.ok, "bisect_start failed: {}", start.message);

    // K itself is ALWAYS correctly reported bad (never skipped) so convergence
    // is guaranteed; the first OTHER bad commit the script is asked about
    // exits 125 (skip) exactly once (recorded via a marker file — the
    // script's own side channel across separate invocations), and every bad
    // commit after that is reported bad normally. Mirrors exactly the
    // existing manual-skip test's "skip the first non-K bad commit
    // encountered" shape, just moved into the test script.
    let k_line = format!("line {K_IDX}");
    let command = format!(
        "if grep -qx '{k_line}' history.txt; then exit 1; \
         elif [ -f bug.txt ]; then \
           if [ ! -f .gitcat-skip-marker ]; then touch .gitcat-skip-marker; exit 125; else exit 1; fi; \
         else exit 0; fi"
    );

    let result: BisectStatus = run_bisect(&path, &command, || false, |_| {});

    assert!(result.first_bad.is_some(), "automated run with a skip did not converge: {}", result.message);
    assert_eq!(
        result.first_bad.as_ref().unwrap().sha,
        k_short,
        "skip-mode FIRST-BAD MISMATCH: got {:?}, expected K {k_short}",
        result.first_bad.as_ref().map(|c| &c.sha)
    );
    assert!(
        repo.dir.join(".gitcat-skip-marker").exists(),
        "the exit-125/skip branch should have been exercised at least once"
    );

    let reset: BisectStatus = tauri::async_runtime::block_on(bisect_reset(path.clone()));
    assert!(reset.ok, "bisect_reset failed: {}", reset.message);
}

#[test]
fn bisect_run_aborts_cleanly_on_exit_126_or_127_and_leaves_session_resumable() {
    std::env::set_var("LC_ALL", "C");
    for bad_exit_code in [126, 127] {
        let (repo, _branch, root, _k, head) = build_repo(&format!("bisect_run_abort_{bad_exit_code}"));
        let path = repo.path();

        let start: BisectStatus = tauri::async_runtime::block_on(bisect_start(path.clone(), head.to_string(), vec![root.to_string()]));
        assert!(start.ok, "bisect_start failed: {}", start.message);
        let before = tauri::async_runtime::block_on(bisect_status(path.clone()));
        assert!(before.in_progress);

        let result: BisectStatus = run_bisect(&path, &format!("exit {bad_exit_code}"), || false, |_| {
            panic!("on_progress must not fire — the command never produced an applicable mark")
        });

        assert!(!result.ok, "exit {bad_exit_code} must be reported as an abort, not silently ok");
        assert!(result.first_bad.is_none(), "must not have converged");
        let msg = result.message.to_lowercase();
        assert!(msg.contains("abort"), "message should clearly say it aborted (code {bad_exit_code}): {}", result.message);
        assert!(
            msg.contains(&bad_exit_code.to_string()),
            "message should mention the distinguishing exit code {bad_exit_code}: {}",
            result.message
        );

        // The bisect session itself must be untouched by the abort — same
        // current commit, still in progress, still resumable both ways.
        let after = tauri::async_runtime::block_on(bisect_status(path.clone()));
        assert!(after.in_progress, "bisect session should still be in progress after an abort");
        assert_eq!(
            after.current.as_ref().map(|c| c.sha.as_str()),
            before.current.as_ref().map(|c| c.sha.as_str()),
            "an aborted step must not have moved the checked-out commit"
        );

        let m: BisectStatus = tauri::async_runtime::block_on(bisect_mark(path.clone(), "good".to_string()));
        assert!(m.ok, "bisect should still be resumable via manual marking after an abort: {}", m.message);

        let reset: BisectStatus = tauri::async_runtime::block_on(bisect_reset(path.clone()));
        assert!(reset.ok, "bisect_reset should still work cleanly after an abort: {}", reset.message);
    }
}

#[test]
fn bisect_run_refuses_cleanly_when_no_bisect_is_in_progress() {
    let repo = TempRepo::init("bisect_run_norun");
    repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();

    let result: BisectStatus = run_bisect(&path, "true", || false, |_| {
        panic!("on_progress must not fire when there is nothing to run")
    });

    assert!(!result.ok, "should refuse cleanly, not report ok");
    assert!(!result.in_progress);
    assert!(
        result.message.to_lowercase().contains("no bisect in progress"),
        "message should match bisect_mark's own refusal: {}",
        result.message
    );
}

#[test]
fn bisect_run_cancel_stops_the_loop_before_convergence() {
    std::env::set_var("LC_ALL", "C");
    let (repo, _branch, root, _k, head) = build_repo("bisect_run_cancel");
    let path = repo.path();

    let start: BisectStatus = tauri::async_runtime::block_on(bisect_start(path.clone(), head.to_string(), vec![root.to_string()]));
    assert!(start.ok, "bisect_start failed: {}", start.message);

    // On its FIRST invocation only, the script touches a marker file (the
    // side channel the main test thread polls below) and then sleeps well
    // past the time it takes the polling thread to notice and request
    // cancellation — so cancellation is observed at the very next
    // between-steps check, before a second step ever runs, deterministically
    // well short of the ~4 steps a 15-commit bisect needs to converge.
    let command = "if [ ! -f .gitcat-first-run ]; then touch .gitcat-first-run; sleep 0.5; fi; exit 0";

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_for_run = cancel.clone();
    let path_for_run = path.clone();
    let handle = std::thread::spawn(move || {
        let mut n = 0usize;
        let result = run_bisect(
            &path_for_run,
            command,
            move || cancel_for_run.load(Ordering::SeqCst),
            |_status| n += 1,
        );
        (result, n)
    });

    let marker = repo.dir.join(".gitcat-first-run");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(marker.exists(), "the test command should have started running before the timeout");
    cancel.store(true, Ordering::SeqCst);

    let (result, steps_applied) = handle.join().expect("run_bisect thread panicked");

    assert!(result.first_bad.is_none(), "cancellation should have stopped the loop before it converged");
    assert!(
        result.message.to_lowercase().contains("cancel"),
        "message should clearly say it was cancelled: {}",
        result.message
    );
    assert!(steps_applied <= 1, "cancellation should stop the loop right after the in-flight step, got {steps_applied} steps");

    let status = tauri::async_runtime::block_on(bisect_status(path.clone()));
    assert!(status.in_progress, "bisect session should still be in progress after a cancelled run");

    let reset: BisectStatus = tauri::async_runtime::block_on(bisect_reset(path.clone()));
    assert!(reset.ok, "bisect_reset failed: {}", reset.message);
}

// ---------------------------------------------------------------------------
// Bug 1 regression: BisectRunState's "already running" guard must be a REAL,
// structurally-enforced mutual-exclusion lock, not just a documented
// assumption — a second `bisect_run_start` while one is already in flight
// must refuse cleanly (no second `run_bisect` loop ever starts), rather than
// two loops interleaving `git bisect good/bad/skip` calls and checkouts
// against the same on-disk sequencer state. Drives `try_run_bisect` (the
// testable wrapper `bisect_run_start` itself calls) directly, since a plain
// integration test has no real AppHandle/State to hand the #[tauri::command]
// — same reasoning as testing `run_bisect` directly above. Coordination via
// a marker-file side channel mirrors `bisect_run_cancel_stops_the_loop_
// before_convergence` above exactly.
#[test]
fn bisect_run_start_refuses_a_second_concurrent_call_while_one_is_in_flight() {
    std::env::set_var("LC_ALL", "C");
    let (repo, _branch, root, _k, head) = build_repo("bisect_run_mutex");
    let path = repo.path();

    let start: BisectStatus = tauri::async_runtime::block_on(bisect_start(path.clone(), head.to_string(), vec![root.to_string()]));
    assert!(start.ok, "bisect_start failed: {}", start.message);

    let state = Arc::new(BisectRunState::default());

    // First call: touches a marker file on its first (only) invocation, then
    // sleeps well past the time it takes the main thread to notice and
    // attempt a concurrent second call — so the second call is guaranteed to
    // race against a genuinely in-flight first run, not a already-finished one.
    let command = "if [ ! -f .gitcat-inflight ]; then touch .gitcat-inflight; sleep 0.5; fi; exit 0";

    let state1 = state.clone();
    let path1 = path.clone();
    let command1 = command.to_string();
    let handle = std::thread::spawn(move || try_run_bisect(&state1, &path1, &command1, || false, |_| {}));

    let marker = repo.dir.join(".gitcat-inflight");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(marker.exists(), "the first run should have started before the timeout");

    // The concurrent second call must refuse cleanly — None, with on_progress
    // never firing at all — rather than running a second loop against the
    // same bisect session while the first one is still mid-step.
    let second = try_run_bisect(&state, &path, "true", || false, |_| {
        panic!("on_progress must not fire — a concurrent second run must never execute at all")
    });
    assert!(
        second.is_none(),
        "a second bisect_run_start while one is already in flight must refuse cleanly, not run a second concurrent loop"
    );

    let first_result = handle
        .join()
        .expect("first run thread panicked")
        .expect("the first call should have been allowed to claim the guard and actually run");
    assert!(first_result.ok, "first run should have completed normally: {}", first_result.message);

    let reset: BisectStatus = tauri::async_runtime::block_on(bisect_reset(path.clone()));
    assert!(reset.ok, "bisect_reset failed: {}", reset.message);
    // bisect_start refuses on a dirty working tree, and the marker file the
    // test command touched is untracked — clean it up before restarting.
    let _ = std::fs::remove_file(repo.dir.join(".gitcat-inflight"));

    // The guard must be released once the first run finishes — a later,
    // now-non-concurrent call (against a fresh bisect session) must be
    // allowed through normally, not permanently locked out by a guard that
    // leaked from the first run.
    let restart: BisectStatus = tauri::async_runtime::block_on(bisect_start(path.clone(), head.to_string(), vec![root.to_string()]));
    assert!(restart.ok, "bisect_start (second session) failed: {}", restart.message);
    let third = try_run_bisect(&state, &path, "test ! -f bug.txt", || false, |_| {});
    let third_result = third.expect("the guard must be released after the first run finishes, allowing a later call through");
    assert!(third_result.ok, "the released-guard run should complete normally: {}", third_result.message);

    let reset2: BisectStatus = tauri::async_runtime::block_on(bisect_reset(path.clone()));
    assert!(reset2.ok, "bisect_reset (second session) failed: {}", reset2.message);
}
