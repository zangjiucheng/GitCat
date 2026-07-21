//! Rebase + conflict resolver (model after tests/merge.rs / tests/cherry_pick.rs).
//!
//! Covers: a clean rebase with no conflicts; a single-conflict resolve ->
//! continue -> clean flow; and CRITICALLY a rebase with conflicts on TWO
//! commits in sequence, asserting that continuing past the first conflict
//! lands on the SECOND as "conflict" again (not falsely "clean") — this is
//! the regression guard for the empirically-tricky multi-conflict semantics
//! (see git_rebase.rs's module doc). Also covers rebase_start -> rebase_abort
//! (full restoration + idempotency) and rebase_skip (drop a conflicting
//! commit, assert it's gone from history and the rebase proceeds/concludes).
//!
//! The interactive-rebase suite further down covers: the planner's oldest-
//! first commit listing (including excluding merge commits); reorder/drop
//! (single + every commit)/squash/fixup, each asserted against the real
//! resulting history and working-tree content; the "editing" pause (clean
//! stop, amend-via-workdir_commit-then-continue, and abort-restores-original
//! state); a squash step that ITSELF conflicts (distinguishable from a clean
//! squash); a plain interactive pick conflict (matches linear rebase's own
//! conflict behavior); and the pre-flight refusals: a stale/mismatched todo,
//! a duplicate-sha todo whose SET still matches the fresh range (regression
//! guard — see git_rebase.rs's `rebase_interactive_start` doc comment), a
//! first row that's squash/fixup, and (freshness regression) that the actual
//! rebase always bases on `onto`'s resolved oid AT CALL TIME.

mod common;

use std::collections::HashSet;

use common::TempRepo;
use git2::RepositoryState;
use gitcat_lib::conflict::{conflict_status, resolve_conflict_file};
use gitcat_lib::git_rebase::{
    rebase_abort, rebase_continue, rebase_interactive_plan, rebase_interactive_start, rebase_skip,
    rebase_start, TodoItem,
};
use gitcat_lib::workdir::commit as workdir_commit;

/// Build a `TodoItem` list from a slice of `(sha, action)` pairs — a terser
/// spelling for tests than repeating the struct literal every time.
fn todo(items: &[(&str, &str)]) -> Vec<TodoItem> {
    items
        .iter()
        .map(|(sha, action)| TodoItem { sha: sha.to_string(), action: action.to_string() })
        .collect()
}

/// Builds a repo where `feature` has TWO commits, each adding its OWN
/// independent file (no conflicts, no shared lines) — the base fixture for
/// interactive-rebase tests that need a plannable multi-commit range without
/// any conflict noise (reorder/drop/squash/fixup). Returns
/// (repo, main_head_sha, c1_sha, c2_sha).
fn build_two_commit_feature(tag: &str) -> (TempRepo, String, String, String) {
    let repo = TempRepo::init(tag);
    let _base = repo.commit("base.txt", "base\n", "base");
    repo.must(&["branch", "feature"]);
    let main_head = repo.commit("main.txt", "main\n", "edit on main");
    repo.must(&["checkout", "-q", "feature"]);
    let c1 = repo.commit("one.txt", "one\n", "add one.txt");
    let c2 = repo.commit("two.txt", "two\n", "add two.txt");
    (repo, main_head, c1, c2)
}

/// Same shape as [`build_two_commit_feature`] but with THREE commits, for
/// tests that need a plan spanning more than two rows (plan ordering, the
/// duplicate-sha regression test).
fn build_three_commit_feature(tag: &str) -> (TempRepo, String, String, String, String) {
    let repo = TempRepo::init(tag);
    let _base = repo.commit("base.txt", "base\n", "base");
    repo.must(&["branch", "feature"]);
    let main_head = repo.commit("main.txt", "main\n", "edit on main");
    repo.must(&["checkout", "-q", "feature"]);
    let c1 = repo.commit("one.txt", "one\n", "add one.txt");
    let c2 = repo.commit("two.txt", "two\n", "add two.txt");
    let c3 = repo.commit("three.txt", "three\n", "add three.txt");
    (repo, main_head, c1, c2, c3)
}

/// Builds the fixture for a squash step that ITSELF conflicts: `c1` touches
/// an unrelated file (picks cleanly onto `main`), `c2` (to be squashed into
/// `c1`) edits the SAME shared file `main` independently edited — so the
/// squash's own internal cherry-pick of `c2` conflicts, distinct from the
/// clean-squash fixture above. Returns (repo, main_head_sha, c1_sha, c2_sha).
fn build_squash_conflict_feature(tag: &str) -> (TempRepo, String, String, String) {
    let repo = TempRepo::init(tag);
    let _base = repo.commit("shared.txt", "base\n", "base");
    repo.must(&["branch", "feature"]);
    let main_head = repo.commit("shared.txt", "main line\n", "edit on main");
    repo.must(&["checkout", "-q", "feature"]);
    let c1 = repo.commit("clean.txt", "feature clean\n", "feature: clean.txt edit");
    let c2 = repo.commit("shared.txt", "feature line\n", "feature: shared.txt edit");
    (repo, main_head, c1, c2)
}

