//! Branch ops + global undo (model after examples/m2check.rs).
//!
//! Drives create_branch / checkout / rename_branch / delete_branch / list_refs
//! and create_snapshot / list_snapshots / undo_last, and asserts the safety
//! guardrails: refuse deleting the CURRENT branch, refuse undo on a dirty tree
//! (fail-closed), and that undo actually restores HEAD's sha.

mod common;

use common::{short, TempRepo};
use gitcat_lib::git_write::{checkout, create_branch, delete_branch, list_refs, rename_branch};
use gitcat_lib::safety::{create_snapshot, list_snapshots, undo_last};

#[test]
fn list_refs_reports_current_branch_and_tip() {
    let repo = TempRepo::init("branch_ops_list");
    let c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();

    let refs = list_refs(path).expect("list_refs failed");
    assert_eq!(refs.head.as_deref(), Some("main"));
    assert_eq!(refs.locals.len(), 1);
    assert_eq!(refs.locals[0].name, "main");
    assert_eq!(refs.locals[0].sha, c0);
}

#[test]
fn create_checkout_delete_and_rename_branch() {
    let repo = TempRepo::init("branch_ops_crud");
    let _c0 = repo.commit("f.txt", "0\n", "c0");
    let c1 = repo.commit("f.txt", "1\n", "c1");
    let path = repo.path();

    // create + switch to a new branch at HEAD.
    let created = create_branch(path.clone(), "feature".into(), None, Some(true));
    assert!(created.ok, "create_branch failed: {}", created.message);
    assert!(created.backup_ref.is_some(), "create_branch should snapshot first");

    let refs = list_refs(path.clone()).unwrap();
    assert_eq!(refs.head.as_deref(), Some("feature"));
    assert!(refs.locals.iter().any(|b| b.name == "feature" && b.sha == c1));

    // Refuse deleting the CURRENT branch.
    let refused = delete_branch(path.clone(), "feature".into(), false);
    assert!(!refused.ok, "expected delete of current branch to be refused");
    assert!(
        refused.message.to_lowercase().contains("current branch"),
        "unexpected refusal message: {}",
        refused.message
    );
    // A refused (never-attempted) mutation must not have snapshotted.
    assert!(refused.backup_ref.is_none());

    // Switch back to main, then delete feature (no longer current, and fully
    // merged since it never diverged from main).
    let co = checkout(path.clone(), "main".into());
    assert!(co.ok, "checkout failed: {}", co.message);
    assert_eq!(list_refs(path.clone()).unwrap().head.as_deref(), Some("main"));

    let deleted = delete_branch(path.clone(), "feature".into(), false);
    assert!(deleted.ok, "delete_branch failed: {}", deleted.message);
    assert!(repo.rev("refs/heads/feature").is_none());

    // Create another branch and rename it.
    let cb = create_branch(path.clone(), "temp".into(), None, Some(false));
    assert!(cb.ok, "create_branch(temp) failed: {}", cb.message);
    let rn = rename_branch(path.clone(), "temp".into(), "temp2".into());
    assert!(rn.ok, "rename_branch failed: {}", rn.message);
    assert!(repo.rev("refs/heads/temp").is_none(), "old name should be gone");
    assert!(repo.rev("refs/heads/temp2").is_some(), "new name should exist");
}

#[test]
fn undo_refuses_on_dirty_tree_and_restores_head_when_clean() {
    let repo = TempRepo::init("branch_ops_undo");
    let _c0 = repo.commit("f.txt", "0\n", "c0");
    let c1 = repo.commit("f.txt", "1\n", "c1");
    let path = repo.path();

    // Snapshot HEAD@c1 (this is what undo will rewind to).
    let snap = create_snapshot(path.clone()).expect("create_snapshot failed");
    assert_eq!(snap.sha, short(&c1));
    let snaps_before = list_snapshots(path.clone()).expect("list_snapshots failed");
    assert!(snaps_before.iter().any(|s| s.reference == snap.reference));

    // Move HEAD forward without going through GitCat (so no further snapshot
    // is recorded) — the newest snapshot is still `snap`, pointing at c1.
    let c2 = repo.commit("f.txt", "2\n", "c2");
    assert_eq!(repo.rev("refs/heads/main").as_deref(), Some(c2.as_str()));

    // Dirty the working tree: undo must refuse (fail-closed), never force.
    std::fs::write(repo.dir.join("f.txt"), "dirty, uncommitted\n").unwrap();
    let refused = undo_last(path.clone()).expect("undo_last failed");
    assert!(!refused.ok, "undo should refuse on a dirty tree");
    assert!(
        refused.message.to_lowercase().contains("uncommitted")
            || refused.message.to_lowercase().contains("dirty")
            || refused.message.to_lowercase().contains("clean"),
        "unexpected refusal message: {}",
        refused.message
    );
    assert!(refused.restored_to.is_none());
    // HEAD must not have moved.
    assert_eq!(repo.rev("refs/heads/main").as_deref(), Some(c2.as_str()));

    // Clean the tree back up, then undo should succeed and actually restore
    // HEAD's sha to the snapshotted commit (c1).
    repo.must(&["checkout", "--", "f.txt"]);
    assert!(repo.is_clean());

    let undone = undo_last(path.clone()).expect("undo_last failed");
    assert!(undone.ok, "undo failed: {}", undone.message);
    assert_eq!(undone.restored_to.as_deref(), Some(short(&c1).as_str()));
    assert_eq!(
        repo.rev("refs/heads/main").as_deref(),
        Some(c1.as_str()),
        "HEAD sha was not actually restored to the snapshotted commit"
    );
    assert_eq!(repo.read("f.txt"), "1\n", "working tree not restored to c1's content");
    assert!(repo.is_clean());

    // undo is itself undoable: it should have sealed the pre-undo state (c2)
    // as a new snapshot before rewinding.
    let snaps_after = list_snapshots(path.clone()).expect("list_snapshots failed");
    assert!(snaps_after.len() > snaps_before.len(), "undo should add a sealing snapshot");
}
