//! Where a commit is (containment.rs): on HEAD or not, which refs contain it,
//! and a copy of it on HEAD.

mod common;

use common::TempRepo;
use gitcat_lib::containment::commit_containment_inner;

/// main: base → m1; feature: base → f1 → f2. HEAD is main.
fn forked(tag: &str) -> (TempRepo, String, String, String) {
    let repo = TempRepo::init(tag);
    let base = repo.commit("a.txt", "a\n", "base");
    repo.must(&["checkout", "-q", "-b", "feature"]);
    let f1 = repo.commit("f.txt", "one\n", "feature one");
    repo.commit("f.txt", "one\ntwo\n", "feature two");
    repo.must(&["checkout", "-q", "main"]);
    let m1 = repo.commit("m.txt", "m\n", "main one");
    (repo, base, f1, m1)
}

#[test]
fn a_commit_on_the_current_branch_is_on_head_and_in_every_ref_after_it() {
    let (repo, base, _, m1) = forked("contain-on");
    repo.must(&["tag", "v1", &m1]);
    let c = commit_containment_inner(&repo.path(), &base).unwrap();
    assert!(c.on_head);
    assert_eq!(c.head.as_deref(), Some("main"));
    let names: Vec<_> = c.refs.iter().map(|r| (r.kind.as_str(), r.name.as_str())).collect();
    assert_eq!(names, [("local", "feature"), ("local", "main"), ("tag", "v1")]);
    assert_eq!(c.total_refs, 3);
    assert!(c.equivalent.is_none(), "nothing is looked for when it's already on HEAD");

    let tip = commit_containment_inner(&repo.path(), &m1).unwrap();
    assert!(tip.on_head, "HEAD itself counts");
}

#[test]
fn a_commit_only_on_another_branch_is_not_on_head_and_names_that_branch() {
    let (repo, _, f1, _) = forked("contain-off");
    let c = commit_containment_inner(&repo.path(), &f1).unwrap();
    assert!(!c.on_head);
    let names: Vec<_> = c.refs.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, ["feature"]);
    assert!(c.equivalent.is_none());
    assert!(!c.scan_capped);
}

#[test]
fn a_cherry_pick_with_x_is_found_through_its_trailer() {
    let (repo, _, f1, _) = forked("contain-pick-x");
    repo.must(&["cherry-pick", "-x", &f1]);
    let copy = repo.rev("HEAD").unwrap();

    let c = commit_containment_inner(&repo.path(), &f1).unwrap();
    assert!(!c.on_head, "the original itself is still not on main");
    let eq = c.equivalent.expect("the copy on main");
    assert_eq!((eq.sha.as_str(), eq.how.as_str()), (copy.as_str(), "trailer"));
    assert_eq!(eq.subject, "feature one");
}

#[test]
fn a_cherry_pick_without_x_is_found_by_its_patch() {
    let (repo, _, f1, _) = forked("contain-pick");
    repo.must(&["cherry-pick", &f1]);
    let copy = repo.rev("HEAD").unwrap();
    // Reworded too: the patch, not the subject, is what matches.
    repo.must(&["commit", "-q", "--amend", "-m", "something else entirely"]);
    let copy_amended = repo.rev("HEAD").unwrap();
    assert_ne!(copy, copy_amended);

    let c = commit_containment_inner(&repo.path(), &f1).unwrap();
    let eq = c.equivalent.expect("the same patch on main");
    assert_eq!((eq.sha.as_str(), eq.how.as_str()), (copy_amended.as_str(), "patch"));
}

#[test]
fn the_copy_points_back_at_an_original_on_head() {
    // Selected: a commit on feature that was itself cherry-picked FROM main.
    let (repo, _, _, m1) = forked("contain-copy-of");
    repo.must(&["checkout", "-q", "feature"]);
    repo.must(&["cherry-pick", "-x", &m1]);
    let copy = repo.rev("HEAD").unwrap();
    repo.must(&["checkout", "-q", "main"]);

    let c = commit_containment_inner(&repo.path(), &copy).unwrap();
    assert!(!c.on_head);
    let eq = c.equivalent.expect("its original is on main");
    assert_eq!((eq.sha.as_str(), eq.how.as_str()), (m1.as_str(), "trailer"));
}

#[test]
fn a_different_change_is_not_a_copy() {
    let (repo, _, f1, _) = forked("contain-diff");
    // Same subject, different content: not the same change.
    repo.commit("f.txt", "something else\n", "feature one");
    let c = commit_containment_inner(&repo.path(), &f1).unwrap();
    assert!(c.equivalent.is_none());
}

#[test]
fn remote_head_symrefs_are_not_listed_twice() {
    let (repo, base, _, _) = forked("contain-remote");
    let bare = TempRepo::init_bare("contain-remote-bare");
    repo.must(&["remote", "add", "origin", &bare.path()]);
    repo.must(&["push", "-q", "origin", "main"]);
    repo.must(&["fetch", "-q", "origin"]);
    repo.must(&["remote", "set-head", "origin", "main"]);

    let c = commit_containment_inner(&repo.path(), &base).unwrap();
    let remotes: Vec<_> = c.refs.iter().filter(|r| r.kind == "remote").map(|r| r.name.as_str()).collect();
    assert_eq!(remotes, ["origin/main"], "origin/HEAD is a symref to origin/main");
}

#[test]
fn a_detached_head_still_answers() {
    let (repo, base, f1, _) = forked("contain-detached");
    repo.must(&["checkout", "-q", "--detach", "feature"]);
    let c = commit_containment_inner(&repo.path(), &f1).unwrap();
    assert!(c.on_head);
    assert_eq!(c.head, None);
    let _ = base;
}

#[test]
fn an_unknown_commit_is_an_error() {
    let (repo, ..) = forked("contain-bad");
    assert!(commit_containment_inner(&repo.path(), "deadbeef").is_err());
}
