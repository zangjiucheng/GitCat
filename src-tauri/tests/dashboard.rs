//! Multi-repository dashboard (backlog #11): `dashboard::dashboard_repo_status`
//! against repos in various states (clean, dirty, ahead, behind, diverged,
//! detached, unborn) plus a bad/non-existent path — and a cheap sanity check
//! that it stays fast even against a repo with many commits (never a
//! Revwalk — see dashboard.rs's own module doc for why that matters).

mod common;

use common::TempRepo;
use gitcat_lib::dashboard::dashboard_repo_status;

#[test]
fn bad_path_reports_a_clean_error_not_a_crash() {
    let result = dashboard_repo_status("/definitely/not/a/repo/anywhere/at/all".into());
    assert!(result.is_err(), "a non-repo path should surface Err, not panic or Ok");
}

#[test]
fn clean_repo_reports_branch_and_no_dirty_no_conflicts() {
    let repo = TempRepo::init("dashboard_clean");
    let c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();

    let status = dashboard_repo_status(path).expect("dashboard_repo_status failed");
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert!(!status.detached);
    assert!(!status.dirty, "freshly committed repo should be clean");
    assert_eq!(status.conflicted, 0);
    assert_eq!(status.ahead, None, "no upstream configured -> ahead is None");
    assert_eq!(status.behind, None);
    assert_eq!(status.head_sha.as_deref(), Some(common::short(&c0).as_str()));
    assert_eq!(status.last_subject.as_deref(), Some("c0"));
    assert!(status.last_commit_time.is_some());
}

#[test]
fn dirty_working_tree_is_reported_dirty() {
    let repo = TempRepo::init("dashboard_dirty");
    let _c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();

    // Modify without committing.
    std::fs::write(repo.dir.join("f.txt"), "uncommitted change\n").unwrap();
    let status = dashboard_repo_status(path.clone()).expect("dashboard_repo_status failed");
    assert!(status.dirty, "a modified-but-uncommitted file must report dirty:true");
    assert_eq!(status.conflicted, 0);

    // A brand-new untracked file also counts as dirty.
    let repo2 = TempRepo::init("dashboard_dirty_untracked");
    let _c0b = repo2.commit("g.txt", "0\n", "c0");
    std::fs::write(repo2.dir.join("new.txt"), "hi\n").unwrap();
    let status2 = dashboard_repo_status(repo2.path()).expect("dashboard_repo_status failed");
    assert!(status2.dirty, "an untracked file must also report dirty:true");
}

#[test]
fn unborn_repo_has_no_branch_head_or_commit_info() {
    let repo = TempRepo::init("dashboard_unborn");
    let path = repo.path();

    let status = dashboard_repo_status(path).expect("dashboard_repo_status failed");
    // No commits yet: HEAD is unborn. libgit2's repo.head() fails on an unborn
    // repo, so branch/detached/head_sha/last_subject/last_commit_time are all
    // the "nothing to report" defaults, not a crash.
    assert_eq!(status.branch, None);
    assert!(!status.detached);
    assert_eq!(status.head_sha, None);
    assert_eq!(status.last_subject, None);
    assert_eq!(status.last_commit_time, None);
    assert_eq!(status.ahead, None);
    assert_eq!(status.behind, None);
}

#[test]
fn detached_head_is_reported_detached_with_no_branch_name() {
    let repo = TempRepo::init("dashboard_detached");
    let c0 = repo.commit("f.txt", "0\n", "c0");
    repo.must(&["checkout", "-q", &c0]);
    let path = repo.path();

    let status = dashboard_repo_status(path).expect("dashboard_repo_status failed");
    assert!(status.detached);
    assert_eq!(status.branch, None);
    assert_eq!(status.head_sha.as_deref(), Some(common::short(&c0).as_str()));
    // Detached HEAD has no local branch to look up an upstream for.
    assert_eq!(status.ahead, None);
    assert_eq!(status.behind, None);
}

