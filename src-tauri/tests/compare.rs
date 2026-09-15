//! Compare two commits (#49).
//!
//! The assertions that matter are the ones a unit test against a fake graph
//! could not make: that `ahead`/`behind` are reported against the ORDERED pair
//! rather than click order, that the chain is the range and not one endpoint's
//! whole history, and that two unrelated roots are answered rather than erroring.

mod common;

use common::TempRepo;
use gitcat_lib::compare::commit_range_summary_inner;

/// A linear history c0..c3 on `main`.
fn linear(tag: &str) -> (TempRepo, Vec<String>) {
    let repo = TempRepo::init(tag);
    let mut shas = Vec::new();
    for i in 0..4 {
        shas.push(repo.commit(&format!("f{i}.txt"), &format!("line {i}\n"), &format!("commit {i}")));
    }
    (repo, shas)
}

#[test]
fn a_linear_range_reports_the_commits_between_the_two_endpoints() {
    let (repo, shas) = linear("cmp-linear");
    let s = commit_range_summary_inner(&repo.path(), &shas[0], &shas[3]).expect("must summarize");

    assert!(s.linear, "c0 is an ancestor of c3");
    assert_eq!(s.ahead, 3, "three commits sit between c0 and c3");
    assert_eq!(s.behind, 0);
    assert_eq!(s.commits.len(), 3, "the chain excludes the `from` endpoint");
    // Newest first — the graph's own order.
    assert_eq!(s.commits[0].subject, "commit 3");
    assert_eq!(s.commits[2].subject, "commit 1");
    assert!(!s.truncated);
}

#[test]
fn the_pair_is_ordered_by_ancestry_not_by_which_one_was_clicked() {
    // The bug this test exists for: `ahead` must always mean "on `to`, not on
    // `from`". Computed independently of the ordering it flips with the click
    // order, so comparing newest-to-oldest would report 0 ahead / 3 behind and
    // an empty chain — the same two commits reading as an empty range.
    let (repo, shas) = linear("cmp-order");
    let forwards = commit_range_summary_inner(&repo.path(), &shas[0], &shas[3]).unwrap();
    let backwards = commit_range_summary_inner(&repo.path(), &shas[3], &shas[0]).unwrap();

    assert_eq!(forwards.from, backwards.from, "the older commit must be `from` either way");
    assert_eq!(forwards.to, backwards.to);
    assert_eq!(forwards.ahead, backwards.ahead);
    assert_eq!(forwards.behind, backwards.behind);
    assert_eq!(forwards.commits.len(), backwards.commits.len());
}

#[test]
fn the_net_delta_ignores_a_change_that_was_undone_in_between() {
    // Why this reports net delta and not cumulative churn. The file is edited
    // and then restored, so the two endpoints are identical in it — the answer
    // to "what is different between these two points" is: nothing.
    let repo = TempRepo::init("cmp-net");
    let a = repo.commit("f.txt", "original\n", "base");
    repo.commit("f.txt", "changed\n", "churn 1");
    let b = repo.commit("f.txt", "original\n", "churn 2 — back to where we started");

    let s = commit_range_summary_inner(&repo.path(), &a, &b).unwrap();
    assert_eq!(s.ahead, 2, "two commits happened");
    assert_eq!(s.files_changed, 0, "but nothing is different between the endpoints");
    assert_eq!(s.additions, 0);
    assert_eq!(s.deletions, 0);
}

#[test]
fn a_real_delta_is_counted() {
    // The counterpart to the test above — net delta must not be "always zero".
    let repo = TempRepo::init("cmp-delta");
    let a = repo.commit("f.txt", "one\n", "base");
    let b = repo.commit("f.txt", "one\ntwo\nthree\n", "add two lines");

    let s = commit_range_summary_inner(&repo.path(), &a, &b).unwrap();
    assert_eq!(s.files_changed, 1);
    assert_eq!(s.additions, 2);
    assert_eq!(s.deletions, 0);
}

#[test]
fn a_diverged_pair_reports_the_fork_and_draws_no_chain() {
    // Two legs, one list. Rather than show one leg as if it were the range,
    // the chain is left empty and the fork point plus both counts are reported.
    let repo = TempRepo::init("cmp-fork");
    let base = repo.commit("base.txt", "base\n", "base");
    repo.must(&["checkout", "-b", "side"]);
    let side = repo.commit("side.txt", "side\n", "side only");
    repo.must(&["checkout", "main"]);
    let main_a = repo.commit("main1.txt", "m1\n", "main 1");
    let main_b = repo.commit("main2.txt", "m2\n", "main 2");

    let s = commit_range_summary_inner(&repo.path(), &main_b, &side).unwrap();
    assert!(!s.linear, "the two are on different legs");
    assert!(s.commits.is_empty(), "a diverged range must not draw a partial chain");
    assert_eq!(s.merge_base.as_deref(), Some(&common::short(&base)[..]), "the fork point");
    // Ordered pair is (from=main_b, to=side): 1 commit on side, 2 on main.
    assert_eq!(s.ahead, 1);
    assert_eq!(s.behind, 2);
    let _ = (main_a, side);
}

#[test]
fn two_unrelated_roots_are_answered_rather_than_erroring() {
    // `git checkout --orphan` or a grafted import: no merge base exists. That
    // is an answer ("these share no history"), not a failure — and the net
    // delta between the two trees is still real and still worth showing.
    let repo = TempRepo::init("cmp-orphan");
    let a = repo.commit("a.txt", "a\n", "on main");
    repo.must(&["checkout", "--orphan", "lonely"]);
    repo.must(&["rm", "-rf", "--cached", "."]);
    let b = repo.commit("b.txt", "b\n", "on the orphan");

    let s = commit_range_summary_inner(&repo.path(), &a, &b).expect("unrelated histories must not error");
    assert!(s.merge_base.is_none(), "there is no common ancestor");
    assert!(s.files_changed > 0, "the trees still differ and that is still useful");
}

#[test]
fn comparing_a_commit_with_itself_is_an_empty_range() {
    let (repo, shas) = linear("cmp-self");
    let s = commit_range_summary_inner(&repo.path(), &shas[2], &shas[2]).unwrap();
    assert!(s.linear);
    assert_eq!(s.ahead, 0);
    assert_eq!(s.behind, 0);
    assert!(s.commits.is_empty());
    assert_eq!(s.files_changed, 0);
}

#[test]
fn an_unresolvable_endpoint_is_an_error_not_a_silent_empty_range() {
    let (repo, shas) = linear("cmp-bad-rev");
    let err = commit_range_summary_inner(&repo.path(), &shas[0], "deadbee")
        .expect_err("an unknown sha must be refused");
    assert!(err.contains("err_misc.not_a_valid_commit"), "got: {err}");
}