/// Builds a repo shaped `root -> A -> (fork) -> {A2, S} -> merge -> A3` on
/// `main`, where `A2`/`S` are the two parallel-branch commits merged together
/// and `A3` is the sole commit after the merge — the fixture for asserting
/// the interactive planner silently drops merge commits (git's own default,
/// non-`-r` behavior). Returns (repo, root_sha, a_sha, a2_sha, s_sha, a3_sha,
/// merge_sha).
fn build_merge_in_range_repo(tag: &str) -> (TempRepo, String, String, String, String, String, String) {
    let repo = TempRepo::init(tag);
    let root = repo.commit("root.txt", "root\n", "root");
    let a = repo.commit("a.txt", "a\n", "A");
    repo.must(&["branch", "side"]);
    let a2 = repo.commit("a2.txt", "a2\n", "A2");
    repo.must(&["checkout", "-q", "side"]);
    let s = repo.commit("s.txt", "s\n", "S");
    repo.must(&["checkout", "-q", "main"]);
    repo.must(&["merge", "--no-ff", "-q", "-m", "merge side", "side"]);
    let merge_sha = repo.must(&["rev-parse", "HEAD"]);
    let a3 = repo.commit("a3.txt", "a3\n", "A3");
    (repo, root, a, a2, s, a3, merge_sha)
}

/// Builds a repo where `feature` has ONE commit that edits the same line of
/// the same file `main` also edited after the shared base — rebasing
/// `feature` onto `main` conflicts on that one commit.
/// Returns (repo, main_head_sha, feature_branch_original_tip_sha).
fn build_one_conflict_repo(tag: &str) -> (TempRepo, String, String) {
    let repo = TempRepo::init(tag);
    let _base = repo.commit("shared.txt", "base line\n", "base");
    repo.must(&["branch", "feature"]);

    let main_head = repo.commit("shared.txt", "main line\n", "edit on main");

    repo.must(&["checkout", "-q", "feature"]);
    let feature_tip = repo.commit("shared.txt", "feature line\n", "edit on feature");

    repo.must(&["checkout", "-q", "feature"]);
    assert_eq!(repo.rev("HEAD").as_deref(), Some(feature_tip.as_str()));

    (repo, main_head, feature_tip)
}

/// Builds a repo where `feature` has TWO commits, EACH editing a DIFFERENT
/// file that `main`'s single commit ALSO independently edited — rebasing
/// `feature` onto `main` conflicts on BOTH commits in sequence, one per file.
///
/// Two separate files (rather than two edits to the same file) are essential
/// here: resolving a conflict via "theirs" is a whole-file checkout, which
/// fully reconstructs the replayed commit's own tree for that file — so a
/// SECOND commit that keeps editing the SAME file would always find its
/// patch's preimage already restored (no second conflict). Decoupling the
/// edits onto independent files avoids that and produces two genuine,
/// independent conflicts. Returns (repo, main_head_sha).
fn build_two_conflict_repo(tag: &str) -> (TempRepo, String) {
    let repo = TempRepo::init(tag);
    repo.commit("a.txt", "base-a\n", "base a");
    let _base_b = repo.commit("b.txt", "base-b\n", "base b");
    repo.must(&["branch", "feature"]);

    // main edits BOTH files in one commit.
    std::fs::write(repo.dir.join("a.txt"), "main-a\n").expect("write a.txt");
    std::fs::write(repo.dir.join("b.txt"), "main-b\n").expect("write b.txt");
    repo.must(&["add", "-A"]);
    repo.must(&["commit", "-q", "--no-verify", "-m", "edit on main"]);
    let main_head = repo.must(&["rev-parse", "HEAD"]);

    // feature (branched before main's commit) edits each file in its OWN
    // commit: commit 1 touches only a.txt, commit 2 touches only b.txt.
    repo.must(&["checkout", "-q", "feature"]);
    repo.commit("a.txt", "feature-a\n", "feature edit 1 (a.txt)");
    repo.commit("b.txt", "feature-b\n", "feature edit 2 (b.txt)");

    (repo, main_head)
}

#[test]
fn rebase_clean_no_conflicts() {
    let repo = TempRepo::init("rebase_clean");
    let _base = repo.commit("f.txt", "base\n", "base");
    repo.must(&["branch", "feature"]);
    repo.must(&["checkout", "-q", "feature"]);
    let _f1 = repo.commit("g.txt", "feature file\n", "add g.txt on feature");
    repo.must(&["checkout", "-q", "main"]);
    let main_tip = repo.commit("h.txt", "main file\n", "add h.txt on main");
    let path = repo.path();

    repo.must(&["checkout", "-q", "feature"]);
    let out = tauri::async_runtime::block_on(rebase_start(path.clone(), "main".into()));
    assert!(out.ok, "expected a clean rebase, got: {}", out.message);
    assert_eq!(out.state, "clean");
    assert!(out.backup_ref.is_some(), "rebase_start should snapshot before mutating");
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    // feature's tip is now a new commit built on top of main's tip.
    let head = repo.rev("HEAD").unwrap();
    assert_ne!(head, main_tip, "rebase should have replayed feature's commit anew");
    let git2repo = repo.open();
    let head_commit = git2repo.head().unwrap().peel_to_commit().unwrap();
    let parent = head_commit.parent(0).unwrap();
    assert_eq!(parent.id().to_string(), main_tip, "rebased commit's parent should be main's tip");
    assert!(repo.is_clean());
    assert_eq!(repo.read("g.txt"), "feature file\n");
    assert_eq!(repo.read("h.txt"), "main file\n");
}