#[test]
fn ahead_behind_and_diverged_are_computed_against_the_upstream_only() {
    let remote = TempRepo::init_bare("dashboard_ab_remote");
    let repo = TempRepo::init("dashboard_ab_local");
    repo.must(&["remote", "add", "origin", &remote.path()]);
    let _c0 = repo.commit("f.txt", "0\n", "c0");
    repo.must(&["push", "-q", "-u", "origin", "main"]);

    // Ahead by one: commit locally, don't push.
    let _c1 = repo.commit("f.txt", "1\n", "c1");
    let status = dashboard_repo_status(repo.path()).expect("dashboard_repo_status failed");
    assert_eq!(status.ahead, Some(1));
    assert_eq!(status.behind, Some(0));

    // Diverged: push c1, then reset local back to c0-equivalent by making a
    // second, different local-only commit while the remote (still at c1)
    // moves ahead via a second clone pushing its own commit.
    repo.must(&["push", "-q", "origin", "main"]);
    let clone_dir = std::env::temp_dir().join(format!(
        "gitcat-test-dashboard-ab-clone-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let clone_path = clone_dir.to_string_lossy().to_string();
    let clone_out = std::process::Command::new("git")
        .args(["clone", "-q", &remote.path(), &clone_path])
        .output()
        .expect("failed to spawn git clone");
    assert!(clone_out.status.success(), "git clone failed: {}", String::from_utf8_lossy(&clone_out.stderr));
    let clone_git = |args: &[&str]| {
        std::process::Command::new("git")
            .arg("-C")
            .arg(&clone_path)
            .args(args)
            // Isolate from this machine's REAL global/system git config —
            // same fix TempRepo::git() already applies to every OTHER git
            // subprocess in this test suite (see common/mod.rs's own doc
            // comment on why). This ad-hoc raw `git clone` (not created via
            // TempRepo) was missing it: a real `commit.gpgsign=true` in the
            // host's global config made its `commit` calls attempt to GPG-
            // sign with no pinentry available in a headless test, so the
            // commit silently never happened and the following push pushed
            // nothing new — surfacing as a flaky-looking, but actually fully
            // deterministic, "behind: Some(0), expected Some(1)" failure.
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_AUTHOR_NAME", "GitCat Test")
            .env("GIT_AUTHOR_EMAIL", "test@gitcat.example")
            .env("GIT_COMMITTER_NAME", "GitCat Test")
            .env("GIT_COMMITTER_EMAIL", "test@gitcat.example")
            .output()
            .expect("failed to spawn git in clone")
    };
    std::fs::write(clone_dir.join("f.txt"), "from-clone\n").unwrap();
    clone_git(&["add", "-A"]);
    clone_git(&["commit", "-q", "--no-verify", "-m", "remote-side commit"]);
    let push_out = clone_git(&["push", "-q", "origin", "main"]);
    assert!(push_out.status.success(), "clone push failed: {}", String::from_utf8_lossy(&push_out.stderr));

    // Make ANOTHER local commit on `repo` (which hasn't fetched the clone's
    // push) so both sides have diverged from their shared base (c1).
    let _c2 = repo.commit("f.txt", "2-local-only\n", "c2");
    repo.must(&["fetch", "-q", "origin"]); // learn about the remote's new tip, don't merge
    let diverged = dashboard_repo_status(repo.path()).expect("dashboard_repo_status failed");
    assert_eq!(diverged.ahead, Some(1), "one local-only commit (c2) not on origin/main");
    assert_eq!(diverged.behind, Some(1), "one remote-only commit not yet merged locally");

    let _ = std::fs::remove_dir_all(&clone_dir);
}

#[test]
fn behind_only_is_computed_when_local_has_not_moved() {
    let remote = TempRepo::init_bare("dashboard_behind_remote");
    let repo = TempRepo::init("dashboard_behind_local");
    repo.must(&["remote", "add", "origin", &remote.path()]);
    let _c0 = repo.commit("f.txt", "0\n", "c0");
    repo.must(&["push", "-q", "-u", "origin", "main"]);

    // Simulate the remote moving ahead without `repo` committing anything
    // itself: push directly from a second clone, then just fetch (no merge).
    let clone_dir = std::env::temp_dir().join(format!(
        "gitcat-test-dashboard-behind-clone-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let clone_path = clone_dir.to_string_lossy().to_string();
    let clone_out = std::process::Command::new("git")
        .args(["clone", "-q", &remote.path(), &clone_path])
        .output()
        .expect("failed to spawn git clone");
    assert!(clone_out.status.success());
    let run = |args: &[&str]| {
        std::process::Command::new("git")
            .arg("-C")
            .arg(&clone_path)
            .args(args)
            // Isolate from this machine's REAL global/system git config —
            // same fix TempRepo::git() already applies to every OTHER git
            // subprocess in this test suite (see common/mod.rs's own doc
            // comment on why). This ad-hoc raw `git clone` (not created via
            // TempRepo) was missing it: a real `commit.gpgsign=true` in the
            // host's global config made its `commit` calls attempt to GPG-
            // sign with no pinentry available in a headless test, so the
            // commit silently never happened and the following push pushed
            // nothing new — surfacing as a flaky-looking, but actually fully
            // deterministic, "behind: Some(0), expected Some(1)" failure.
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_AUTHOR_NAME", "GitCat Test")
            .env("GIT_AUTHOR_EMAIL", "test@gitcat.example")
            .env("GIT_COMMITTER_NAME", "GitCat Test")
            .env("GIT_COMMITTER_EMAIL", "test@gitcat.example")
            .output()
            .expect("failed to spawn git in clone")
    };
    std::fs::write(clone_dir.join("f.txt"), "1\n").unwrap();
    run(&["add", "-A"]);
    run(&["commit", "-q", "--no-verify", "-m", "c1-from-clone"]);
    let push_out = run(&["push", "-q", "origin", "main"]);
    assert!(push_out.status.success());

    repo.must(&["fetch", "-q", "origin"]);
    let status = dashboard_repo_status(repo.path()).expect("dashboard_repo_status failed");
    assert_eq!(status.ahead, Some(0));
    assert_eq!(status.behind, Some(1));

    let _ = std::fs::remove_dir_all(&clone_dir);
}

#[test]
fn stays_cheap_against_a_repo_with_many_commits_no_revwalk() {
    let repo = TempRepo::init("dashboard_perf_many_commits");
    // A few hundred commits is enough to make an accidental full revwalk
    // noticeably slower than a single branch/commit lookup, without making
    // the test itself slow to set up.
    for i in 0..300 {
        repo.commit("f.txt", &format!("{i}\n"), &format!("c{i}"));
    }
    let path = repo.path();

    let start = std::time::Instant::now();
    let status = dashboard_repo_status(path).expect("dashboard_repo_status failed");
    let elapsed = start.elapsed();

    assert!(status.branch.is_some());
    assert!(
        elapsed.as_millis() < 500,
        "dashboard_repo_status took {elapsed:?} against a 300-commit repo — \
         suspiciously slow for a command that must never walk history \
         (see dashboard.rs's module doc)"
    );
}
