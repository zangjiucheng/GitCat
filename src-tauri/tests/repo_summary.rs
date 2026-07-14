//! Repository Summary (`git log`-derived churn/contributor/monthly-activity/
//! problem-area diagnostics): churn ranking, multi-author contributor ranking
//! + bus factor, monthly bucketing, an authentic `git revert` subject, the
//! `--since` window boundary, empty/unborn-repo and invalid-path handling,
//! and the documented no-rename-tracking behavior.
//!
//! Mirrors `tests/pickaxe.rs`'s structure/conventions (`TempRepo` from
//! `tests/common`, a `must_err` helper). Contributor/monthly-activity tests
//! need commits with DISTINCT authors/timestamps — `TempRepo::commit()`
//! hardcodes one author identity and one fixed commit date (see its own doc
//! comment), so those tests build commits directly via `git2::Repository`,
//! same technique `tests/pickaxe.rs::search_truncates_at_the_match_cap`
//! already established for full control over authorship/timing.

mod common;

use common::TempRepo;
use gitcat_lib::repo_summary::repo_summary;

fn must_err<T>(r: Result<T, String>, ctx: &str) -> String {
    match r {
        Ok(_) => panic!("{ctx}: expected Err, got Ok"),
        Err(e) => e,
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before epoch")
        .as_secs() as i64
}

/// Commits `files` (path, content pairs) on top of `parent`'s tree (or a
/// fresh empty tree if `parent` is `None`), with an explicit author/time —
/// full control unavailable through `TempRepo::commit()`/`TempRepo::git()`,
/// both of which hardcode identity and date (see their own doc comments).
fn commit_with(
    repo: &git2::Repository,
    parent: Option<git2::Oid>,
    files: &[(&str, &str)],
    subject: &str,
    author_name: &str,
    author_email: &str,
    time: i64,
) -> git2::Oid {
    let mut tb = match parent {
        Some(p) => {
            let parent_tree = repo.find_commit(p).expect("find parent").tree().expect("parent tree");
            repo.treebuilder(Some(&parent_tree)).expect("treebuilder from parent")
        }
        None => repo.treebuilder(None).expect("new treebuilder"),
    };
    for (path, content) in files {
        let blob = repo.blob(content.as_bytes()).expect("write blob");
        tb.insert(*path, blob, 0o100644).expect("tree insert");
    }
    let tree_oid = tb.write().expect("write tree");
    let tree = repo.find_tree(tree_oid).expect("find tree");
    let parents: Vec<git2::Commit> = match parent {
        Some(oid) => vec![repo.find_commit(oid).expect("find parent commit")],
        None => vec![],
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let sig = git2::Signature::new(author_name, author_email, &git2::Time::new(time, 0)).expect("signature");
    repo.commit(Some("HEAD"), &sig, &sig, subject, &tree, &parent_refs).expect("commit")
}

// ---------------------------------------------------------------------------
// Churn ranking
// ---------------------------------------------------------------------------

#[test]
fn churn_ranks_files_by_touch_count_desc() {
    let repo = TempRepo::init("summary_churn");
    repo.commit("hot.txt", "v1\n", "c1: touch hot.txt");
    repo.commit("hot.txt", "v2\n", "c2: touch hot.txt again");
    repo.commit("warm.txt", "v1\n", "c3: touch warm.txt");
    repo.commit("hot.txt", "v3\n", "c4: touch hot.txt a third time");

    let summary = repo_summary(repo.path()).expect("repo_summary should succeed");
    assert_eq!(summary.total_commits, 4);
    assert!(!summary.truncated);
    assert_eq!(summary.churn[0].path, "hot.txt");
    assert_eq!(summary.churn[0].touches, 3);
    assert_eq!(summary.churn[1].path, "warm.txt");
    assert_eq!(summary.churn[1].touches, 1);
}

// ---------------------------------------------------------------------------
// Contributors + bus factor (needs distinct authors — git2-direct commits)
// ---------------------------------------------------------------------------

#[test]
fn contributors_ranked_desc_and_bus_factor_is_the_dominant_single_author() {
    let repo = TempRepo::init("summary_contributors");
    let git_repo = repo.open();
    let now = now_secs();

    let c1 = commit_with(&git_repo, None, &[("a.txt", "1")], "one", "Ada", "ada@x.com", now - 1);
    let c2 = commit_with(&git_repo, Some(c1), &[("a.txt", "2")], "two", "Ada", "ada@x.com", now - 2);
    let c3 = commit_with(&git_repo, Some(c2), &[("a.txt", "3")], "three", "Ada", "ada@x.com", now - 3);
    let _c4 = commit_with(&git_repo, Some(c3), &[("a.txt", "4")], "four", "Bob", "bob@x.com", now - 4);

    let summary = repo_summary(repo.path()).expect("repo_summary should succeed");
    assert_eq!(summary.total_commits, 4);
    assert_eq!(summary.contributors[0].name, "Ada");
    assert_eq!(summary.contributors[0].commits, 3);
    assert_eq!(summary.contributors[1].name, "Bob");
    assert_eq!(summary.contributors[1].commits, 1);
    // Ada alone already covers 3/4 = 75% >= the 50% bus-factor threshold.
    assert_eq!(summary.bus_factor, 1);
}

#[test]
fn bus_factor_needs_more_than_one_contributor_when_evenly_split() {
    let repo = TempRepo::init("summary_bus_factor_split");
    let git_repo = repo.open();
    let now = now_secs();

    let c1 = commit_with(&git_repo, None, &[("a.txt", "1")], "one", "Ada", "ada@x.com", now - 1);
    let c2 = commit_with(&git_repo, Some(c1), &[("a.txt", "2")], "two", "Bob", "bob@x.com", now - 2);
    let c3 = commit_with(&git_repo, Some(c2), &[("a.txt", "3")], "three", "Cid", "cid@x.com", now - 3);
    let _c4 = commit_with(&git_repo, Some(c3), &[("a.txt", "4")], "four", "Dee", "dee@x.com", now - 4);

    let summary = repo_summary(repo.path()).expect("repo_summary should succeed");
    assert_eq!(summary.total_commits, 4);
    assert_eq!(summary.bus_factor, 2, "2 of 4 equal contributors are needed to reach 50%");
}

// ---------------------------------------------------------------------------
// Monthly bucketing (needs distinct, controlled timestamps — git2-direct)
// ---------------------------------------------------------------------------

#[test]
fn monthly_activity_buckets_into_distinct_chronological_months() {
    let repo = TempRepo::init("summary_monthly");
    let git_repo = repo.open();
    let now = now_secs();
    const DAY: i64 = 86_400;

    // Gaps of >=31 days guarantee each commit lands in a different calendar
    // month than its neighbor (no month has more than 31 days), while
    // staying well inside the 365-day window. c3/c4 are 1 second apart —
    // guaranteed the same UTC calendar day (and so the same month) barring
    // the ~1-in-86400 chance `now` itself lands within 1 second of midnight
    // UTC, negligible enough to accept — to confirm same-month counts merge.
    let c1 = commit_with(&git_repo, None, &[("a.txt", "1")], "one", "Ada", "ada@x.com", now - 100 * DAY);
    let c2 = commit_with(&git_repo, Some(c1), &[("a.txt", "2")], "two", "Ada", "ada@x.com", now - 55 * DAY);
    let c3 = commit_with(&git_repo, Some(c2), &[("a.txt", "3")], "three", "Ada", "ada@x.com", now - 10 * DAY);
    let _c4 = commit_with(&git_repo, Some(c3), &[("a.txt", "3b")], "three-again", "Ada", "ada@x.com", now - 10 * DAY + 1);

    let summary = repo_summary(repo.path()).expect("repo_summary should succeed");
    assert_eq!(summary.total_commits, 4);
    assert_eq!(summary.monthly.len(), 3, "expected 3 distinct months, got: {:?}", summary.monthly.iter().map(|m| &m.month).collect::<Vec<_>>());
    // chronological order, and the last bucket (c3+c4) must have merged to 2.
    for pair in summary.monthly.windows(2) {
        assert!(pair[0].month < pair[1].month, "monthly entries must be chronologically sorted");
    }
    assert_eq!(summary.monthly[2].commits, 2, "c3 and c4 fall in the same month and must merge into one bucket");
}

// ---------------------------------------------------------------------------
// Problem areas: an authentic `git revert` subject + bug-keyword clustering
// ---------------------------------------------------------------------------

#[test]
fn problem_areas_counts_a_real_git_revert_and_clusters_fix_commits_per_file() {
    let repo = TempRepo::init("summary_problem_areas");
    repo.commit("a.txt", "v1\n", "seed a.txt");
    repo.commit("a.txt", "v2\n", "Fix bug in a.txt");
    repo.commit("a.txt", "v3\n", "Fix another bug in a.txt");
    let to_revert = repo.commit("a.txt", "v4\n", "Fix yet another bug in a.txt");
    repo.must(&["revert", "--no-edit", &to_revert]);

    let summary = repo_summary(repo.path()).expect("repo_summary should succeed");
    assert_eq!(summary.total_commits, 5);
    assert_eq!(summary.problem_areas.total_commits, 5);
    // git's own auto-generated revert subject starts with `Revert "` — the
    // narrower whole-repo revert/hotfix tally must catch it.
    assert_eq!(summary.problem_areas.revert_or_hotfix_commits, 1);
    // a.txt: touched by seed + 3 fix commits + the revert = 5 touches. 4 of
    // those count as bugfix touches: the 3 "Fix ..." commits, PLUS the
    // revert itself — git's auto-generated revert subject embeds the
    // ORIGINAL commit's subject verbatim (`Revert "Fix yet another bug in
    // a.txt"`), so it also contains a real "bug"/"fix" keyword token.
    assert_eq!(summary.problem_areas.files.len(), 1);
    assert_eq!(summary.problem_areas.files[0].path, "a.txt");
    assert_eq!(summary.problem_areas.files[0].total_touches, 5);
    assert_eq!(summary.problem_areas.files[0].bugfix_touches, 4);
}

#[test]
fn problem_areas_filters_out_a_file_below_the_min_touches_threshold() {
    let repo = TempRepo::init("summary_problem_areas_min_touches");
    repo.commit("once.txt", "v1\n", "Fix a one-off bug");

    let summary = repo_summary(repo.path()).expect("repo_summary should succeed");
    assert!(summary.problem_areas.files.is_empty(), "a file touched only once must be filtered out");
}

// ---------------------------------------------------------------------------
// --since window: a commit older than CHURN_WINDOW_DAYS must be excluded
// ---------------------------------------------------------------------------

#[test]
fn since_window_excludes_commits_older_than_the_churn_window() {
    let repo = TempRepo::init("summary_since_window");
    let git_repo = repo.open();
    let now = now_secs();
    const DAY: i64 = 86_400;

    // Well before the 365-day window.
    let old = commit_with(&git_repo, None, &[("old.txt", "1")], "old commit", "Ada", "ada@x.com", now - 400 * DAY);
    // Inside the window.
    let _recent = commit_with(&git_repo, Some(old), &[("new.txt", "1")], "recent commit", "Ada", "ada@x.com", now - 5 * DAY);

    let summary = repo_summary(repo.path()).expect("repo_summary should succeed");
    assert_eq!(summary.total_commits, 1, "the 400-day-old commit must be excluded by --since");
    assert!(summary.churn.iter().any(|f| f.path == "new.txt"));
    assert!(!summary.churn.iter().any(|f| f.path == "old.txt"), "old.txt belongs only to the excluded commit");
}

// ---------------------------------------------------------------------------
// Empty/unborn repo + invalid path
// ---------------------------------------------------------------------------

#[test]
fn empty_unborn_repo_returns_a_zeroed_summary_not_an_error() {
    let repo = TempRepo::init("summary_empty_repo");
    let summary = repo_summary(repo.path()).expect("an empty repo must be Ok, not Err");
    assert_eq!(summary.total_commits, 0);
    assert!(summary.churn.is_empty());
    assert!(summary.contributors.is_empty());
    assert!(summary.monthly.is_empty());
    assert!(summary.problem_areas.files.is_empty());
    assert_eq!(summary.bus_factor, 0);
}

#[test]
fn invalid_repo_path_is_a_clean_err() {
    let err = must_err(repo_summary("/no/such/path/at/all".to_string()), "nonexistent repo path must be Err");
    assert!(!err.is_empty());
}

// ---------------------------------------------------------------------------
// Documented no-rename-tracking behavior: a renamed file counts as TWO
// separate churn entries (old name + new name), never merged — locking in
// the module's own documented simplification as intentional, tested
// behavior (mirrors file_history.rs's own --follow-caveat tests).
// ---------------------------------------------------------------------------

#[test]
fn renamed_file_is_counted_as_two_separate_churn_entries_not_merged() {
    let repo = TempRepo::init("summary_rename");
    repo.commit("old.txt", "content\n", "c1: add old.txt");
    repo.must(&["mv", "old.txt", "new.txt"]);
    repo.must(&["commit", "-q", "--no-verify", "-m", "c2: rename old.txt to new.txt"]);

    let summary = repo_summary(repo.path()).expect("repo_summary should succeed");
    assert_eq!(summary.total_commits, 2);
    let old_touches = summary.churn.iter().find(|f| f.path == "old.txt").map(|f| f.touches);
    let new_touches = summary.churn.iter().find(|f| f.path == "new.txt").map(|f| f.touches);
    assert_eq!(old_touches, Some(2), "old.txt: added in c1, deleted (--no-renames) in c2");
    assert_eq!(new_touches, Some(1), "new.txt: added (--no-renames) only in c2");
}