#[test]
fn rebase_already_up_to_date_is_empty_not_clean() {
    let repo = TempRepo::init("rebase_noop");
    let _base = repo.commit("f.txt", "base\n", "base");
    let head = repo.rev("HEAD").unwrap();
    let path = repo.path();

    // Rebasing HEAD onto itself is the simplest "nothing to do" case.
    let out = tauri::async_runtime::block_on(rebase_start(path.clone(), head.clone()));
    assert_eq!(out.state, "empty", "expected a benign no-op, got: {}", out.message);
    assert!(!out.ok);
    assert_eq!(repo.rev("HEAD").as_deref(), Some(head.as_str()));
    assert_eq!(repo.open().state(), RepositoryState::Clean);
}

/// Regression test for a real bug an adversarial review caught: with an
/// ambient `rebase.autoStash=true` (a real, non-default git convenience
/// setting), a dirty tree used to be silently autostashed rather than
/// refused up front — and if the autostash reapply itself then conflicted,
/// `rebase_continue`/`rebase_skip` would error ("no rebase in progress") and
/// `rebase_abort` would falsely report "clean" while leaving real conflict
/// markers behind. Fixed by always passing `--no-autostash` (see
/// rebase_start's own comment). This proves the CLI flag wins over the
/// config, not just that the default (unconfigured) case was already safe.
#[test]
fn rebase_refuses_a_dirty_tree_even_when_autostash_is_configured() {
    let repo = TempRepo::init("rebase_autostash_guard");
    let _base = repo.commit("f.txt", "base\n", "base");
    repo.must(&["branch", "feature"]);
    repo.must(&["checkout", "-q", "feature"]);
    repo.commit("g.txt", "feature file\n", "add g.txt on feature");
    repo.must(&["checkout", "-q", "main"]);
    repo.commit("h.txt", "main file\n", "add h.txt on main");
    repo.must(&["checkout", "-q", "feature"]);
    let path = repo.path();

    // Simulate the ambient convenience setting (repo-local is enough to prove
    // the CLI flag beats config; a user's real ~/.gitconfig works the same way).
    repo.must(&["config", "rebase.autoStash", "true"]);

    // Uncommitted edit to a tracked file — enough for plain git to refuse a
    // rebase outright unless autostash silently intervenes.
    std::fs::write(std::path::Path::new(&path).join("g.txt"), "dirty local edit\n").expect("write dirty file");

    let out = tauri::async_runtime::block_on(rebase_start(path.clone(), "main".into()));
    assert_eq!(out.state, "error", "expected an upfront refusal, got state {:?}: {}", out.state, out.message);
    assert!(!out.ok);
    assert!(out.blocked_by_local_changes, "expected blocked_by_local_changes=true: {}", out.message);
    assert!(out.backup_ref.is_some(), "rebase_start snapshots before running git, even on a refusal it caused");
    assert_eq!(repo.open().state(), RepositoryState::Clean, "no rebase should have started");
    assert_eq!(
        repo.read("g.txt"),
        "dirty local edit\n",
        "the user's uncommitted edit must be left exactly as-is, not autostashed away"
    );
    assert!(repo.must(&["stash", "list"]).is_empty(), "no autostash entry should have been created");
}

#[test]
fn rebase_one_conflict_resolve_theirs_then_continue() {
    let (repo, main_head, _feature_tip) = build_one_conflict_repo("rebase_one_conflict");
    let path = repo.path();

    let out = tauri::async_runtime::block_on(rebase_start(path.clone(), "main".into()));
    assert_eq!(out.state, "conflict", "expected a conflict, got: {}", out.message);
    assert!(!out.ok);
    assert_eq!(out.conflicted_files, vec!["shared.txt".to_string()]);
    assert!(out.backup_ref.is_some(), "rebase_start should snapshot before mutating");
    assert_eq!(repo.open().state(), RepositoryState::RebaseInteractive);

    let status = tauri::async_runtime::block_on(conflict_status(path.clone())).expect("conflict_status failed");
    assert!(status.in_progress);
    assert_eq!(status.op, "rebase");
    assert_eq!(status.files.len(), 1);
    let f = &status.files[0];
    assert_eq!(f.path, "shared.txt");
    assert_eq!(f.base, "base line");
    assert_eq!(f.ours, "main line");
    assert_eq!(f.theirs, "feature line");

    let resolved = tauri::async_runtime::block_on(resolve_conflict_file(path.clone(), "shared.txt".into(), "theirs".into()));
    assert!(resolved.ok, "resolve_conflict_file failed: {}", resolved.message);
    assert_eq!(resolved.remaining, 0);

    let cont = tauri::async_runtime::block_on(rebase_continue(path.clone()));
    assert!(cont.ok, "rebase_continue failed: {}", cont.message);
    assert_eq!(cont.state, "clean");

    assert_eq!(repo.read("shared.txt"), "feature line\n");
    let after = tauri::async_runtime::block_on(conflict_status(path.clone())).expect("conflict_status failed");
    assert!(!after.in_progress);
    assert_eq!(after.files.len(), 0);
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 1, "rebase_continue should conclude a normal (non-merge) commit");
    let parent = head.parent(0).unwrap();
    assert_eq!(parent.id().to_string(), main_head, "rebased commit's parent should be main's tip");
}

