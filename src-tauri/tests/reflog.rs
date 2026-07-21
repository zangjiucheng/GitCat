//! Reflog rescue (M4): index -> sha mapping correctness (the classic
//! off-by-one trap), restore-to-a-historical-entry, and the two refusal
//! paths (dirty tree, stale/out-of-range index).

mod common;

use common::TempRepo;
use gitcat_lib::reflog::reflog;
use gitcat_lib::safety::snapshots;

/// Three commits on `main`, then a detach to c1, a checkout back onto `main`
/// (@ c2), then `reset --hard` back to c1 — six distinct HEAD-moving ops in
/// total, exercising commit / checkout / reset reflog message shapes.
/// Returns `(repo, [c0, c1, c2])`; after this, HEAD is on `main` @ c1.
fn build(tag: &str) -> (TempRepo, [String; 3]) {
    let repo = TempRepo::init(tag);
    let c0 = repo.commit("f.txt", "0\n", "c0");
    let c1 = repo.commit("f.txt", "1\n", "c1");
    let c2 = repo.commit("f.txt", "2\n", "c2");
    repo.must(&["checkout", "-q", &c1]); // detach HEAD at c1
    repo.must(&["checkout", "-q", "main"]); // back onto main (currently @ c2)
    repo.must(&["reset", "--hard", &c1]); // main rewound to c1 (the "oops")
    (repo, [c0, c1, c2])
}

/// `git log -g --format=%H HEAD` walks the reflog in exactly `HEAD@{0}, {1},
/// …` order — the ground truth we cross-check our own index -> sha mapping
/// against.
fn reflog_shas_via_git(repo: &TempRepo) -> Vec<String> {
    repo.must(&["log", "-g", "--format=%H", "HEAD"])
        .lines()
        .map(|l| l.to_string())
        .collect()
}

#[test]
fn index_to_sha_mapping_matches_git_reflog_show_head() {
    let (repo, [c0, c1, c2]) = build("reflog_map");
    let path = repo.path();

    let expected = reflog_shas_via_git(&repo);
    // 6 ops: reset, checkout(->main), checkout(->c1), commit c2, commit c1,
    // commit(initial) c0.
    assert_eq!(expected.len(), 6, "expected 6 reflog entries, git shows: {expected:?}");
    assert_eq!(expected[0], c1, "HEAD@{{0}} should be the reset target c1");
    assert_eq!(expected[1], c2, "HEAD@{{1}} should be main's tip c2 (checkout back)");
    assert_eq!(expected[2], c1, "HEAD@{{2}} should be the detach target c1");
    assert_eq!(expected[3], c2, "HEAD@{{3}} should be commit c2");
    assert_eq!(expected[4], c1, "HEAD@{{4}} should be commit c1");
    assert_eq!(expected[5], c0, "HEAD@{{5}} should be the initial commit c0");

    let entries = tauri::async_runtime::block_on(reflog(path)).expect("reflog() failed");
    assert_eq!(entries.len(), expected.len());

    for (i, exp_full) in expected.iter().enumerate() {
        let e = &entries[i];
        assert_eq!(e.index, i);
        assert_eq!(e.sha, common::short(exp_full), "HEAD@{{{i}}} sha mismatch (off-by-one against id_new()?)");
    }

    // Best-effort `kind` classification: spot-check a few well-known shapes.
    assert_eq!(entries[0].kind, "reset", "entries[0].message = {:?}", entries[0].message);
    assert_eq!(entries[1].kind, "checkout", "entries[1].message = {:?}", entries[1].message);
    assert_eq!(entries[3].kind, "commit", "entries[3].message = {:?}", entries[3].message);
    assert_eq!(entries[5].kind, "commit", "entries[5].message = {:?}", entries[5].message);
}

#[test]
fn restore_lands_on_the_expected_sha_and_seals_a_new_snapshot() {
    let (repo, [_c0, c1, c2]) = build("reflog_restore_ok");
    let path = repo.path();

    // Precondition: build() left HEAD on main @ c1 (the "oops" state).
    assert_eq!(repo.rev("HEAD").as_deref(), Some(c1.as_str()));
    assert!(repo.is_clean());

    let before = snapshots(&repo.open()).expect("snapshots").len();

    // HEAD@{1} is c2 (see the mapping test above) — restore the "lost" tip.
    let res = tauri::async_runtime::block_on(gitcat_lib::reflog::reflog_restore(path.clone(), 1));
    assert!(res.ok, "reflog_restore failed: {}", res.message);
    assert_eq!(res.restored_to.as_deref(), Some(common::short(&c2).as_str()));
    assert!(res.sealed.as_deref().unwrap_or("").starts_with("refs/gitgui/backup/"));

    assert_eq!(repo.rev("HEAD").as_deref(), Some(c2.as_str()), "HEAD did not land on c2");
    assert_eq!(repo.current_branch(), "main", "restore must not detach HEAD from main");
    assert!(repo.is_clean(), "tree not clean after restore");
    assert_eq!(repo.read("f.txt"), "2\n");

    // The restore itself sealed exactly one new backup (undo-is-undoable).
    let after = snapshots(&repo.open()).expect("snapshots");
    assert_eq!(after.len(), before + 1, "restore should seal exactly one new snapshot");
    assert_eq!(after[0].sha, common::short(&c1), "the new seal should pin the PRE-restore HEAD (c1)");
}

#[test]
fn restore_refuses_on_a_dirty_working_tree() {
    let (repo, [_c0, c1, _c2]) = build("reflog_restore_dirty");
    let path = repo.path();
    let before = snapshots(&repo.open()).expect("snapshots").len();

    // Dirty the tree without committing.
    std::fs::write(repo.dir.join("f.txt"), "dirty, uncommitted\n").expect("write");
    assert!(!repo.is_clean());

    let res = tauri::async_runtime::block_on(gitcat_lib::reflog::reflog_restore(path.clone(), 1));
    assert!(!res.ok, "restore should refuse on a dirty tree");
    assert!(
        res.message.to_lowercase().contains("uncommitted") || res.message.to_lowercase().contains("clean"),
        "message should explain the dirty-tree refusal: {}",
        res.message
    );
    assert!(res.sealed.is_none(), "a refused restore must not have sealed a snapshot");

    // Nothing moved, nothing was sealed, and the dirty content survives.
    assert_eq!(repo.rev("HEAD").as_deref(), Some(c1.as_str()));
    assert_eq!(repo.read("f.txt"), "dirty, uncommitted\n");
    let after = snapshots(&repo.open()).expect("snapshots");
    assert_eq!(after.len(), before, "a refused restore must not seal a snapshot");
}

#[test]
fn restore_refuses_a_stale_out_of_range_index() {
    let (repo, [_c0, c1, _c2]) = build("reflog_restore_range");
    let path = repo.path();
    let before = snapshots(&repo.open()).expect("snapshots").len();

    let len = tauri::async_runtime::block_on(reflog(path.clone())).expect("reflog() failed").len();
    let res = tauri::async_runtime::block_on(gitcat_lib::reflog::reflog_restore(path.clone(), len)); // one past the end
    assert!(!res.ok, "restore should refuse an out-of-range index");
    assert!(res.restored_to.is_none());
    assert!(res.sealed.is_none(), "an out-of-range restore must not seal a snapshot first");

    // Nothing moved, nothing was sealed.
    assert_eq!(repo.rev("HEAD").as_deref(), Some(c1.as_str()));
    let after = snapshots(&repo.open()).expect("snapshots");
    assert_eq!(after.len(), before, "a refused restore must not seal a snapshot");
}
