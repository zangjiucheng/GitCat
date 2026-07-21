//! Remote sync (fetch / pull / push) against a local bare repo standing in
//! for a real remote — a filesystem path is a valid git remote URL, so this
//! needs no network access, same technique real git itself uses for
//! `file://` remotes.

mod common;

use common::TempRepo;
use gitcat_lib::git_remote::{current_upstream, fetch, force_push, pull, push, push_branch, reset_branch_to_upstream};

/// A bare "origin" + a local clone of it (remote already configured, one
/// commit already pushed) — the shared starting point for every test here.
fn origin_and_clone(tag: &str) -> (TempRepo, TempRepo) {
    let origin = TempRepo::init_bare(&format!("{tag}-origin"));
    let local = TempRepo::init(&format!("{tag}-local"));
    local.commit("f.txt", "0\n", "c0");
    local.must(&["remote", "add", "origin", &origin.path()]);
    local.must(&["push", "-q", "-u", "origin", "main"]);
    (origin, local)
}

/// A second clone of `origin`, used to simulate "someone else pushed" —
/// commits made here and pushed become visible to `fetch`/`pull` on `local`.
fn second_clone(origin: &TempRepo, tag: &str) -> TempRepo {
    let other = TempRepo::init(&format!("{tag}-other"));
    other.must(&["remote", "add", "origin", &origin.path()]);
    other.must(&["fetch", "-q", "origin", "main"]);
    other.must(&["checkout", "-q", "-B", "main", "origin/main"]);
    other
}

#[test]
fn fetch_updates_remote_tracking_refs_without_touching_local_head() {
    let (origin, local) = origin_and_clone("fetch_basic");
    let other = second_clone(&origin, "fetch_basic");
    let new_tip = other.commit("g.txt", "1\n", "c1");
    other.must(&["push", "-q", "origin", "main"]);

    let head_before = local.rev("HEAD");
    assert_ne!(local.rev("refs/remotes/origin/main"), Some(new_tip.clone()));

    let res = tauri::async_runtime::block_on(fetch(local.path(), None));
    assert!(res.ok, "fetch failed: {}", res.message);
    assert_eq!(local.rev("refs/remotes/origin/main"), Some(new_tip));
    assert_eq!(local.rev("HEAD"), head_before, "fetch must never move local HEAD");
    assert!(res.backup_ref.is_none(), "fetch never snapshots — nothing local changed");
}

#[test]
fn fetch_named_remote_validates_the_name() {
    let (_origin, local) = origin_and_clone("fetch_validate");
    let res = tauri::async_runtime::block_on(fetch(local.path(), Some("--upload-pack=evil".to_string())));
    assert!(!res.ok);
    assert!(res.message.contains("flag"), "expected a flag-injection refusal, got: {}", res.message);
}

#[test]
fn pull_fast_forwards_and_snapshots_first() {
    let (origin, local) = origin_and_clone("pull_ff");
    let other = second_clone(&origin, "pull_ff");
    let new_tip = other.commit("g.txt", "1\n", "c1");
    other.must(&["push", "-q", "origin", "main"]);

    let res = tauri::async_runtime::block_on(pull(local.path()));
    assert!(res.ok, "pull failed: {}", res.message);
    assert_eq!(local.rev("HEAD"), Some(new_tip));
    assert!(res.backup_ref.is_some(), "pull moves local HEAD, so it must snapshot first");
}

#[test]
fn pull_refuses_to_merge_on_divergence_ff_only() {
    let (origin, local) = origin_and_clone("pull_diverge");
    let other = second_clone(&origin, "pull_diverge");
    other.commit("g.txt", "1\n", "their commit");
    other.must(&["push", "-q", "origin", "main"]);

    // Local now has an UNPUSHED commit of its own -> the two histories diverge.
    let local_tip = local.commit("h.txt", "local\n", "my commit");

    let res = tauri::async_runtime::block_on(pull(local.path()));
    assert!(!res.ok, "a diverged ff-only pull must be refused, not silently merged");
    assert_eq!(local.rev("HEAD"), Some(local_tip), "a refused pull must leave HEAD untouched");
    assert!(local.is_clean(), "a refused ff-only pull must never leave a conflict/merge in progress");
}

