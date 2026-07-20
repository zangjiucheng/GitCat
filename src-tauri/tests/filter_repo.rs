//! Filter-repo wizard (M5c) integration tests. Drives the REAL git-filter-repo
//! binary against throwaway temp repos — never mocked. This is the regression
//! test for the gap a prior review found: a restore that only reconstructed
//! refs/heads + refs/tags and silently dropped anything else (e.g. a second
//! branch that isn't checked out, or in general any other ref namespace).

mod common;

use common::TempRepo;
use gitcat_lib::filter_repo::{
    filter_repo_list_backups, filter_repo_preview, filter_repo_restore, filter_repo_run,
};

/// Build a repo with a "secret.txt" path present in some commits, a second
/// branch, AND a tag — so a restore has multiple ref namespaces to recover,
/// not just the current branch.
fn build_repo(tag: &str) -> TempRepo {
    let repo = TempRepo::init(tag);
    repo.commit("keep.txt", "hello\n", "c0: add keep.txt");
    repo.commit("secret.txt", "sk-super-secret\n", "c1: add secret.txt");
    repo.commit("keep.txt", "hello again\n", "c2: update keep.txt");
    repo.commit("secret.txt", "sk-super-secret-v2\n", "c3: update secret.txt");
    // A second branch NOT checked out, so restore must recreate it even
    // though it isn't the current branch or reachable via a simple checkout.
    repo.must(&["branch", "sidework"]);
    // An annotated tag, another ref namespace besides refs/heads.
    repo.must(&["tag", "-a", "v1", "-m", "v1"]);
    repo
}

#[test]
fn preview_reports_real_counts() {
    let repo = build_repo("fr_preview");
    let path = repo.path();

    let preview = tauri::async_runtime::block_on(filter_repo_preview(path.clone(), vec!["secret.txt".to_string()], false))
        .expect("filter_repo_preview failed");

    assert!(preview.available, "git-filter-repo should be detected as available on this machine");
    assert_eq!(preview.current_branch, "main");
    assert_eq!(preview.total_commits, 4, "expected 4 commits total");
    assert_eq!(preview.touched_commits, 2, "expected 2 commits touching secret.txt (c1, c3)");
}

#[test]
fn run_removes_path_from_history_and_restore_recovers_every_ref() {
    let repo = build_repo("fr_run_restore");
    let path = repo.path();

    // Record ground truth BEFORE filter-repo ever runs.
    let main_before = repo.rev("refs/heads/main").expect("main should resolve");
    let sidework_before = repo.rev("refs/heads/sidework").expect("sidework should resolve");
    let tag_before = repo.rev("refs/tags/v1").expect("tag should resolve");
    assert_eq!(repo.current_branch(), "main");

    // ---- run ---------------------------------------------------------
    let result = tauri::async_runtime::block_on(filter_repo_run(path.clone(), vec!["secret.txt".to_string()], true));
    assert!(result.ok, "filter_repo_run failed: {}", result.message);
    assert!(result.backup_bundle.is_some(), "a backup bundle path should be reported");
    assert_eq!(result.commits_before, Some(4));
    let bundle_path = result.backup_bundle.clone().unwrap();
    assert!(std::path::Path::new(&bundle_path).exists(), "backup bundle file should exist on disk");

    // secret.txt must be genuinely gone from history everywhere.
    let (ok, out, _) = repo.git(&["log", "--all", "--oneline", "--", "secret.txt"]);
    assert!(ok, "git log --all -- secret.txt should succeed");
    assert!(out.is_empty(), "secret.txt should be fully purged from history, got: {out:?}");

    assert!(repo.is_clean(), "working tree should be clean after filter-repo");
    assert!(repo.rev("HEAD").is_some(), "HEAD should resolve after filter-repo");

    // Hashes MUST have changed (that's the whole point of filter-repo).
    let main_after_filter = repo.rev("refs/heads/main").expect("main should still resolve");
    assert_ne!(main_before, main_after_filter, "filter-repo should have rewritten commit hashes");

    // ---- list_backups --------------------------------------------------
    let backups = filter_repo_list_backups(path.clone()).expect("filter_repo_list_backups failed");
    assert_eq!(backups.len(), 1, "expected exactly one backup recorded");
    let backup = &backups[0];
    assert_eq!(backup.bundle_path, bundle_path);
    assert!(backup.ref_count >= 3, "backup should have captured at least main/sidework/v1, got {}", backup.ref_count);

    // ---- restore ---------------------------------------------------------
    let restore = tauri::async_runtime::block_on(filter_repo_restore(path.clone(), backup.id.clone()));
    assert!(restore.ok, "filter_repo_restore failed: {}", restore.message);

    // EVERY original ref must be back to its EXACT pre-rewrite sha — not just
    // the current branch. This is the regression check for the "only
    // refs/heads+refs/tags" gap.
    assert_eq!(repo.rev("refs/heads/main").as_deref(), Some(main_before.as_str()), "main not restored to its exact original sha");
    assert_eq!(repo.rev("refs/heads/sidework").as_deref(), Some(sidework_before.as_str()), "sidework branch not restored (the ref-namespace gap regression)");
    assert_eq!(repo.rev("refs/tags/v1").as_deref(), Some(tag_before.as_str()), "tag not restored (the ref-namespace gap regression)");

    // The purged path must be reachable in history again.
    let (ok2, out2, _) = repo.git(&["log", "--all", "--oneline", "--", "secret.txt"]);
    assert!(ok2, "git log --all -- secret.txt should succeed post-restore");
    assert!(!out2.is_empty(), "secret.txt should be reachable in history again after restore");

    assert!(repo.is_clean(), "working tree should be clean after restore");
    assert_eq!(repo.current_branch(), "main", "HEAD should be back on main after restore");
    assert_eq!(repo.rev("HEAD").as_deref(), Some(main_before.as_str()), "HEAD sha should match the restored main tip");
}