/// THE regression guard for the empirically-tricky multi-conflict semantics:
/// resolve the first conflicting commit, continue, and assert the state is
/// STILL "conflict" (the second commit), not falsely "clean" — then resolve
/// the second and continue to a real "clean".
#[test]
fn rebase_two_conflicts_in_sequence_continue_reports_conflict_then_clean() {
    let (repo, main_head) = build_two_conflict_repo("rebase_two_conflicts");
    let path = repo.path();

    let out = tauri::async_runtime::block_on(rebase_start(path.clone(), "main".into()));
    assert_eq!(out.state, "conflict", "expected first conflict, got: {}", out.message);
    assert_eq!(out.conflicted_files, vec!["a.txt".to_string()]);
    assert_eq!(repo.open().state(), RepositoryState::RebaseInteractive);

    // Resolve the FIRST conflicting commit (a.txt).
    let resolved1 = tauri::async_runtime::block_on(resolve_conflict_file(path.clone(), "a.txt".into(), "theirs".into()));
    assert!(resolved1.ok, "first resolve failed: {}", resolved1.message);
    assert_eq!(resolved1.remaining, 0);

    // Continue past it — this MUST land on the SECOND conflicting commit
    // (b.txt), reporting "conflict" again, not "clean".
    let cont1 = tauri::async_runtime::block_on(rebase_continue(path.clone()));
    assert_eq!(
        cont1.state, "conflict",
        "continuing past the first conflict should hit the SECOND conflicting commit, not report clean; message: {}",
        cont1.message
    );
    assert!(!cont1.ok);
    assert_eq!(cont1.conflicted_files, vec!["b.txt".to_string()]);
    assert_eq!(
        repo.open().state(),
        RepositoryState::RebaseInteractive,
        "repo should still be mid-rebase for the second conflict"
    );

    let status = tauri::async_runtime::block_on(conflict_status(path.clone())).expect("conflict_status failed");
    assert!(status.in_progress);
    assert_eq!(status.op, "rebase");
    assert_eq!(status.files.len(), 1);
    assert_eq!(status.files[0].path, "b.txt");

    // Resolve the SECOND conflicting commit (b.txt).
    let resolved2 = tauri::async_runtime::block_on(resolve_conflict_file(path.clone(), "b.txt".into(), "theirs".into()));
    assert!(resolved2.ok, "second resolve failed: {}", resolved2.message);
    assert_eq!(resolved2.remaining, 0);

    let cont2 = tauri::async_runtime::block_on(rebase_continue(path.clone()));
    assert!(cont2.ok, "final rebase_continue failed: {}", cont2.message);
    assert_eq!(cont2.state, "clean");
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    // Both feature commits replayed onto main, in order, each a single-parent
    // (non-merge) commit; final content is each commit's own resolution.
    assert_eq!(repo.read("a.txt"), "feature-a\n");
    assert_eq!(repo.read("b.txt"), "feature-b\n");
    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 1);
    let parent = head.parent(0).unwrap();
    assert_eq!(parent.parent_count(), 1);
    let grandparent = parent.parent(0).unwrap();
    assert_eq!(grandparent.id().to_string(), main_head, "the rebased chain should be rooted on main's tip");
}

#[test]
fn rebase_abort_restores_head_and_is_idempotent() {
    let (repo, _main_head, feature_tip) = build_one_conflict_repo("rebase_abort");
    let path = repo.path();

    let out = tauri::async_runtime::block_on(rebase_start(path.clone(), "main".into()));
    assert_eq!(out.state, "conflict", "expected a conflict, got: {}", out.message);
    assert_eq!(repo.open().state(), RepositoryState::RebaseInteractive);

    let aborted = tauri::async_runtime::block_on(rebase_abort(path.clone()));
    assert!(aborted.ok, "rebase_abort failed: {}", aborted.message);
    assert_eq!(aborted.state, "clean");

    // Full restoration: HEAD sha, repo state, branch, and working tree content.
    assert_eq!(repo.rev("HEAD").as_deref(), Some(feature_tip.as_str()));
    assert_eq!(repo.current_branch(), "feature");
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    assert_eq!(repo.read("shared.txt"), "feature line\n");
    assert!(repo.is_clean());

    // Abort is idempotent when nothing is in progress.
    let again = tauri::async_runtime::block_on(rebase_abort(path));
    assert!(again.ok);
    assert_eq!(again.state, "clean");
}