#[test]
fn push_publishes_a_branch_with_no_upstream_to_origin() {
    let origin = TempRepo::init_bare("push_new_branch-origin");
    let local = TempRepo::init("push_new_branch-local");
    local.commit("f.txt", "0\n", "c0");
    local.must(&["remote", "add", "origin", &origin.path()]);

    assert!(local.rev("refs/remotes/origin/main").is_none(), "nothing pushed yet");
    let res = tauri::async_runtime::block_on(push(local.path()));
    assert!(res.ok, "push failed: {}", res.message);
    assert_eq!(origin.rev("main"), local.rev("HEAD"), "origin's bare main should now match local HEAD");

    let (has_upstream, _, _) = local.git(&["rev-parse", "--abbrev-ref", "main@{upstream}"]);
    assert!(has_upstream, "push with no existing upstream should set one via --set-upstream");
}

#[test]
fn push_with_existing_upstream_does_not_need_set_upstream_again() {
    let (origin, local) = origin_and_clone("push_existing");
    let new_tip = local.commit("g.txt", "1\n", "c1");

    let res = tauri::async_runtime::block_on(push(local.path()));
    assert!(res.ok, "push failed: {}", res.message);
    assert_eq!(origin.rev("main"), Some(new_tip));
}

#[test]
fn push_rejects_a_non_fast_forward_without_forcing() {
    let (origin, local) = origin_and_clone("push_reject");
    let other = second_clone(&origin, "push_reject");
    let their_tip = other.commit("g.txt", "1\n", "their commit");
    other.must(&["push", "-q", "origin", "main"]);

    // local is now BEHIND origin — its push should be rejected, not forced.
    local.commit("h.txt", "1\n", "diverged commit");
    let res = tauri::async_runtime::block_on(push(local.path()));
    assert!(!res.ok, "a non-fast-forward push must be rejected");
    assert_eq!(origin.rev("main"), Some(their_tip), "a rejected push must never overwrite origin");
}

#[test]
fn current_upstream_reports_the_configured_shorthand() {
    // origin_and_clone already leaves `local`'s main tracking origin/main
    // (via `push -u`), so this is the "has an upstream" case for free.
    let (_origin, local) = origin_and_clone("current_upstream_configured");
    let up = tauri::async_runtime::block_on(current_upstream(local.path())).expect("current_upstream should not error");
    assert_eq!(up.as_deref(), Some("origin/main"), "expected the shorthand tracking-ref name");
}

#[test]
fn current_upstream_is_none_when_branch_has_no_upstream() {
    let origin = TempRepo::init_bare("current_upstream_none-origin");
    let local = TempRepo::init("current_upstream_none-local");
    local.commit("f.txt", "0\n", "c0");
    local.must(&["remote", "add", "origin", &origin.path()]);
    // Deliberately never pushed / never `--set-upstream`'d.

    let up = tauri::async_runtime::block_on(current_upstream(local.path())).expect("current_upstream should not error");
    assert_eq!(up, None, "a branch with no configured upstream must report None, not an error");
}

/// Rewrite `repo`'s last commit in place (`git commit --amend`) — stands in
/// for "the user rebased/amended a branch that's already been pushed", the
/// exact scenario `force_push` exists for (see git_remote.rs's module doc).
fn amend_last_commit(repo: &TempRepo, new_content: &str, msg: &str) -> String {
    std::fs::write(repo.dir.join("g.txt"), new_content).expect("write file");
    repo.must(&["add", "-A"]);
    repo.must(&["commit", "-q", "--no-verify", "--amend", "-m", msg]);
    repo.must(&["rev-parse", "HEAD"])
}

#[test]
fn force_push_lease_succeeds_after_a_local_rebase_amend() {
    let (origin, local) = origin_and_clone("fp_lease_ok");
    let pushed_tip = local.commit("g.txt", "1\n", "c1");
    local.must(&["push", "-q"]);
    assert_eq!(origin.rev("main"), Some(pushed_tip.clone()));

    // Rewrite history locally exactly like a rebase/amend would — origin
    // hasn't moved, so local's remote-tracking ref is still accurate.
    let rewritten_tip = amend_last_commit(&local, "1 reworded\n", "c1 (amended)");
    assert_ne!(rewritten_tip, pushed_tip, "amend must actually rewrite the commit");

    let res = tauri::async_runtime::block_on(force_push(local.path(), true));
    assert!(res.ok, "force_push(lease=true) should succeed: {}", res.message);
    assert_eq!(origin.rev("main"), Some(rewritten_tip), "origin should now hold the rewritten history");
    assert!(res.backup_ref.is_none(), "force_push never snapshots — nothing local changes");
}