/// Regression test for the "bare HEAD pseudo-line" bug a review found: `git
/// bundle list-heads` always emits an extra unprefixed `HEAD` line alongside
/// the real `refs/...` names. If that line were ever stored as a real ref,
/// restore's generic per-ref loop would run `git update-ref HEAD <stale-sha>`
/// — which dereferences symbolic HEAD and silently force-moves whatever
/// branch is CURRENTLY checked out, even one that never existed at backup
/// time. Build a repo, back it up (on `main`), THEN create a brand-new branch
/// that did not exist at backup time, check it out, and restore — the new
/// branch (and whatever it points to) must be completely untouched.
#[test]
fn restore_never_touches_a_branch_created_after_the_backup() {
    let repo = build_repo("fr_head_pseudo_line");
    let path = repo.path();

    // Back up (on main) without ever running filter-repo itself — the bug
    // lives in backup()'s ref parsing + restore()'s replay, not in filter-repo
    // proper, so a bare run_removes-nothing round trip already exercises it.
    let result = tauri::async_runtime::block_on(filter_repo_run(path.clone(), vec!["secret.txt".to_string()], true));
    assert!(result.ok, "filter_repo_run failed: {}", result.message);
    let backups = filter_repo_list_backups(path.clone()).expect("filter_repo_list_backups failed");
    let backup_id = backups[0].id.clone();

    // A branch created AFTER the backup — absent from manifest.refs entirely.
    repo.must(&["checkout", "-q", "-b", "feature"]);
    let feature_sha = repo.commit("feature.txt", "new work\n", "feature: add feature.txt");
    assert_eq!(repo.current_branch(), "feature");

    let restore = tauri::async_runtime::block_on(filter_repo_restore(path.clone(), backup_id));
    assert!(restore.ok, "filter_repo_restore failed: {}", restore.message);

    // The never-backed-up branch must be COMPLETELY untouched — same sha,
    // still resolvable, its content still present. This is the exact
    // scenario the "HEAD" pseudo-line bug corrupts if not filtered out.
    assert_eq!(
        repo.rev("refs/heads/feature").as_deref(),
        Some(feature_sha.as_str()),
        "a branch created AFTER the backup must be completely untouched by restore"
    );
    assert!(repo.obj_exists(&feature_sha), "the post-backup commit must still be reachable");
}

#[test]
fn run_refuses_on_dirty_tree() {
    let repo = build_repo("fr_dirty");
    let path = repo.path();
    std::fs::write(repo.dir.join("keep.txt"), "dirty, uncommitted\n").unwrap();

    let result = tauri::async_runtime::block_on(filter_repo_run(path.clone(), vec!["secret.txt".to_string()], true));
    assert!(!result.ok, "filter_repo_run should refuse on a dirty tree");
    assert!(
        result.message.to_lowercase().contains("uncommitted") || result.message.to_lowercase().contains("clean"),
        "unexpected refusal message: {}",
        result.message
    );
    assert!(result.backup_bundle.is_none(), "no backup should be created when refused before backup");

    // No backups should have been recorded.
    let backups = filter_repo_list_backups(path.clone()).expect("filter_repo_list_backups failed");
    assert!(backups.is_empty(), "dirty-tree refusal must happen before any backup is made");
}

#[test]
fn run_refuses_on_empty_scope() {
    let repo = build_repo("fr_empty_scope");
    let path = repo.path();

    let result = tauri::async_runtime::block_on(filter_repo_run(path.clone(), vec![], false));
    assert!(!result.ok, "filter_repo_run should refuse an empty path scope");

    let result2 = tauri::async_runtime::block_on(filter_repo_run(path.clone(), vec!["".to_string()], false));
    assert!(!result2.ok, "filter_repo_run should refuse an empty-string path entry");
}

#[test]
fn list_backups_empty_before_any_run() {
    let repo = build_repo("fr_list_empty");
    let path = repo.path();
    let backups = filter_repo_list_backups(path).expect("filter_repo_list_backups failed");
    assert!(backups.is_empty(), "no backups should exist before any filter_repo_run");
}