#[test]
fn rebase_skip_drops_the_conflicting_commit_and_proceeds() {
    let (repo, main_head) = build_two_conflict_repo("rebase_skip");
    let path = repo.path();

    let out = tauri::async_runtime::block_on(rebase_start(path.clone(), "main".into()));
    assert_eq!(out.state, "conflict", "expected first conflict, got: {}", out.message);
    assert_eq!(out.conflicted_files, vec!["a.txt".to_string()]);

    // Skip the FIRST conflicting commit (a.txt) entirely — this should land
    // on the SECOND conflicting commit (b.txt), still "conflict", not "clean".
    let skipped = tauri::async_runtime::block_on(rebase_skip(path.clone()));
    assert_eq!(
        skipped.state, "conflict",
        "skipping the first commit should land on the second conflict; message: {}",
        skipped.message
    );
    assert_eq!(skipped.conflicted_files, vec!["b.txt".to_string()]);
    assert_eq!(repo.open().state(), RepositoryState::RebaseInteractive);

    // Resolve + continue the second, finishing the rebase.
    let resolved = tauri::async_runtime::block_on(resolve_conflict_file(path.clone(), "b.txt".into(), "theirs".into()));
    assert!(resolved.ok, "resolve failed: {}", resolved.message);
    let cont = tauri::async_runtime::block_on(rebase_continue(path.clone()));
    assert!(cont.ok, "rebase_continue failed: {}", cont.message);
    assert_eq!(cont.state, "clean");
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    // The skipped commit ("feature edit 1 (a.txt)") must be gone from
    // history: only ONE commit sits between main's tip and the new HEAD
    // (feature edit 2), and a.txt keeps MAIN's content (never touched by the
    // dropped commit), while b.txt carries feature's resolved content.
    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 1);
    assert_eq!(head.message().unwrap_or("").trim(), "feature edit 2 (b.txt)");
    let parent = head.parent(0).unwrap();
    assert_eq!(
        parent.id().to_string(),
        main_head,
        "the skipped commit should be gone — HEAD's parent should be main's tip directly"
    );
    assert_eq!(repo.read("a.txt"), "main-a\n", "a.txt should keep main's content — the commit that touched it was skipped");
    assert_eq!(repo.read("b.txt"), "feature-b\n");
}

// ---------------------------------------------------------------------------
// Interactive rebase: planner (read-only) + rebase_interactive_start
// ---------------------------------------------------------------------------

#[test]
fn rebase_interactive_plan_lists_range_in_oldest_first_order() {
    let (repo, _main_head, c1, c2, c3) = build_three_commit_feature("interactive_plan_order");
    let path = repo.path();

    let plan = tauri::async_runtime::block_on(rebase_interactive_plan(path.clone(), "main".into())).expect("plan failed");
    let shas: Vec<String> = plan.iter().map(|p| p.sha.clone()).collect();

    assert_eq!(shas, vec![c1, c2, c3], "plan should list commits oldest-first, matching replay order");
    assert_eq!(plan[0].short_sha, plan[0].sha.chars().take(7).collect::<String>());
    assert_eq!(plan[0].subject, "add one.txt");
    assert_eq!(plan[1].subject, "add two.txt");
    assert_eq!(plan[2].subject, "add three.txt");
}

#[test]
fn rebase_interactive_plan_lists_range_excluding_merge_commits() {
    let (repo, root, a, a2, s, a3, merge_sha) = build_merge_in_range_repo("interactive_plan_merge");
    let path = repo.path();

    let plan = tauri::async_runtime::block_on(rebase_interactive_plan(path.clone(), root)).expect("plan failed");
    let shas: Vec<String> = plan.iter().map(|p| p.sha.clone()).collect();

    assert_eq!(shas.len(), 4, "expected exactly 4 plannable (non-merge) commits, got: {shas:?}");
    assert!(!shas.contains(&merge_sha), "the merge commit itself must never appear as a plannable row");
    assert_eq!(shas[0], a, "A is the sole ancestor before the fork — must be first");
    assert_eq!(shas[3], a3, "A3 is the sole descendant of the merge — must be last");
    let middle: HashSet<String> = [shas[1].clone(), shas[2].clone()].into_iter().collect();
    let expected: HashSet<String> = [a2, s].into_iter().collect();
    assert_eq!(
        middle, expected,
        "the two parallel-branch commits (A2, S) should occupy the middle two slots, in either order"
    );
}

#[test]
fn rebase_interactive_reorders_two_independent_commits() {
    let (repo, main_head, c1, c2) = build_two_commit_feature("interactive_reorder");
    let path = repo.path();

    // Swap the order: c2 first, c1 second.
    let out = tauri::async_runtime::block_on(rebase_interactive_start(path.clone(), "main".into(), todo(&[(&c2, "pick"), (&c1, "pick")])));
    assert!(out.ok, "expected a clean reorder, got: {}", out.message);
    assert_eq!(out.state, "clean");
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.message().unwrap_or("").trim(), "add one.txt", "c1 (now second) should be HEAD, replayed last");
    let parent = head.parent(0).unwrap();
    assert_eq!(parent.message().unwrap_or("").trim(), "add two.txt", "c2 (now first) should be replayed directly onto main");
    assert_eq!(parent.parent(0).unwrap().id().to_string(), main_head);
    assert_eq!(repo.read("one.txt"), "one\n");
    assert_eq!(repo.read("two.txt"), "two\n");
}