#[test]
fn force_push_lease_is_rejected_when_remote_moved_since_last_fetch() {
    let (origin, local) = origin_and_clone("fp_lease_reject");
    let pushed_tip = local.commit("g.txt", "1\n", "c1");
    local.must(&["push", "-q"]);

    // A collaborator pushes to origin WITHOUT local ever fetching it — local's
    // remote-tracking ref (refs/remotes/origin/main) is now stale.
    let other = second_clone(&origin, "fp_lease_reject");
    let theirs_tip = other.commit("h.txt", "their change\n", "their commit");
    other.must(&["push", "-q", "origin", "main"]);
    assert_eq!(origin.rev("main"), Some(theirs_tip.clone()));

    // Local, unaware of the collaborator's push, rewrites its own history.
    let rewritten_tip = amend_last_commit(&local, "1 reworded\n", "c1 (amended)");
    assert_ne!(rewritten_tip, pushed_tip);

    let res = tauri::async_runtime::block_on(force_push(local.path(), true));
    assert!(!res.ok, "force_push(lease=true) must be rejected, not silently forced, when the remote moved");
    assert_eq!(origin.rev("main"), Some(theirs_tip), "a rejected --force-with-lease must never touch origin");
}

#[test]
fn force_push_without_lease_overrides_remote_changes_unconditionally() {
    let (origin, local) = origin_and_clone("fp_override");
    let pushed_tip = local.commit("g.txt", "1\n", "c1");
    local.must(&["push", "-q"]);

    // Same "collaborator pushed without local fetching" setup as the lease
    // rejection test above — this time we force WITHOUT a lease.
    let other = second_clone(&origin, "fp_override");
    let theirs_tip = other.commit("h.txt", "their change\n", "their commit");
    other.must(&["push", "-q", "origin", "main"]);

    let rewritten_tip = amend_last_commit(&local, "1 reworded\n", "c1 (amended)");
    assert_ne!(rewritten_tip, pushed_tip);

    let res = tauri::async_runtime::block_on(force_push(local.path(), false));
    assert!(res.ok, "force_push(lease=false) should succeed even when the remote moved: {}", res.message);
    assert_eq!(
        origin.rev("main"),
        Some(rewritten_tip),
        "a raw --force must overwrite origin, discarding the collaborator's commit"
    );
    assert!(!origin.obj_exists(&theirs_tip) || origin.rev("main") != Some(theirs_tip), "the collaborator's commit must no longer be origin's tip");
}

