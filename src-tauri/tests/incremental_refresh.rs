//! Incremental graph refresh — the two testable cores behind the frontend's
//! fast path (`graph_fast_refresh_core`, `head_ancestor_flags_core`), which let
//! `reloadGraph` skip a full history re-walk when the commit DAG is unchanged.
//!
//! No `AppHandle` needed (same split as `stream_graph_core` — see graph.rs):
//! both cores take the visible-branch filter explicitly.

mod common;

use gitcat_lib::commands::{graph_fast_refresh_core, head_ancestor_flags_core, stream_graph_core};
use gitcat_lib::model::GraphBatch;

/// main:  c0 -- c1 -- c3 (HEAD)
///                \
/// feature:        c2
/// c3 is HEAD; c2 lives only on `feature`. So the ancestors-of-HEAD set is
/// {c0, c1, c3} and c2 is NOT an ancestor — a real true/false mix to check the
/// dimming bits against.
fn build_diverged() -> (common::TempRepo, [String; 4]) {
    let repo = common::TempRepo::init("incr");
    let c0 = repo.commit("f.txt", "0\n", "c0 root");
    let c1 = repo.commit("f.txt", "1\n", "c1 second");
    repo.must(&["branch", "feature"]);
    repo.must(&["checkout", "-q", "feature"]);
    let c2 = repo.commit("g.txt", "on feature\n", "c2 on feature");
    repo.must(&["checkout", "-q", "main"]);
    let c3 = repo.commit("h.txt", "on main\n", "c3 on main");
    (repo, [c0, c1, c2, c3])
}

/// Drive stream_graph_core (the real graph load) and return, per row, the full
/// oid + the `ancestor` bit it emitted. NOTE: the stream now DEFERS the dimming
/// bit — it emits `ancestor: false` for every row (see stream_graph_core's own
/// doc), because computing it up front meant a full HEAD-ancestor revwalk that
/// delayed the first frame. head_ancestor_flags_core is what supplies the real
/// bits, positionally aligned to these rows; that alignment is what the tests
/// below verify (it's what the frontend's recomputeAncestorsAsync relies on).
fn stream_rows(path: &str) -> Vec<(String, bool)> {
    let mut batches: Vec<GraphBatch> = Vec::new();
    stream_graph_core(path, None, None, 1, 100, usize::MAX, || false, |b| batches.push(b));
    let mut out = Vec::new();
    for b in &batches {
        for (i, oid) in b.oids.iter().enumerate() {
            out.push((oid.clone(), b.rows[i].ancestor));
        }
    }
    out
}

#[test]
fn head_ancestor_flags_core_aligns_with_the_stream_and_supplies_the_deferred_dimming_bits() {
    let (repo, [c0, c1, c2, c3]) = build_diverged();
    let path = repo.path();

    let rows = stream_rows(&path); // (full oid, ancestor) per row, in walk order
    let af = head_ancestor_flags_core(&path, None, None);

    // The stream DEFERS the dimming bit — every row comes back undimmed.
    assert!(rows.iter().all(|(_, a)| !*a), "stream_graph_core emits ancestor:false for every row (deferred)");

    // head_ancestor_flags_core supplies the REAL bits, POSITIONALLY aligned to the
    // same rows (same count, same walk order) — the alignment the frontend relies
    // on to apply flags[i] to row i in recomputeAncestorsAsync.
    assert_eq!(af.n, rows.len(), "flag count must equal the streamed row count");
    assert_eq!(af.flags.len(), af.n);

    // Map each row's oid to the flag at its position; it must be a genuine mix
    // (guards against an all-true/all-false vacuous pass).
    let flag_of = |want: &str| rows.iter().position(|(o, _)| o == want).map(|i| af.flags[i]);
    assert_eq!(flag_of(&c0), Some(true), "c0 is an ancestor of HEAD");
    assert_eq!(flag_of(&c1), Some(true), "c1 is an ancestor of HEAD");
    assert_eq!(flag_of(&c3), Some(true), "c3 IS HEAD");
    assert_eq!(flag_of(&c2), Some(false), "c2 (feature-only) is NOT an ancestor of HEAD");
}

#[test]
fn head_ancestor_flags_core_tracks_head_after_a_checkout() {
    let (repo, [_c0, _c1, c2, _c3]) = build_diverged();
    let path = repo.path();
    // Move HEAD onto feature (c2) — now c2 IS an ancestor and the main-only c3 is not.
    repo.must(&["checkout", "-q", "feature"]);

    let rows = stream_rows(&path);
    let af = head_ancestor_flags_core(&path, None, None);
    assert_eq!(af.n, rows.len());
    assert!(rows.iter().all(|(_, a)| !*a), "stream defers the ancestor bit");

    // Positionally map c2's row to its flag — after the checkout it must be dimmed.
    let c2_is_ancestor = rows.iter().position(|(o, _)| o == &c2).map(|i| af.flags[i]);
    assert_eq!(c2_is_ancestor, Some(true), "after checking out feature, c2 is an ancestor of HEAD");
}

