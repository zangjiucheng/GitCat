//! Remote sync (fetch / pull / push) against a local bare repo standing in
//! for a real remote — a filesystem path is a valid git remote URL, so this
//! needs no network access, same technique real git itself uses for
//! `file://` remotes.

mod common;

use common::TempRepo;
use gitcat_lib::git_remote::{fetch, pull, push};

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

    let res = fetch(local.path(), None);
    assert!(res.ok, "fetch failed: {}", res.message);
    assert_eq!(local.rev("refs/remotes/origin/main"), Some(new_tip));
    assert_eq!(local.rev("HEAD"), head_before, "fetch must never move local HEAD");
    assert!(res.backup_ref.is_none(), "fetch never snapshots — nothing local changed");
}

#[test]
fn fetch_named_remote_validates_the_name() {
    let (_origin, local) = origin_and_clone("fetch_validate");
    let res = fetch(local.path(), Some("--upload-pack=evil".to_string()));
    assert!(!res.ok);
    assert!(res.message.contains("flag"), "expected a flag-injection refusal, got: {}", res.message);
}

#[test]
fn pull_fast_forwards_and_snapshots_first() {
    let (origin, local) = origin_and_clone("pull_ff");
    let other = second_clone(&origin, "pull_ff");
    let new_tip = other.commit("g.txt", "1\n", "c1");
    other.must(&["push", "-q", "origin", "main"]);

    let res = pull(local.path());
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

    let res = pull(local.path());
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
    let res = push(local.path());
    assert!(res.ok, "push failed: {}", res.message);
    assert_eq!(origin.rev("main"), local.rev("HEAD"), "origin's bare main should now match local HEAD");

    let (has_upstream, _, _) = local.git(&["rev-parse", "--abbrev-ref", "main@{upstream}"]);
    assert!(has_upstream, "push with no existing upstream should set one via --set-upstream");
}

#[test]
fn push_with_existing_upstream_does_not_need_set_upstream_again() {
    let (origin, local) = origin_and_clone("push_existing");
    let new_tip = local.commit("g.txt", "1\n", "c1");

    let res = push(local.path());
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
    let res = push(local.path());
    assert!(!res.ok, "a non-fast-forward push must be rejected");
    assert_eq!(origin.rev("main"), Some(their_tip), "a rejected push must never overwrite origin");
}