/// Regression test for a real bug an adversarial review caught: `force_push`
/// used to invoke git with ZERO explicit remote/refspec positionals (to dodge
/// a separate, real pitfall — see the fix's own comment on git_remote.rs), but
/// that meant the user's own `push.default` config decided what got pushed.
/// `push.default=matching` sweeps in EVERY branch that has a same-named
/// remote counterpart, not just the current one — silently touching (or
/// misreporting the result of) a branch the confirm dialog never showed. The
/// fix passes an explicit `<remote> <branch>`, confining the push to exactly
/// the current branch regardless of this config.
#[test]
fn force_push_is_confined_to_the_current_branch_even_under_push_default_matching() {
    let (origin, local) = origin_and_clone("fp_matching_guard");

    // A second branch, also tracked/pushed, so `push.default=matching` has
    // more than one same-named branch pair to consider.
    local.must(&["checkout", "-q", "-b", "feature"]);
    local.commit("feat.txt", "0\n", "feature c0");
    local.must(&["push", "-q", "-u", "origin", "feature"]);

    // A collaborator advances `feature` on origin WITHOUT local ever
    // fetching it — local's own remote-tracking ref for `feature` is now
    // stale relative to origin.
    let other = second_clone(&origin, "fp_matching_guard");
    other.must(&["fetch", "-q", "origin", "feature"]);
    other.must(&["checkout", "-q", "-B", "feature", "origin/feature"]);
    let their_feature_tip = other.commit("feat.txt", "their change\n", "their feature commit");
    other.must(&["push", "-q", "origin", "feature"]);
    assert_eq!(origin.rev("feature"), Some(their_feature_tip.clone()));

    // Back on `main` — the actual branch being force-pushed. Rewrite it
    // locally exactly like an amend/rebase would; origin's `main` hasn't
    // moved, so a lease-based force-push of `main` alone should succeed.
    local.must(&["checkout", "-q", "main"]);
    let pushed_tip = local.rev("HEAD").unwrap();
    let rewritten_tip = amend_last_commit(&local, "0 reworded\n", "c0 (amended)");
    assert_ne!(rewritten_tip, pushed_tip);

    // The convenience setting that broadens a bare `git push`'s scope: with
    // this set (and no explicit remote/branch), a force-push would sweep in
    // `feature` too, either clobbering it (raw force) or failing the whole
    // call because `feature` alone was rejected (lease) even though `main`
    // itself would have succeeded.
    local.must(&["config", "push.default", "matching"]);

    let res = tauri::async_runtime::block_on(force_push(local.path(), true));
    assert!(res.ok, "force_push(lease=true) on main alone should succeed: {}", res.message);
    assert_eq!(origin.rev("main"), Some(rewritten_tip), "origin's main should hold the rewritten history");
    assert_eq!(
        origin.rev("feature"),
        Some(their_feature_tip),
        "force_push must be confined to `main` — it must never touch `feature`, whose remote history it never even fetched"
    );
}

#[test]
fn force_push_refuses_a_branch_with_no_upstream_before_attempting_anything() {
    let origin = TempRepo::init_bare("fp_no_upstream-origin");
    let local = TempRepo::init("fp_no_upstream-local");
    local.commit("f.txt", "0\n", "c0");
    local.must(&["remote", "add", "origin", &origin.path()]);
    // Deliberately never pushed / never `--set-upstream`'d.

    let res = tauri::async_runtime::block_on(force_push(local.path(), true));
    assert!(!res.ok, "force_push must refuse a branch with no upstream");
    assert!(
        res.message.contains("upstream"),
        "expected a clear no-upstream refusal message, got: {}",
        res.message
    );
    assert!(origin.rev("main").is_none(), "nothing should have been attempted against origin");

    // Same refusal for the raw-force variant too — the no-upstream guard
    // applies regardless of `lease`.
    let res2 = tauri::async_runtime::block_on(force_push(local.path(), false));
    assert!(!res2.ok, "force_push(lease=false) must also refuse a branch with no upstream");
}

#[test]
fn reset_current_branch_discards_local_commits_and_working_tree_changes() {
    let (origin, local) = origin_and_clone("reset_current");
    let upstream_tip = local.rev("HEAD").unwrap();

    // Local diverges from origin: one committed change plus one uncommitted
    // (dirty working-tree) change — `reset --hard` must discard both.
    local.commit("f.txt", "local-only commit\n", "local commit");
    std::fs::write(local.dir.join("f.txt"), "dirty uncommitted\n").expect("write dirty change");
    assert!(!local.is_clean(), "sanity: working tree should be dirty before reset");

    let res = tauri::async_runtime::block_on(reset_branch_to_upstream(local.path(), "main".to_string()));
    assert!(res.ok, "reset_branch_to_upstream failed: {}", res.message);
    assert_eq!(local.rev("HEAD"), Some(upstream_tip.clone()), "HEAD should land exactly on origin/main's tip");
    assert!(local.is_clean(), "reset --hard must discard the dirty working-tree change too");
    assert_eq!(local.read("f.txt"), "0\n", "working tree content should match the reset-to commit, not the discarded ones");
    assert!(res.backup_ref.is_some(), "resetting the current branch discards history, so it must snapshot first");

    // The origin's remote-tracking ref itself must be untouched by all this.
    assert_eq!(origin.rev("main"), Some(upstream_tip));
}