#[test]
fn fast_refresh_seed_tips_and_head_honor_the_visibility_filter() {
    let (repo, [_c0, _c1, c2, c3]) = build_diverged();
    let path = repo.path();

    // Unfiltered: both branch tips seed the walk; HEAD resolves to c3 (main).
    let fr = graph_fast_refresh_core(&path, None, None).expect("fast refresh");
    assert_eq!(fr.head_oid.as_deref(), Some(c3.as_str()));
    assert!(fr.seed_tips.contains(&c3), "main tip is a seed");
    assert!(fr.seed_tips.contains(&c2), "feature tip is a seed when unfiltered");

    // Filter to just main: feature's tip must drop out of the seed set.
    let only_main = [String::from("main")];
    let fr = graph_fast_refresh_core(&path, Some(&only_main), Some(&[])).expect("fast refresh");
    assert!(fr.seed_tips.contains(&c3), "main tip still a seed");
    assert!(!fr.seed_tips.contains(&c2), "hidden feature tip is not a seed");
}

#[test]
fn fast_refresh_resolves_a_detached_head() {
    let (repo, [c0, _c1, _c2, _c3]) = build_diverged();
    let path = repo.path();
    repo.must(&["checkout", "-q", &c0]); // detached HEAD on the root commit

    let fr = graph_fast_refresh_core(&path, None, None).expect("fast refresh");
    // RefList.head would be None here (a branch name); head_oid resolves anyway.
    assert_eq!(fr.head_oid.as_deref(), Some(c0.as_str()), "detached HEAD still resolves to an oid");
}

#[test]
fn fast_refresh_on_an_unborn_head_has_no_head_and_no_seeds() {
    // `init` makes the repo but no commit — HEAD is unborn until the first commit.
    let repo = common::TempRepo::init("incr-unborn");
    let fr = graph_fast_refresh_core(&repo.path(), None, None).expect("fast refresh");
    assert_eq!(fr.head_oid, None, "an unborn HEAD (no commits) resolves to no oid");
    assert!(fr.seed_tips.is_empty(), "no branches yet ⇒ no seed tips");
}

#[test]
fn fast_refresh_ref_sig_is_stable_across_a_pure_worktree_change_but_moves_with_refs() {
    let (repo, _shas) = build_diverged();
    let path = repo.path();

    let base = graph_fast_refresh_core(&path, None, None).unwrap().ref_sig;
    // Same call again — deterministic signature.
    assert_eq!(graph_fast_refresh_core(&path, None, None).unwrap().ref_sig, base);

    // A pure working-tree edit (uncommitted) moves no ref and no HEAD.
    std::fs::write(std::path::Path::new(&path).join("f.txt"), "dirty\n").unwrap();
    assert_eq!(
        graph_fast_refresh_core(&path, None, None).unwrap().ref_sig,
        base,
        "a dirty working tree must NOT change the ref signature"
    );

    // Creating a tag changes the ref set.
    repo.must(&["tag", "v1"]);
    let after_tag = graph_fast_refresh_core(&path, None, None).unwrap().ref_sig;
    assert_ne!(after_tag, base, "adding a tag changes the ref signature");

    // Creating a branch changes it again.
    repo.must(&["branch", "another"]);
    assert_ne!(
        graph_fast_refresh_core(&path, None, None).unwrap().ref_sig,
        after_tag,
        "adding a branch changes the ref signature"
    );
}

#[test]
fn fast_refresh_ref_chips_match_the_streamed_per_row_chips() {
    let (repo, _shas) = build_diverged();
    let path = repo.path();
    repo.must(&["tag", "v1"]); // give at least one commit a tag chip too

    // What the full streaming load attaches per row, keyed by full oid.
    let mut batches: Vec<GraphBatch> = Vec::new();
    stream_graph_core(&path, None, None, 1, 100, usize::MAX, || false, |b| batches.push(b));

    let fr = graph_fast_refresh_core(&path, None, None).expect("fast refresh");
    let chip_map: std::collections::HashMap<String, Vec<gitcat_lib::model::RefChip>> =
        fr.ref_chips.into_iter().collect();

    for b in &batches {
        for (i, oid) in b.oids.iter().enumerate() {
            let streamed = &b.rows[i].refs;
            let fast = chip_map.get(oid).cloned().unwrap_or_default();
            let key = |c: &gitcat_lib::model::RefChip| (c.n.clone(), c.t.clone());
            let streamed_keys: Vec<_> = streamed.iter().map(key).collect();
            let fast_keys: Vec<_> = fast.iter().map(&key).collect();
            assert_eq!(
                fast_keys, streamed_keys,
                "fast-refresh chips must match the streamed chips (order + kind) for oid {oid}"
            );
        }
    }
}
