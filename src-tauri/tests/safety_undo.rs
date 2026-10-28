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
use gitcat_lib::safety::{snapshot, undo, undo_stashing};

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

// undo_stashing: a plain undo refuses on a dirty tree; the stashing variant
// keeps the uncommitted changes across the undo (stash -> undo -> pop).
#[test]
fn undo_stashing_keeps_uncommitted_changes_across_the_undo() {
    let (repo, [_c0, _c1, c2]) = setup("undo-stash");
    snapshot(&repo.open()).expect("snapshot"); // captures {main: c2}
    // Move main forward — undo will rewind it back to c2.
    repo.commit("f.txt", "3\n", "c3");
    assert_ne!(repo.must(&["rev-parse", "HEAD"]), c2, "precondition: HEAD moved off c2");

    // Dirty the tree with an UNRELATED file so the pop can't conflict with the
    // reset --hard that undo performs on f.txt.
    std::fs::write(repo.dir.join("notes.txt"), "my uncommitted work\n").unwrap();

    // A plain undo must refuse (and not mutate) while the tree is dirty.
    let refused = undo(&repo.open()).expect("undo");
    assert!(!refused.ok, "plain undo must refuse a dirty tree");
    assert_ne!(repo.must(&["rev-parse", "HEAD"]), c2, "refused undo must not have moved HEAD");

    // The stashing variant succeeds: rewinds to c2 AND keeps the change.
    let u = undo_stashing(&repo.open()).expect("undo_stashing");
    assert!(u.ok, "undo_stashing should succeed: {}", u.message);
    assert_eq!(repo.must(&["rev-parse", "HEAD"]), c2, "should have rewound main to c2");
    assert_eq!(repo.read("notes.txt"), "my uncommitted work\n", "uncommitted change must be re-applied, not lost");
    assert!(repo.must(&["stash", "list"]).is_empty(), "stash should have been popped, not left behind");
}

// B6: the undo line's headBefore held the seal's REF NAME, while every other
// line (and the 2.0 importer) expects the sha HEAD was at.
#[test]
fn undo_oplog_line_records_head_before_as_a_sha() {
    let (repo, [_c0, c1, c2]) = setup("safety_undo_head_before");
    snapshot(&repo.open()).expect("snapshot"); // pins c2
    repo.must(&["reset", "--hard", &c1]);

    let u = undo(&repo.open()).expect("undo");
    assert!(u.ok, "undo failed: {}", u.message);

    let log = std::fs::read_to_string(repo.open().path().join("gitgui").join("oplog.jsonl")).expect("oplog");
    let line = log.lines().rev().find(|l| l.contains("\"op\":\"undo\"")).expect("an undo line");
    let v: serde_json::Value = serde_json::from_str(line).unwrap();
    assert_eq!(v["headBefore"].as_str(), Some(c1.as_str()), "headBefore must be the sha HEAD was at");
    assert_eq!(v["headAfter"].as_str(), Some(c2.as_str()));
    assert!(v["backupRef"].as_str().unwrap_or("").starts_with("refs/gitgui/backup/"));
}
