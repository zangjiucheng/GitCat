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
use gitcat_lib::git_bisect::{bisect_mark, bisect_reset, bisect_start, bisect_status, BisectStatus};

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
        let st: BisectStatus = bisect_status(path.clone());
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

        let m: BisectStatus = bisect_mark(path.clone(), term.to_string());
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

    let start: BisectStatus = bisect_start(path.clone(), head.to_string(), vec![root.to_string()]);
    assert!(start.ok, "bisect_start failed: {}", start.message);
    assert!(start.in_progress);
    assert!(start.first_bad.is_none());
    assert!(start.backup_ref.is_some(), "bisect_start MUST snapshot first");
    assert_eq!(git2repo.state(), RepositoryState::Bisect);

    let fb = converge(&repo, k, &git2repo, false);
    assert_eq!(fb, k_short, "FIRST-BAD MISMATCH: bisect reported {fb}, expected K {k_short}");

    let reset: BisectStatus = bisect_reset(path.clone());
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

    let start: BisectStatus = bisect_start(path.clone(), head.to_string(), vec![root.to_string()]);
    assert!(start.ok, "bisect_start failed: {}", start.message);

    let fb = converge(&repo, k, &git2repo, true);
    assert_eq!(fb, k_short, "skip-mode FIRST-BAD MISMATCH: got {fb}, expected K {k_short}");

    let reset: BisectStatus = bisect_reset(path.clone());
    assert!(reset.ok, "bisect_reset failed: {}", reset.message);
    assert!(!reset.in_progress);
}