#[test]
fn rebase_interactive_drop_removes_a_commit() {
    let (repo, main_head, c1, c2) = build_two_commit_feature("interactive_drop_one");
    let path = repo.path();

    let out = tauri::async_runtime::block_on(rebase_interactive_start(path.clone(), "main".into(), todo(&[(&c1, "drop"), (&c2, "pick")])));
    assert!(out.ok, "expected a clean drop, got: {}", out.message);
    assert_eq!(out.state, "clean");
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.message().unwrap_or("").trim(), "add two.txt");
    assert_eq!(
        head.parent(0).unwrap().id().to_string(),
        main_head,
        "the dropped commit should be gone — HEAD's parent should be main's tip directly"
    );
    assert!(!repo.dir.join("one.txt").exists(), "one.txt should never appear — its commit was dropped");
    assert_eq!(repo.read("two.txt"), "two\n");
}

#[test]
fn rebase_interactive_drop_every_commit_in_range_leaves_head_at_onto() {
    let (repo, main_head, c1, c2) = build_two_commit_feature("interactive_drop_all");
    let path = repo.path();

    let out = tauri::async_runtime::block_on(rebase_interactive_start(path.clone(), "main".into(), todo(&[(&c1, "drop"), (&c2, "drop")])));
    assert!(out.ok, "expected a clean drop-all, got: {}", out.message);
    assert_eq!(out.state, "clean");
    assert_eq!(
        repo.rev("HEAD").as_deref(),
        Some(main_head.as_str()),
        "dropping every commit in range should leave HEAD exactly at onto"
    );
    assert_eq!(repo.open().state(), RepositoryState::Clean);
}

#[test]
fn rebase_interactive_squash_combines_with_concatenated_message() {
    let (repo, main_head, c1, c2) = build_two_commit_feature("interactive_squash");
    let path = repo.path();

    let out = tauri::async_runtime::block_on(rebase_interactive_start(path.clone(), "main".into(), todo(&[(&c1, "pick"), (&c2, "squash")])));
    assert!(out.ok, "expected a clean squash, got: {}", out.message);
    assert_eq!(out.state, "clean");

    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 1);
    assert_eq!(
        head.parent(0).unwrap().id().to_string(),
        main_head,
        "the squashed commit should sit directly on main's tip — only ONE commit remains"
    );
    let msg = head.message().unwrap_or("").to_string();
    assert!(msg.contains("add one.txt"), "squashed message should retain the first commit's message: {msg:?}");
    assert!(msg.contains("add two.txt"), "squashed message should retain the second commit's message: {msg:?}");
    assert_eq!(repo.read("one.txt"), "one\n");
    assert_eq!(repo.read("two.txt"), "two\n");
}

#[test]
fn rebase_interactive_fixup_discards_message() {
    let (repo, main_head, c1, c2) = build_two_commit_feature("interactive_fixup");
    let path = repo.path();

    let out = tauri::async_runtime::block_on(rebase_interactive_start(path.clone(), "main".into(), todo(&[(&c1, "pick"), (&c2, "fixup")])));
    assert!(out.ok, "expected a clean fixup, got: {}", out.message);
    assert_eq!(out.state, "clean");

    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 1);
    assert_eq!(head.parent(0).unwrap().id().to_string(), main_head);
    let msg = head.message().unwrap_or("").trim().to_string();
    assert_eq!(msg, "add one.txt", "fixup should discard the fixed-up commit's own message, keeping only the first");
    assert_eq!(repo.read("one.txt"), "one\n");
    assert_eq!(repo.read("two.txt"), "two\n");
}

#[test]
fn rebase_interactive_edit_pauses_cleanly_state_is_editing() {
    let (repo, main_head, c1, c2) = build_two_commit_feature("interactive_edit_pause");
    let path = repo.path();

    let out = tauri::async_runtime::block_on(rebase_interactive_start(path.clone(), "main".into(), todo(&[(&c1, "edit"), (&c2, "pick")])));
    assert_eq!(out.state, "editing", "expected a clean edit-pause, got: {}", out.message);
    assert!(!out.ok);
    assert!(out.conflicted_files.is_empty());
    assert!(out.backup_ref.is_some());
    assert_eq!(repo.open().state(), RepositoryState::RebaseInteractive);
    assert!(repo.is_clean(), "a clean edit-pause must leave the working tree clean, not conflicted");

    // The paused commit's content is already checked out/committed.
    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.message().unwrap_or("").trim(), "add one.txt");
    assert_eq!(head.parent(0).unwrap().id().to_string(), main_head);
    assert_eq!(repo.read("one.txt"), "one\n");
}