#[test]
fn reset_non_current_branch_only_moves_the_ref_without_touching_working_tree() {
    let (origin, local) = origin_and_clone("reset_non_current");

    // A second local branch, tracking origin/main, that diverges from it —
    // but we stay checked out on `main`, so `feature` is never the working
    // copy's current branch.
    local.must(&["branch", "feature", "--track", "origin/main"]);
    let feature_local_tip = {
        // Commit onto `feature` without checking it out, so the working
        // tree (still on `main`) is never touched by this setup.
        local.must(&["checkout", "-q", "feature"]);
        let tip = local.commit("feat.txt", "feature-only\n", "feature commit");
        local.must(&["checkout", "-q", "main"]);
        tip
    };
    let upstream_tip = origin.rev("main").unwrap();
    assert_ne!(feature_local_tip, upstream_tip, "sanity: feature must actually diverge from its upstream");

    let before_current_head = local.rev("HEAD");
    let res = tauri::async_runtime::block_on(reset_branch_to_upstream(local.path(), "feature".to_string()));
    assert!(res.ok, "reset_branch_to_upstream failed: {}", res.message);
    assert_eq!(local.rev("refs/heads/feature"), Some(upstream_tip), "feature's ref should now match its upstream");
    assert_eq!(local.current_branch(), "main", "resetting a non-current branch must never move HEAD off the checked-out branch");
    assert_eq!(local.rev("HEAD"), before_current_head, "the currently checked-out branch's tip must be untouched");
    assert!(local.is_clean(), "resetting a non-current branch must never touch the working tree");
    assert!(res.backup_ref.is_some(), "still snapshots first, even for a non-current branch");
}

#[test]
fn reset_refuses_a_branch_with_no_configured_upstream() {
    let (_origin, local) = origin_and_clone("reset_no_upstream");
    local.must(&["checkout", "-q", "-b", "orphan"]);
    local.commit("o.txt", "0\n", "orphan commit");
    // Deliberately never tracked/pushed.

    let tip_before = local.rev("HEAD");
    let res = tauri::async_runtime::block_on(reset_branch_to_upstream(local.path(), "orphan".to_string()));
    assert!(!res.ok, "reset must refuse a branch with no configured upstream");
    assert!(res.message.contains("upstream"), "expected a clear no-upstream refusal, got: {}", res.message);
    assert_eq!(local.rev("HEAD"), tip_before, "a refused reset must never move HEAD");
    assert!(res.backup_ref.is_none(), "a refused reset (no mutation attempted) must not snapshot");
}

#[test]
fn reset_refuses_a_nonexistent_branch() {
    let (_origin, local) = origin_and_clone("reset_nonexistent");

    let res = tauri::async_runtime::block_on(reset_branch_to_upstream(local.path(), "does-not-exist".to_string()));
    assert!(!res.ok, "reset must refuse a branch that doesn't exist locally");
    assert!(res.backup_ref.is_none(), "a refused reset must not snapshot");
}

#[test]
fn current_upstream_is_none_on_detached_head() {
    let (_origin, local) = origin_and_clone("current_upstream_detached");
    let head_sha = local.rev("HEAD").expect("HEAD should resolve");
    local.must(&["checkout", "-q", &head_sha]);
    assert_eq!(local.current_branch(), "", "sanity: HEAD should now be detached");

    let up = tauri::async_runtime::block_on(current_upstream(local.path())).expect("current_upstream should not error");
    assert_eq!(up, None, "a detached HEAD has no branch, so no upstream, either");
}

#[test]
fn push_branch_publishes_a_non_checked_out_branch_without_switching() {
    let (origin, local) = origin_and_clone("push_branch_no_switch");
    local.must(&["branch", "feature"]); // NOT checked out — main stays current
    let feature_tip = local.rev("refs/heads/feature").expect("feature branch should exist");
    assert_eq!(local.current_branch(), "main", "sanity: still on main before pushing");
    assert!(origin.rev("feature").is_none(), "nothing pushed yet");

    let res = tauri::async_runtime::block_on(push_branch(local.path(), "feature".to_string(), None, None));
    assert!(res.ok, "push_branch failed: {}", res.message);
    assert_eq!(origin.rev("feature"), Some(feature_tip), "origin should now have feature at the same tip");
    assert_eq!(local.current_branch(), "main", "push_branch must never switch the checked-out branch");
}

