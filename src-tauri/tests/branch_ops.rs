//! Branch ops + global undo (model after examples/m2check.rs).
//!
//! Drives create_branch / checkout / rename_branch / delete_branch / list_refs
//! and create_snapshot / list_snapshots / undo_last, and asserts the safety
//! guardrails: refuse deleting the CURRENT branch, refuse undo on a dirty tree
//! (fail-closed), and that undo actually restores HEAD's sha.

mod common;

use common::{short, TempRepo};
use gitcat_lib::git_write::{branch_merge_status, checkout, create_branch, delete_branch, list_refs, rename_branch};
use gitcat_lib::safety::{create_snapshot, list_snapshots, undo_last};

#[test]
fn list_refs_reports_current_branch_and_tip() {
    let repo = TempRepo::init("branch_ops_list");
    let c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();

    let refs = tauri::async_runtime::block_on(list_refs(path)).expect("list_refs failed");
    assert_eq!(refs.head.as_deref(), Some("main"));
    assert_eq!(refs.locals.len(), 1);
    assert_eq!(refs.locals[0].name, "main");
    assert_eq!(refs.locals[0].sha, c0);
    // No remote configured at all — ahead/behind/upstream must all be None
    // together, never independently (see LocalBranch's own doc comment).
    assert_eq!(refs.locals[0].upstream, None);
    assert_eq!(refs.locals[0].ahead, None);
    assert_eq!(refs.locals[0].behind, None);
}

/// Regression/coverage test for `LocalBranch.last_commit_time` — added so
/// sidebar.svelte.ts's Auto-mode filter can also hide a STALE unmerged
/// branch (see that field's own doc comment). TempRepo::commit fixes
/// GIT_AUTHOR_DATE/GIT_COMMITTER_DATE to a constant ("2026-01-01T00:00:00Z",
/// see common/mod.rs) specifically so this is a deterministic, exact-value
/// assertion rather than a loose "is it roughly now" sanity check.
#[test]
fn list_refs_reports_the_branch_tips_own_commit_time() {
    let repo = TempRepo::init("branch_ops_commit_time");
    repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();

    let refs = tauri::async_runtime::block_on(list_refs(path)).expect("list_refs failed");
    assert_eq!(refs.locals.len(), 1);
    // 2026-01-01T00:00:00Z in unix seconds — every TempRepo commit shares
    // this fixed author/committer date (see common/mod.rs's own doc comment).
    assert_eq!(refs.locals[0].last_commit_time, 1_767_225_600);
}

/// Regression/coverage test for `LocalBranch.upstream` (the topbar branch
/// pill's hover-detail field): a branch WITH a configured upstream reports
/// that upstream's own full shorthand (e.g. "origin/main"), alongside
/// ahead/behind counts computed relative to it. Mirrors remote_ops.rs's own
/// bare-remote + second-clone pattern (duplicated here per this codebase's
/// convention of not sharing test helpers across independent test binaries).
#[test]
fn list_refs_reports_the_configured_upstream_alongside_ahead_behind() {
    let bare = common::TempRepo::init_bare("branch_ops_upstream_bare");
    let bare_path = bare.path();

    let local = common::TempRepo::init("branch_ops_upstream_local");
    let _c0 = local.commit("f.txt", "0\n", "c0");
    local.must(&["remote", "add", "origin", &bare_path]);
    local.must(&["push", "-q", "-u", "origin", "main"]);

    // "Someone else" pushes a commit straight to the bare remote — makes
    // local's main "behind" without local ever fetching/merging it itself.
    let other = common::TempRepo::init("branch_ops_upstream_other");
    other.must(&["remote", "add", "origin", &bare_path]);
    other.must(&["fetch", "-q", "origin", "main"]);
    other.must(&["checkout", "-q", "-B", "main", "origin/main"]);
    other.commit("g.txt", "0\n", "remote-only commit");
    other.must(&["push", "-q", "origin", "main"]);

    local.must(&["fetch", "-q", "origin"]);
    // Local-only commit, on top of fetching the above — diverged both ways now.
    local.commit("f.txt", "1\n", "local-only commit");

    let refs = tauri::async_runtime::block_on(list_refs(local.path())).expect("list_refs failed");
    let main = refs.locals.iter().find(|b| b.name == "main").expect("main branch missing");
    assert_eq!(main.upstream.as_deref(), Some("origin/main"));
    assert_eq!(main.ahead, Some(1));
    assert_eq!(main.behind, Some(1));
}

