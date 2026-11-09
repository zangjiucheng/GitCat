//! Cancelling the local history ops (#233 group B) while git is stuck.
//!
//! "Stuck" without a network: a hook that sleeps. Git runs hooks through its
//! shell (Git for Windows ships `sh` and `sleep`), so the sleep is a grandchild
//! of the git we spawn, and returning quickly proves the whole tree died.
//! Each core runs inside `jobs::with_current`, which is exactly what the
//! command's `run_job` does around it — minus the registry and events.

mod common;

use common::TempRepo;
use git2::RepositoryState;
use gitcat_lib::git_merge::merge_start_core;
use gitcat_lib::jobs::{with_current, CurrentJob};
use gitcat_lib::procutil::CancelToken;
use gitcat_lib::tool_settings::{resolve_conflict_with_external_tool_inner, ExternalTool};
use gitcat_lib::workdir::commit_core;
use std::time::{Duration, Instant};

fn hook(repo: &TempRepo, name: &str, body: &str) {
    let p = repo.dir.join(".git").join("hooks").join(name);
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

/// Run `f` as the current job, cancelling it after `after`.
fn cancelled_after<R>(after: Duration, f: impl FnOnce() -> R) -> (R, Duration) {
    let token = CancelToken::new();
    let t = {
        let token = token.clone();
        std::thread::spawn(move || {
            std::thread::sleep(after);
            token.cancel();
        })
    };
    let start = Instant::now();
    let r = with_current(CurrentJob::new(token, || false), f);
    t.join().unwrap();
    (r, start.elapsed())
}

#[test]
fn a_commit_stuck_in_its_hook_is_cancelled_and_leaves_no_index_lock() {
    let repo = TempRepo::init("cancel_commit");
    let c0 = repo.commit("f.txt", "0\n", "c0");
    hook(&repo, "pre-commit", "sleep 30");
    std::fs::write(repo.dir.join("f.txt"), "1\n").unwrap();
    repo.must(&["add", "-A"]);

    let (res, took) = cancelled_after(Duration::from_millis(1000), || commit_core(repo.path(), Some("c1".into()), None));
    assert!(res.cancelled && !res.ok, "expected cancelled, got: {}", res.message);
    assert!(res.message.contains("err_history.commit_cancelled"), "message: {}", res.message);
    assert!(res.backup_ref.is_some(), "the pre-commit snapshot is reported for Undo");
    assert!(took < Duration::from_secs(8), "cancel took {took:?} — the hook survived");
    assert_eq!(repo.rev("HEAD"), Some(c0), "no commit was made");
    assert!(!repo.dir.join(".git").join("index.lock").exists(), "the killed git's index.lock is cleaned up");
}

#[test]
fn a_merge_stuck_in_pre_merge_commit_is_cancelled_and_backed_out() {
    let repo = TempRepo::init("cancel_merge");
    repo.commit("a.txt", "0\n", "base");
    repo.must(&["branch", "feature"]);
    let main_tip = repo.commit("a.txt", "1\n", "main edit");
    repo.must(&["checkout", "-q", "feature"]);
    let feature_tip = repo.commit("b.txt", "1\n", "feature edit");
    repo.must(&["checkout", "-q", "main"]);
    hook(&repo, "pre-merge-commit", "sleep 30");

    let (res, took) =
        cancelled_after(Duration::from_millis(1000), || merge_start_core(repo.path(), feature_tip.clone(), Some("no-ff".into())));
    assert_eq!(res.state, "cancelled", "got state {} / {}", res.state, res.message);
    assert!(!res.ok);
    assert!(res.message.contains("err_history.merge_cancelled"), "message: {}", res.message);
    assert!(took < Duration::from_secs(8), "cancel took {took:?}");
    assert_eq!(repo.rev("HEAD"), Some(main_tip), "no merge commit");
    assert_eq!(repo.open().state(), RepositoryState::Clean, "a half-made merge is backed out: {}", res.message);
    assert!(res.message.contains("err_history.cancel_reset_tree"), "the message says so: {}", res.message);
    let (_, st, _) = repo.git(&["status", "--porcelain"]);
    let mh = repo.dir.join(".git").join("MERGE_HEAD").exists();
    assert!(repo.is_clean(), "the working tree is back too: {st:?} MERGE_HEAD={mh} msg={}", res.message);
}

#[test]
fn a_merge_tool_that_never_returns_is_cancelled_and_the_conflict_stays() {
    let repo = TempRepo::init("cancel_mergetool");
    repo.commit("shared.txt", "base line\n", "base");
    repo.must(&["branch", "feature"]);
    repo.commit("shared.txt", "main line\n", "edit on main");
    repo.must(&["checkout", "-q", "feature"]);
    repo.commit("shared.txt", "feature line\n", "edit on feature");
    repo.must(&["checkout", "-q", "main"]);
    let (ok, _, _) = repo.git(&["merge", "feature"]);
    assert!(!ok, "merge was expected to conflict");

    let tool = ExternalTool { name: "stucktool".into(), cmd: Some("sleep 30".into()) };
    let (res, took) = cancelled_after(Duration::from_millis(1000), || {
        resolve_conflict_with_external_tool_inner(Some(tool), &repo.path(), "shared.txt")
    });
    assert!(res.cancelled && !res.ok, "expected cancelled, got: {}", res.message);
    assert!(res.message.contains("err_history.mergetool_cancelled"), "message: {}", res.message);
    assert!(took < Duration::from_secs(8), "cancel took {took:?}");
    assert_eq!(res.remaining, 1, "the conflict is still there to resolve");
    assert_eq!(repo.open().state(), RepositoryState::Merge, "the user's merge is never aborted for them");
}

/// Outside a job the cores behave exactly as before: no token, nothing armed.
#[test]
fn outside_a_job_a_commit_runs_normally() {
    let repo = TempRepo::init("cancel_none");
    repo.commit("f.txt", "0\n", "c0");
    std::fs::write(repo.dir.join("f.txt"), "1\n").unwrap();
    repo.must(&["add", "-A"]);
    let res = commit_core(repo.path(), Some("c1".into()), None);
    assert!(res.ok && !res.cancelled, "{}", res.message);
}

/// `reset --merge` backs out only what the merge wrote: an unrelated
/// uncommitted change made before it survives, as with `git merge --abort`.
#[test]
fn a_cancelled_merge_keeps_unrelated_local_changes() {
    let repo = TempRepo::init("cancel_merge_local");
    repo.commit("a.txt", "0\n", "base");
    repo.commit("mine.txt", "0\n", "mine");
    repo.must(&["branch", "feature", "HEAD~1"]);
    repo.must(&["checkout", "-q", "feature"]);
    let feature_tip = repo.commit("b.txt", "1\n", "feature edit");
    repo.must(&["checkout", "-q", "main"]);
    std::fs::write(repo.dir.join("mine.txt"), "uncommitted\n").unwrap();
    hook(&repo, "pre-merge-commit", "sleep 30");

    let (res, _) = cancelled_after(Duration::from_millis(1000), || merge_start_core(repo.path(), feature_tip.clone(), Some("no-ff".into())));
    assert_eq!(res.state, "cancelled", "{}", res.message);
    assert!(!repo.dir.join("b.txt").exists(), "the merged-in file is gone");
    assert_eq!(std::fs::read_to_string(repo.dir.join("mine.txt")).unwrap(), "uncommitted\n", "the user's own edit is kept");
}