#[test]
fn push_branch_can_publish_under_a_different_remote_name() {
    let (origin, local) = origin_and_clone("push_branch_rename");
    local.must(&["branch", "feature"]);
    let feature_tip = local.rev("refs/heads/feature").expect("feature branch should exist");

    let res = tauri::async_runtime::block_on(push_branch(local.path(), "feature".to_string(), None, Some("feature-review".to_string())));
    assert!(res.ok, "push_branch failed: {}", res.message);
    assert_eq!(origin.rev("feature-review"), Some(feature_tip), "origin should have the renamed branch");
    assert!(origin.rev("feature").is_none(), "must not ALSO create a same-named branch on origin");
}

#[test]
fn push_branch_sets_upstream_tracking_on_first_publish() {
    let (_origin, local) = origin_and_clone("push_branch_upstream");
    local.must(&["branch", "feature"]);

    let res = tauri::async_runtime::block_on(push_branch(local.path(), "feature".to_string(), None, None));
    assert!(res.ok, "push_branch failed: {}", res.message);

    let (has_upstream, _, _) = local.git(&["rev-parse", "--abbrev-ref", "feature@{upstream}"]);
    assert!(has_upstream, "push_branch with no existing upstream should set one via --set-upstream");
}

#[test]
fn push_branch_set_upstream_tracks_the_renamed_remote_branch() {
    let (_origin, local) = origin_and_clone("push_branch_upstream_renamed");
    local.must(&["branch", "feature"]);

    let res = tauri::async_runtime::block_on(push_branch(local.path(), "feature".to_string(), None, Some("feature-review".to_string())));
    assert!(res.ok, "push_branch failed: {}", res.message);

    let tracked = local.must(&["rev-parse", "--abbrev-ref", "feature@{upstream}"]);
    assert_eq!(tracked, "origin/feature-review", "upstream must track the RENAMED remote branch, not the local name");
}

#[test]
fn push_branch_rejects_a_nonexistent_local_branch() {
    let (_origin, local) = origin_and_clone("push_branch_missing");
    let res = tauri::async_runtime::block_on(push_branch(local.path(), "no-such-branch".to_string(), None, None));
    assert!(!res.ok);
    assert!(res.message.contains("no-such-branch"), "expected the missing branch name in the error, got: {}", res.message);
}

#[test]
fn push_branch_rejects_a_branch_name_that_looks_like_a_flag() {
    let (_origin, local) = origin_and_clone("push_branch_flag_branch");
    let res = tauri::async_runtime::block_on(push_branch(local.path(), "--upload-pack=evil".to_string(), None, None));
    assert!(!res.ok);
    assert!(res.message.contains("flag"), "expected a flag-injection refusal, got: {}", res.message);
}

#[test]
fn push_branch_rejects_a_remote_branch_name_that_looks_like_a_flag() {
    let (_origin, local) = origin_and_clone("push_branch_flag_remote_branch");
    local.must(&["branch", "feature"]);
    let res = tauri::async_runtime::block_on(push_branch(local.path(), "feature".to_string(), None, Some("--upload-pack=evil".to_string())));
    assert!(!res.ok);
    assert!(res.message.contains("flag"), "expected a flag-injection refusal, got: {}", res.message);
}

#[test]
fn push_branch_with_existing_upstream_pushes_new_commits() {
    let (origin, local) = origin_and_clone("push_branch_existing");
    local.must(&["checkout", "-q", "-b", "feature"]);
    let feature_tip = local.commit("g.txt", "1\n", "feature commit");
    local.must(&["push", "-q", "-u", "origin", "feature"]);
    local.must(&["checkout", "-q", "main"]); // back to main, feature stays non-current

    let new_tip = {
        local.must(&["checkout", "-q", "feature"]);
        let t = local.commit("h.txt", "2\n", "another feature commit");
        local.must(&["checkout", "-q", "main"]);
        t
    };
    assert_ne!(origin.rev("feature"), Some(new_tip.clone()), "sanity: origin doesn't have the new commit yet");

    let res = tauri::async_runtime::block_on(push_branch(local.path(), "feature".to_string(), None, None));
    assert!(res.ok, "push_branch failed: {}", res.message);
    assert_eq!(origin.rev("feature"), Some(new_tip));
    assert_ne!(feature_tip, origin.rev("feature").unwrap(), "sanity: origin actually moved past the first push");
}