#[test]
fn create_checkout_delete_and_rename_branch() {
    let repo = TempRepo::init("branch_ops_crud");
    let _c0 = repo.commit("f.txt", "0\n", "c0");
    let c1 = repo.commit("f.txt", "1\n", "c1");
    let path = repo.path();

    // create + switch to a new branch at HEAD.
    let created = tauri::async_runtime::block_on(create_branch(path.clone(), "feature".into(), None, Some(true)));
    assert!(created.ok, "create_branch failed: {}", created.message);
    assert!(created.backup_ref.is_some(), "create_branch should snapshot first");

    let refs = tauri::async_runtime::block_on(list_refs(path.clone())).unwrap();
    assert_eq!(refs.head.as_deref(), Some("feature"));
    assert!(refs.locals.iter().any(|b| b.name == "feature" && b.sha == c1));

    // Refuse deleting the CURRENT branch.
    let refused = tauri::async_runtime::block_on(delete_branch(path.clone(), "feature".into(), false));
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
    let co = tauri::async_runtime::block_on(checkout(path.clone(), "main".into()));
    assert!(co.ok, "checkout failed: {}", co.message);
    assert_eq!(tauri::async_runtime::block_on(list_refs(path.clone())).unwrap().head.as_deref(), Some("main"));

    let deleted = tauri::async_runtime::block_on(delete_branch(path.clone(), "feature".into(), false));
    assert!(deleted.ok, "delete_branch failed: {}", deleted.message);
    assert!(repo.rev("refs/heads/feature").is_none());

    // Create another branch and rename it.
    let cb = tauri::async_runtime::block_on(create_branch(path.clone(), "temp".into(), None, Some(false)));
    assert!(cb.ok, "create_branch(temp) failed: {}", cb.message);
    let rn = tauri::async_runtime::block_on(rename_branch(path.clone(), "temp".into(), "temp2".into()));
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

// ---------------------------------------------------------------------------
// branch_merge_status (backs the sidebar's "Auto" branch-visibility mode)
// ---------------------------------------------------------------------------

#[test]
fn merged_branch_is_reported_merged_unmerged_branch_is_not() {
    let repo = TempRepo::init("merge_status_basic");
    repo.commit("f.txt", "0\n", "c0");
    repo.must(&["checkout", "-q", "-b", "feature-merged"]);
    repo.commit("f.txt", "1\n", "feature work");
    repo.must(&["checkout", "-q", "main"]);
    repo.must(&["merge", "-q", "--no-ff", "feature-merged", "-m", "merge feature"]);

    repo.must(&["checkout", "-q", "-b", "feature-unmerged"]);
    repo.commit("f.txt", "2\n", "still in progress");
    repo.must(&["checkout", "-q", "main"]);

    let info = tauri::async_runtime::block_on(branch_merge_status(repo.path())).expect("branch_merge_status failed");
    assert_eq!(info.default_branch.as_deref(), Some("main"));
    assert!(info.merged.contains(&"feature-merged".to_string()), "feature-merged should be reported merged");
    assert!(!info.merged.contains(&"feature-unmerged".to_string()), "feature-unmerged has commits main lacks — must not be reported merged");
    assert!(!info.merged.contains(&"main".to_string()), "the default branch itself must never appear in its own merged list");
}

/// Regression test for the "Auto still shows too many branches" report: a
/// squash-merged branch (GitHub/GitLab's own default "Squash and merge"
/// button) never becomes a literal ancestor of default — the squash commit
/// has different parents entirely — so a pure `graph_descendant_of` check
/// reported it "unmerged" forever, keeping it visible in Auto mode
/// indefinitely even though none of its work is missing. Fixed via a tree-
/// equality fallback: right after a squash-merge, the merge commit's tree is
/// byte-identical to the topic branch's own tip tree.
#[test]
fn squash_merged_branch_is_reported_merged_even_though_its_tip_is_not_a_literal_ancestor() {
    let repo = TempRepo::init("merge_status_squash");
    repo.commit("f.txt", "0\n", "c0");
    repo.must(&["checkout", "-q", "-b", "feature-squashed"]);
    repo.commit("f.txt", "1\n", "feature work one");
    repo.commit("f.txt", "2\n", "feature work two");
    repo.must(&["checkout", "-q", "main"]);
    repo.must(&["merge", "-q", "--squash", "feature-squashed"]);
    repo.must(&["commit", "-q", "-m", "squash-merge feature-squashed"]);

    let info = tauri::async_runtime::block_on(branch_merge_status(repo.path())).expect("branch_merge_status failed");
    assert!(
        info.merged.contains(&"feature-squashed".to_string()),
        "feature-squashed's tip tree is identical to main's new tip — its work is fully captured, should be reported merged"
    );
}

#[test]
fn resolves_default_branch_via_origin_head_symref_over_local_main_fallback() {
    let bare = common::TempRepo::init_bare("merge_status_origin_head_bare");
    let bare_path = bare.path();

    let repo = TempRepo::init("merge_status_origin_head_local");
    repo.commit("f.txt", "0\n", "c0");
    repo.must(&["branch", "-m", "main", "trunk"]); // rename main -> trunk
    repo.must(&["remote", "add", "origin", &bare_path]);
    repo.must(&["push", "-q", "-u", "origin", "trunk"]);
    repo.must(&["remote", "set-head", "origin", "trunk"]);
    // A LOCAL branch literally named "main" too, pointing at the SAME
    // commit — proves origin/HEAD's symref wins over the local-name
    // fallback rather than "trunk" just coincidentally being picked.
    repo.must(&["branch", "main"]);

    let info = tauri::async_runtime::block_on(branch_merge_status(repo.path())).expect("branch_merge_status failed");
    assert_eq!(info.default_branch.as_deref(), Some("trunk"), "origin/HEAD's symbolic target should win over the main/master fallback");
}

#[test]
fn falls_back_to_local_main_when_no_remote_is_configured() {
    let repo = TempRepo::init("merge_status_fallback_main");
    repo.commit("f.txt", "0\n", "c0");

    let info = tauri::async_runtime::block_on(branch_merge_status(repo.path())).expect("branch_merge_status failed");
    assert_eq!(info.default_branch.as_deref(), Some("main"), "no remote configured — should fall back to the local 'main' branch");
}

#[test]
fn no_default_branch_resolvable_returns_none_and_an_empty_merged_list() {
    let repo = TempRepo::init("merge_status_no_default");
    repo.commit("f.txt", "0\n", "c0");
    repo.must(&["branch", "-m", "main", "trunk"]); // rename away from main/master; no remote configured either

    let info = tauri::async_runtime::block_on(branch_merge_status(repo.path())).expect("branch_merge_status failed");
    assert_eq!(info.default_branch, None, "no origin/HEAD and no main/master branch — nothing to resolve");
    assert!(info.merged.is_empty(), "can't classify anything as merged without a default branch to compare against");
}