#[test]
fn rebase_interactive_edit_amend_via_workdir_commit_then_continue() {
    let (repo, main_head, c1, c2) = build_two_commit_feature("interactive_edit_amend");
    let path = repo.path();

    let out = tauri::async_runtime::block_on(rebase_interactive_start(path.clone(), "main".into(), todo(&[(&c1, "edit"), (&c2, "pick")])));
    assert_eq!(out.state, "editing", "expected a clean edit-pause, got: {}", out.message);

    // Amend the paused commit via the SAME `workdir::commit(amend: true)` the
    // real Workdir panel uses — reused UNCHANGED for interactive rebase.
    std::fs::write(repo.dir.join("one.txt"), "one (amended)\n").expect("write one.txt");
    repo.must(&["add", "-A"]);
    let amend_res =
        tauri::async_runtime::block_on(workdir_commit(path.clone(), Some("add one.txt (amended)".into()), Some(true)));
    assert!(amend_res.ok, "amend failed: {}", amend_res.message);

    let cont = tauri::async_runtime::block_on(rebase_continue(path.clone()));
    assert!(cont.ok, "rebase_continue after amend failed: {}", cont.message);
    assert_eq!(cont.state, "clean");
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    assert_eq!(repo.read("one.txt"), "one (amended)\n", "the amended content should survive to the final history");
    assert_eq!(repo.read("two.txt"), "two\n");
    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.message().unwrap_or("").trim(), "add two.txt");
    let parent = head.parent(0).unwrap();
    assert_eq!(parent.message().unwrap_or("").trim(), "add one.txt (amended)");
    assert_eq!(parent.parent(0).unwrap().id().to_string(), main_head);
}

#[test]
fn rebase_interactive_edit_pause_then_abort_restores_original_state() {
    let (repo, _main_head, c1, c2) = build_two_commit_feature("interactive_edit_abort");
    let path = repo.path();
    let original_head = repo.rev("HEAD").unwrap();

    let out = tauri::async_runtime::block_on(rebase_interactive_start(path.clone(), "main".into(), todo(&[(&c1, "edit"), (&c2, "pick")])));
    assert_eq!(out.state, "editing", "expected a clean edit-pause, got: {}", out.message);

    let aborted = tauri::async_runtime::block_on(rebase_abort(path.clone()));
    assert!(aborted.ok, "rebase_abort failed: {}", aborted.message);
    assert_eq!(aborted.state, "clean");
    assert_eq!(
        repo.rev("HEAD").as_deref(),
        Some(original_head.as_str()),
        "abort should fully restore the pre-rebase HEAD"
    );
    assert_eq!(repo.current_branch(), "feature");
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    assert!(repo.is_clean());
}

#[test]
fn rebase_interactive_squash_that_conflicts_is_distinguishable_from_clean_squash() {
    let (repo, _main_head, c1, c2) = build_squash_conflict_feature("interactive_squash_conflict");
    let path = repo.path();

    let out = tauri::async_runtime::block_on(rebase_interactive_start(path.clone(), "main".into(), todo(&[(&c1, "pick"), (&c2, "squash")])));
    assert_eq!(
        out.state, "conflict",
        "the squash step's own internal cherry-pick should conflict, got: {}",
        out.message
    );
    assert!(!out.ok);
    assert_eq!(out.conflicted_files, vec!["shared.txt".to_string()]);
    assert_eq!(repo.open().state(), RepositoryState::RebaseInteractive);

    let resolved = tauri::async_runtime::block_on(resolve_conflict_file(path.clone(), "shared.txt".into(), "theirs".into()));
    assert!(resolved.ok, "resolve failed: {}", resolved.message);

    let cont = tauri::async_runtime::block_on(rebase_continue(path.clone()));
    assert!(cont.ok, "rebase_continue failed: {}", cont.message);
    assert_eq!(cont.state, "clean");
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 1, "only ONE commit should remain — squash combined both");
    assert_eq!(repo.read("shared.txt"), "feature line\n");
    assert_eq!(repo.read("clean.txt"), "feature clean\n");
}

#[test]
fn rebase_interactive_plain_pick_conflict_matches_existing_linear_behavior() {
    let (repo, main_head, feature_tip) = build_one_conflict_repo("interactive_plain_conflict");
    let path = repo.path();

    let out = tauri::async_runtime::block_on(rebase_interactive_start(path.clone(), "main".into(), todo(&[(&feature_tip, "pick")])));
    assert_eq!(out.state, "conflict", "expected a conflict, got: {}", out.message);
    assert!(!out.ok);
    assert_eq!(out.conflicted_files, vec!["shared.txt".to_string()]);
    assert_eq!(repo.open().state(), RepositoryState::RebaseInteractive);

    let resolved = tauri::async_runtime::block_on(resolve_conflict_file(path.clone(), "shared.txt".into(), "theirs".into()));
    assert!(resolved.ok, "resolve failed: {}", resolved.message);
    let cont = tauri::async_runtime::block_on(rebase_continue(path.clone()));
    assert!(cont.ok, "rebase_continue failed: {}", cont.message);
    assert_eq!(cont.state, "clean");
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    assert_eq!(repo.read("shared.txt"), "feature line\n");
    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent(0).unwrap().id().to_string(), main_head);
}

