//! Full-repo ref restore on undo (adapted from examples/safetycheck.rs, which
//! already carried real assert!/assert_eq!).
//!
//! Proves the Safety Manager's global undo restores the WHOLE local-branch
//! topology (delete / create / move / rename), never orphans a commit (an
//! at-risk tip is pinned under refs/gitgui/deleted/*), and stays itself
//! undoable (undo-of-undo re-applies). Each scenario runs in its own fresh
//! temp repo; snapshot() runs BEFORE the mutation, mirroring real call sites.

mod common;

use common::TempRepo;
use gitcat_lib::safety::{snapshot, undo};

/// Fresh repo on `main` with three commits; returns (repo, [c0, c1, c2]).
fn setup(tag: &str) -> (TempRepo, [String; 3]) {
    let repo = TempRepo::init(tag);
    let c0 = repo.commit("f.txt", "0\n", "c0");
    let c1 = repo.commit("f.txt", "1\n", "c1");
    let c2 = repo.commit("f.txt", "2\n", "c2");
    (repo, [c0, c1, c2])
}

fn deleted_shas(repo: &TempRepo) -> Vec<String> {
    repo.must(&["for-each-ref", "--format=%(objectname)", "refs/gitgui/deleted/"])
        .lines()
        .map(|l| l.to_string())
        .collect()
}

#[test]
fn undo_restores_a_deleted_non_current_branch() {
    let (repo, [_c0, c1, c2]) = setup("safety_delete");
    repo.must(&["branch", "feature", &c1]); // feature @ c1, HEAD on main @ c2

    let r = snapshot(&repo.open()).expect("snapshot");
    assert!(r.starts_with("refs/gitgui/backup/"));

    repo.must(&["update-ref", "-d", "refs/heads/feature"]); // simulate delete_branch
    assert!(repo.rev("refs/heads/feature").is_none(), "precondition: feature deleted");

    let u = undo(&repo.open()).expect("undo");
    assert!(u.ok, "undo failed: {}", u.message);
    assert_eq!(repo.rev("refs/heads/feature").as_deref(), Some(c1.as_str()), "feature not restored to c1");
    assert_eq!(repo.rev("refs/heads/main").as_deref(), Some(c2.as_str()), "main should not have moved");
    assert_eq!(repo.current_branch(), "main", "HEAD should still be on main");
    assert!(repo.is_clean(), "tree dirty after undo");
}

#[test]
fn undo_removes_a_new_branch_and_pins_its_tip_then_undo_of_undo_restores_it() {
    let (repo, [_c0, _c1, c2]) = setup("safety_create");

    let s2 = snapshot(&repo.open()).expect("snapshot"); // captures {main: c2} — no tmpwork yet
    assert!(s2.starts_with("refs/gitgui/backup/"));

    // Create tmpwork with a UNIQUE commit U (child of c2), leave HEAD on main.
    repo.must(&["checkout", "-q", "-b", "tmpwork"]);
    let u_sha = repo.commit("new.txt", "unique\n", "U (only on tmpwork)");
    repo.must(&["checkout", "-q", "main"]);
    assert_eq!(repo.rev("refs/heads/tmpwork").as_deref(), Some(u_sha.as_str()), "precondition tmpwork@U");

    let u = undo(&repo.open()).expect("undo");
    assert!(u.ok, "undo failed: {}", u.message);
    assert!(repo.rev("refs/heads/tmpwork").is_none(), "tmpwork (created after snapshot) not removed");
    assert_eq!(repo.rev("refs/heads/main").as_deref(), Some(c2.as_str()), "main should not have moved");

    // DATA-SAFETY: U must NOT be orphaned — object still present AND pinned
    // (enumerable) under refs/gitgui/deleted/*.
    assert!(repo.obj_exists(&u_sha), "unique commit U was orphaned (object gone)!");
    assert!(
        deleted_shas(&repo).contains(&u_sha),
        "unique commit U not pinned/enumerable under refs/gitgui/deleted/*"
    );

    // undo-of-undo: the sealed snapshot from this undo restores tmpwork@U.
    let u2 = undo(&repo.open()).expect("undo-of-undo");
    assert!(u2.ok, "undo-of-undo failed: {}", u2.message);
    assert_eq!(
        repo.rev("refs/heads/tmpwork").as_deref(),
        Some(u_sha.as_str()),
        "undo-of-undo did not restore tmpwork@U"
    );
}

#[test]
fn undo_restores_a_moved_branchs_old_position() {
    let (repo, [_c0, c1, c2]) = setup("safety_move");
    repo.must(&["branch", "feature", &c1]); // feature @ c1

    let s = snapshot(&repo.open()).expect("snapshot");
    assert!(s.starts_with("refs/gitgui/backup/"));

    repo.must(&["update-ref", "refs/heads/feature", &c2]); // move feature c1 -> c2
    assert_eq!(repo.rev("refs/heads/feature").as_deref(), Some(c2.as_str()), "precondition feature@c2");

    let u = undo(&repo.open()).expect("undo");
    assert!(u.ok, "undo failed: {}", u.message);
    assert_eq!(repo.rev("refs/heads/feature").as_deref(), Some(c1.as_str()), "feature not moved back to c1");
    assert_eq!(repo.rev("refs/heads/main").as_deref(), Some(c2.as_str()), "main should not have moved");
}

#[test]
fn undo_restores_a_renamed_branchs_old_name_and_drops_the_new_one() {
    let (repo, [_c0, c1, _c2]) = setup("safety_rename");
    repo.must(&["branch", "feature", &c1]);

    let s = snapshot(&repo.open()).expect("snapshot");
    assert!(s.starts_with("refs/gitgui/backup/"));

    repo.must(&["branch", "-m", "feature", "feat2"]); // rename feature -> feat2
    assert!(repo.rev("refs/heads/feature").is_none() && repo.rev("refs/heads/feat2").is_some(), "precondition renamed");

    let u = undo(&repo.open()).expect("undo");
    assert!(u.ok, "undo failed: {}", u.message);
    assert_eq!(repo.rev("refs/heads/feature").as_deref(), Some(c1.as_str()), "old name 'feature' not restored");
    assert!(repo.rev("refs/heads/feat2").is_none(), "renamed 'feat2' not removed");
}