#[test]
fn rebase_interactive_start_rejects_stale_or_mismatched_todo() {
    let (repo, main_head, c1, _c2) = build_two_commit_feature("interactive_stale");
    let path = repo.path();
    let original_head = repo.rev("HEAD").unwrap();

    // Simulate a stale frontend: swap in a valid-but-out-of-range commit
    // (main's own tip) in place of the real c2.
    let stale = todo(&[(&c1, "pick"), (&main_head, "pick")]);
    let out = tauri::async_runtime::block_on(rebase_interactive_start(path.clone(), "main".into(), stale));
    assert_eq!(
        out.state, "error",
        "a stale/mismatched todo must be refused outright, not silently rebase the wrong commits"
    );
    assert!(!out.ok);
    assert!(out.backup_ref.is_none(), "a pre-flight refusal must never snapshot");
    assert!(!out.blocked_by_local_changes, "a stale-todo refusal must not be misclassified as a dirty-tree block: {}", out.message);

    // Nothing was mutated.
    assert_eq!(repo.rev("HEAD").as_deref(), Some(original_head.as_str()));
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    assert!(repo.is_clean());
}

/// Regression guard (bug fix): the stale-plan check compared `todo`/`fresh` as
/// two `HashSet<String>`s WITHOUT also checking their LENGTHS matched — a
/// todo with a duplicate sha and a corresponding extra row (e.g. fresh has 3
/// commits {A,B,C}, todo has 4 rows: A pick, B pick, B squash, C pick) dedups
/// to the SAME set {A,B,C} and used to pass validation, even though it would
/// silently double-process B while never giving A and B their correct,
/// distinct one-line-each treatment. Must now be refused outright, before any
/// snapshot/mutation.
#[test]
fn rebase_interactive_start_rejects_duplicate_sha_with_extra_row_even_though_the_set_matches() {
    let (repo, _main_head, c1, c2, c3) = build_three_commit_feature("interactive_dup_sha");
    let path = repo.path();
    let original_head = repo.rev("HEAD").unwrap();

    let dup = todo(&[(&c1, "pick"), (&c2, "pick"), (&c2, "squash"), (&c3, "pick")]);
    let out = tauri::async_runtime::block_on(rebase_interactive_start(path.clone(), "main".into(), dup));
    assert_eq!(
        out.state, "error",
        "a duplicate-sha todo with a matching SET but wrong row count must be refused, got: {}",
        out.message
    );
    assert!(!out.ok);
    assert!(out.backup_ref.is_none(), "a pre-flight refusal must never snapshot");
    assert_eq!(repo.rev("HEAD").as_deref(), Some(original_head.as_str()));
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    assert!(repo.is_clean());
}

#[test]
fn rebase_interactive_rejects_squash_as_first_row() {
    let (repo, _main_head, c1, c2) = build_two_commit_feature("interactive_first_squash");
    let path = repo.path();
    let original_head = repo.rev("HEAD").unwrap();

    let bad = todo(&[(&c1, "squash"), (&c2, "pick")]);
    let out = tauri::async_runtime::block_on(rebase_interactive_start(path.clone(), "main".into(), bad));
    assert_eq!(out.state, "error");
    assert!(
        out.message.to_lowercase().contains("squash") || out.message.to_lowercase().contains("first"),
        "expected a clean pre-check message, got: {}",
        out.message
    );
    assert!(out.backup_ref.is_none(), "a pre-flight refusal must never snapshot");
    assert_eq!(repo.rev("HEAD").as_deref(), Some(original_head.as_str()));
    assert_eq!(repo.open().state(), RepositoryState::Clean);
}

/// Regression guard (bug fix): the actual `git rebase -i` invocation used to
/// pass the RAW `onto` string, which git would re-resolve independently at
/// invocation time rather than reusing the already-validated `onto_oid` —  a
/// narrow TOCTOU window if `onto` moved between validation and invocation.
/// This test can't reproduce that literal intra-call race deterministically
/// (there's no test-visible seam between the two — see git_rebase.rs's fix
/// comment), but DOES pin the adjacent, fully testable half of the same
/// invariant: `onto` must always be resolved FRESH at call time, never from
/// a stale earlier position (e.g. one an earlier planner round-trip saw).
#[test]
fn rebase_interactive_start_bases_on_ontos_resolved_oid_at_call_time_not_a_stale_value() {
    let repo = TempRepo::init("interactive_onto_fresh");
    let _base = repo.commit("base.txt", "base\n", "base");
    repo.must(&["branch", "feature"]);
    let _main_v1 = repo.commit("main.txt", "v1\n", "main v1");
    repo.must(&["checkout", "-q", "feature"]);
    let c1 = repo.commit("f.txt", "feature\n", "feature commit");
    let path = repo.path();

    // Simulate the realistic window this bug guards: another process/window
    // fast-forwards `main` AFTER a planner would have listed the range but
    // BEFORE `rebase_interactive_start` actually runs.
    repo.must(&["checkout", "-q", "main"]);
    let main_v2 = repo.commit("main.txt", "v2\n", "main v2");
    repo.must(&["checkout", "-q", "feature"]);

    let out = tauri::async_runtime::block_on(rebase_interactive_start(path.clone(), "main".into(), todo(&[(&c1, "pick")])));
    assert!(out.ok, "expected a clean rebase, got: {}", out.message);
    assert_eq!(out.state, "clean");

    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(
        head.parent(0).unwrap().id().to_string(),
        main_v2,
        "must rebase onto main's CURRENT resolved tip (v2) — the same oid \
         validated against, not any earlier position (v1)"
    );
}
