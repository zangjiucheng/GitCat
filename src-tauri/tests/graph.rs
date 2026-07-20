//! Graph read + layout (model after examples/graphcheck.rs).
//!
//! Builds a small temp repo with a linear run, a diverging branch, and a merge
//! commit, then drives `gitcat_lib::commands::build_graph` (the batch entry
//! point) and `gitcat_lib::commands::stream_graph_core` (the streaming entry
//! point `load_graph` now actually uses — see commands.rs's own doc comment
//! on why it's split out testable, no `AppHandle` needed, exactly like
//! `watch.rs`'s `start_watching`/`git_bisect.rs`'s `run_bisect`), and asserts
//! the row count, that a merge commit is flagged, that sha/subject
//! round-trip, and that the swimlane layout never assigns the same lane to
//! two active lines within one gap.

mod common;

use std::collections::HashSet;

use gitcat_lib::commands::{ancestors_of, build_graph, stream_graph_core};
use gitcat_lib::model::GraphBatch;
use common::short;

/// Topology built here:
///
/// ```text
/// c0 (root) -- c1 -- c3 (main) --\
///                \                 c4 (merge, main)
///                 c2 (feature) --/
/// ```
fn build_repo() -> (common::TempRepo, [String; 5]) {
    let repo = common::TempRepo::init("graph");
    let c0 = repo.commit("f.txt", "0\n", "c0 root");
    let c1 = repo.commit("f.txt", "1\n", "c1 second");
    repo.must(&["branch", "feature"]);
    repo.must(&["checkout", "-q", "feature"]);
    let c2 = repo.commit("g.txt", "on feature\n", "c2 on feature");
    repo.must(&["checkout", "-q", "main"]);
    let c3 = repo.commit("h.txt", "on main\n", "c3 on main");
    repo.must(&["merge", "--no-ff", "--no-edit", "-q", "feature"]);
    let c4 = repo.must(&["rev-parse", "HEAD"]);
    (repo, [c0, c1, c2, c3, c4])
}

#[test]
fn graph_row_count_and_merge_flag() {
    let (repo, [c0, c1, c2, c3, c4]) = build_repo();
    let path = repo.path();

    let g = build_graph(&path, 50_000, None, None).expect("build_graph failed");

    // 5 commits: c0, c1, c2 (feature), c3 (main), c4 (merge).
    assert_eq!(g.n, 5, "expected 5 commits, got {}", g.n);
    assert_eq!(g.rows.len(), 5);

    // Exactly one row is a merge (>=2 parents): c4.
    let merge_rows: Vec<usize> = g
        .rows
        .iter()
        .enumerate()
        .filter(|(_, r)| r.merge)
        .map(|(i, _)| i)
        .collect();
    assert_eq!(merge_rows.len(), 1, "expected exactly one merge row, got {merge_rows:?}");

    let merge_row = &g.rows[merge_rows[0]];
    assert_eq!(merge_row.sha, short(&c4));
    assert!(merge_row.subject.contains("Merge"), "unexpected merge subject: {}", merge_row.subject);

    // sha/subject for every commit we made round-trip through the payload.
    let expect = [
        (&c0, "c0 root"),
        (&c1, "c1 second"),
        (&c2, "c2 on feature"),
        (&c3, "c3 on main"),
    ];
    for (sha, subject) in expect {
        let row = g
            .rows
            .iter()
            .find(|r| r.sha == short(sha))
            .unwrap_or_else(|| panic!("no row for commit {sha} ({subject})"));
        assert_eq!(row.subject, subject);
    }

    // HEAD (main) ref chip should land on the merge commit's row.
    assert!(
        merge_row.refs.iter().any(|r| r.n == "main" && r.t == "head"),
        "expected a head ref chip named 'main' on the merge row, got {:?}",
        merge_row.refs.iter().map(|r| (&r.n, &r.t)).collect::<Vec<_>>()
    );
}

#[test]
fn multi_kind_ref_chips_on_one_commit_sort_tag_before_head_before_branch_before_remote() {
    let repo = common::TempRepo::init("multiref");
    let c0 = repo.commit("f.txt", "0\n", "c0 root");
    // A second local branch, NOT checked out, pointing at the same commit as
    // HEAD (main) — its chip must come out as "branch", distinct from main's
    // own "head" chip.
    repo.must(&["branch", "also-local", &c0]);
    // A tag on the same commit.
    repo.must(&["tag", "v1.0", &c0]);
    // A remote-tracking ref, same commit — read_repo only looks at the ref
    // itself, no real configured remote needed (see
    // local_and_remote_filters_apply_independently above for the same trick).
    repo.must(&["update-ref", "refs/remotes/origin/main", &c0]);

    let g = build_graph(&repo.path(), 50_000, None, None).expect("build_graph failed");
    let row = g.rows.iter().find(|r| r.sha == short(&c0)).expect("commit must have a row");

    let kinds: Vec<&str> = row.refs.iter().map(|r| r.t.as_str()).collect();
    assert_eq!(
        kinds,
        vec!["tag", "head", "branch", "remote"],
        "ref chips on one commit must sort tag -> head -> branch -> remote, got {:?}",
        row.refs.iter().map(|r| (&r.n, &r.t)).collect::<Vec<_>>()
    );
}

#[test]
fn ancestors_of_a_branch_tip_excludes_a_divergent_sibling_on_another_branch() {
    // Regression test for the exact bug legalPick/legalMerge's old row-index
    // approximation had: build_repo()'s c3 (on main) and c2 (on feature) are
    // DIVERGENT siblings — neither is the other's ancestor — but c2 was
    // committed first, so in newest-first row order c3 (younger) sits at a
    // SMALLER row index than c2. The old `tgt > src` check would have
    // wrongly flagged c2 as "an ancestor" of c3 for exactly this reason.
    let (repo, [c0, c1, c2, c3, c4]) = build_repo();
    let path = repo.path();

    let ancestors_of_c3 = ancestors_of(path.clone(), c3.clone()).expect("ancestors_of failed");
    let short_c2 = short(&c2);
    assert!(
        !ancestors_of_c3.contains(&short_c2),
        "c2 (a divergent sibling on another branch) must NOT be reported as an ancestor of c3, got {ancestors_of_c3:?}"
    );
    // c3's real ancestors: itself, c1, c0.
    for real_ancestor in [&c3, &c1, &c0] {
        assert!(
            ancestors_of_c3.contains(&short(real_ancestor)),
            "expected {real_ancestor} (shortened) among c3's ancestors, got {ancestors_of_c3:?}"
        );
    }

    // The merge commit c4, on the other hand, genuinely descends from BOTH
    // branches — c2 legitimately IS one of its ancestors.
    let ancestors_of_c4 = ancestors_of(path.clone(), c4.clone()).expect("ancestors_of failed");
    assert!(
        ancestors_of_c4.contains(&short_c2),
        "c2 must be a real ancestor of the merge commit c4, got {ancestors_of_c4:?}"
    );
}

#[test]
fn graph_layout_has_no_impossible_lane_overlaps() {
    let (repo, _) = build_repo();
    let path = repo.path();
    let g = build_graph(&path, 50_000, None, None).expect("build_graph failed");

    // Every lane index actually used (row assignment, and every gap segment
    // endpoint) must fit inside the reported `lane_count` high-water mark.
    for (i, &lane) in g.lane.iter().enumerate() {
        assert!(
            lane >= 0 && (lane as usize) < g.lane_count,
            "row {i}: lane {lane} out of bounds (lane_count={})",
            g.lane_count
        );
    }
    for (i, (&t, &b)) in g.gap_top.iter().zip(g.gap_bot.iter()).enumerate() {
        assert!(
            t >= 0 && (t as usize) < g.lane_count,
            "gap segment {i}: top lane {t} out of bounds"
        );
        assert!(
            b >= 0 && (b as usize) < g.lane_count,
            "gap segment {i}: bottom lane {b} out of bounds"
        );
    }

    // Structural sanity on the CSR index: gap_start is non-decreasing and its
    // last entry accounts for every emitted segment (graphcheck.rs's "edge
    // segments" count is exactly `gap_top.len()`).
    assert_eq!(g.gap_start.len(), g.n + 1);
    for w in g.gap_start.windows(2) {
        assert!(w[1] >= w[0], "gap_start must be non-decreasing: {w:?}");
    }
    let total = *g.gap_start.last().unwrap() as usize;
    assert_eq!(total, g.gap_top.len());
    assert_eq!(total, g.gap_bot.len());
    assert_eq!(total, g.gap_color.len());

    // Within a single gap (the band between row r and row r+1), each active
    // lane contributes exactly one segment (see layout.rs's single pass over
    // `lanes`), identified by its (top, bottom) endpoints — a fork (merge
    // commit branching into 2 parents) legitimately shares one TOP across two
    // segments with DIFFERENT bottoms, and a convergence legitimately shares
    // one BOTTOM across segments with different tops. What must never happen
    // is the exact same (top, bottom) pair twice in one gap — that would be
    // the same line drawn twice, i.e. an "impossible overlap".
    for r in 0..g.n {
        let start = g.gap_start[r] as usize;
        let end = g.gap_start[r + 1] as usize;
        let mut seen_pairs: HashSet<(i16, i16)> = HashSet::new();
        for idx in start..end {
            let pair = (g.gap_top[idx], g.gap_bot[idx]);
            assert!(
                seen_pairs.insert(pair),
                "row {r}: segment {pair:?} duplicated within the same gap"
            );
        }
    }

    // Sanity: with one merge and one extra branch tip, the graph is wider than
    // a single lane.
    assert!(g.lane_count >= 2, "expected at least 2 lanes, got {}", g.lane_count);
}

#[test]
fn graph_respects_limit() {
    let (repo, _) = build_repo();
    let path = repo.path();

    let g = build_graph(&path, 2, None, None).expect("build_graph failed");
    assert_eq!(g.n, 2, "limit=2 should cap the walk to 2 commits");
    assert_eq!(g.rows.len(), 2);
}

// ---------------------------------------------------------------------------
// Branch-visibility filtering — read_repo's visible_local/visible_remote params.
// ---------------------------------------------------------------------------

/// Two branches that DIVERGE and are never merged back together — unlike
/// `build_repo()`'s topology, this lets a filter genuinely exclude one
/// branch's unique commits, not just its ref chip. HEAD ends on `main`.
///
/// ```text
/// c0 (root) -- c1 (main, HEAD)
///          \-- c2 (feature)
/// ```
fn build_diverged_repo() -> (common::TempRepo, [String; 3]) {
    let repo = common::TempRepo::init("graph_filter");
    let c0 = repo.commit("f.txt", "0\n", "c0 root");
    repo.must(&["branch", "feature"]); // branches off c0 without switching
    let c1 = repo.commit("f.txt", "1 on main\n", "c1 on main only");
    repo.must(&["checkout", "-q", "feature"]);
    let c2 = repo.commit("g.txt", "on feature\n", "c2 on feature only");
    repo.must(&["checkout", "-q", "main"]); // HEAD ends on main
    (repo, [c0, c1, c2])
}

fn has_subject(g: &gitcat_lib::model::GraphData, subject: &str) -> bool {
    g.rows.iter().any(|r| r.subject == subject)
}

#[test]
fn unfiltered_walk_includes_both_diverged_branches() {
    let (repo, _) = build_diverged_repo();
    let g = build_graph(&repo.path(), 50_000, None, None).expect("build_graph failed");
    assert!(has_subject(&g, "c1 on main only"));
    assert!(has_subject(&g, "c2 on feature only"));
}

#[test]
fn empty_local_filter_still_shows_the_current_branch_via_push_head() {
    let (repo, _) = build_diverged_repo();
    // HEAD is on main; local filter is explicitly empty (no branch NAMED),
    // and no remotes either — only push_head()'s own unconditional inclusion
    // should surface anything beyond the shared root.
    let g = build_graph(&repo.path(), 50_000, Some(&[]), Some(&[])).expect("build_graph failed");
    assert!(has_subject(&g, "c0 root"));
    assert!(has_subject(&g, "c1 on main only"), "HEAD's own branch must stay visible regardless of the filter");
    assert!(!has_subject(&g, "c2 on feature only"), "feature was excluded and isn't HEAD, so it must not appear");
}

#[test]
fn local_and_remote_filters_apply_independently() {
    let (repo, [_c0, _c1, c2]) = build_diverged_repo();
    // A remote-tracking ref pointing at feature's tip, without a real
    // configured remote — read_repo only ever looks at the ref itself.
    repo.must(&["update-ref", "refs/remotes/origin/feature", &c2]);

    // LOCAL filtered to nothing; REMOTE left unfiltered (None) — the two
    // must not affect each other.
    let g = build_graph(&repo.path(), 50_000, Some(&[]), None).expect("build_graph failed");
    assert!(has_subject(&g, "c1 on main only"), "HEAD (main) always shows regardless of the local filter");
    assert!(
        has_subject(&g, "c2 on feature only"),
        "remote is unfiltered (None), so origin/feature's commit must show even though local 'feature' itself is excluded"
    );
}

#[test]
fn naming_a_branch_in_the_filter_adds_it_alongside_the_forced_head() {
    let (repo, _) = build_diverged_repo();
    let local = vec!["feature".to_string()];
    let g = build_graph(&repo.path(), 50_000, Some(&local), Some(&[])).expect("build_graph failed");
    assert!(has_subject(&g, "c1 on main only"), "HEAD (main) always stays visible");
    assert!(has_subject(&g, "c2 on feature only"), "explicitly selected branch must also show");
}

#[test]
fn a_stale_nonexistent_branch_name_in_the_filter_is_silently_ignored_not_an_error() {
    let (repo, _) = build_diverged_repo();
    let local = vec!["totally-does-not-exist".to_string()];
    let g = build_graph(&repo.path(), 50_000, Some(&local), Some(&[])).expect("a nonexistent branch name in the filter must not error");
    assert!(has_subject(&g, "c1 on main only"), "HEAD still shows regardless");
    assert!(!has_subject(&g, "c2 on feature only"));
}

#[test]
fn hidden_branch_chip_is_dropped_even_though_its_commit_remains_reachable_via_a_visible_branch() {
    // build_repo()'s topology (feature merged into main) — c2 ("feature")
    // stays reachable via main's own ancestry after the merge, so this
    // exercises the chip-filtering path specifically, independent of walk reachability.
    let (repo, [_c0, _c1, c2, _c3, _c4]) = build_repo();
    let local = vec!["main".to_string()]; // "feature" deliberately excluded
    let g = build_graph(&repo.path(), 50_000, Some(&local), Some(&[])).expect("build_graph failed");

    let feature_tip_row = g.rows.iter().find(|r| r.sha == short(&c2)).expect("feature's commit must still be reachable via main's own ancestry");
    assert!(
        !feature_tip_row.refs.iter().any(|r| r.t == "branch" && r.n == "feature"),
        "the 'feature' chip must be dropped when feature isn't in the visible set, even though its commit is still shown: {:?}",
        feature_tip_row.refs.iter().map(|r| (&r.n, &r.t)).collect::<Vec<_>>()
    );
}

// ---------------------------------------------------------------------------
// Streaming (stream_graph_core) — commands.rs's testable core, no AppHandle
// needed. `load_graph` itself just wires this to real GraphLoadState/app.emit.
// ---------------------------------------------------------------------------

/// Concatenate every batch's rows/lane/color/merge, and reconstruct a CSR
/// `gap_start` index from each row's own `gap_counts` entry — the exact
/// inverse of what a real frontend listener does incrementally (see
/// legacy/main.ts's own "graph-batch" handler), used here just to compare
/// against `build_graph`'s own one-shot CSR output.
struct Reconstructed {
    rows: Vec<gitcat_lib::model::CommitMeta>,
    lane: Vec<i16>,
    color: Vec<u8>,
    merge: Vec<u8>,
    gap_start: Vec<i32>,
    gap_top: Vec<i16>,
    gap_bot: Vec<i16>,
    gap_color: Vec<u8>,
    lane_count: usize,
}

fn reconstruct(batches: &[GraphBatch]) -> Reconstructed {
    let mut rows = Vec::new();
    let mut lane = Vec::new();
    let mut color = Vec::new();
    let mut merge = Vec::new();
    let mut gap_start = vec![0i32];
    let mut gap_top = Vec::new();
    let mut gap_bot = Vec::new();
    let mut gap_color = Vec::new();
    let mut lane_count = 0usize;

    for b in batches {
        rows.extend(b.rows.iter().cloned());
        lane.extend(&b.lane);
        color.extend(&b.color);
        merge.extend(&b.merge);
        lane_count = lane_count.max(b.lane_count);

        let mut top_idx = gap_top.len() as i32;
        for &count in &b.gap_counts {
            top_idx += count;
            gap_start.push(top_idx);
        }
        gap_top.extend(&b.gap_top);
        gap_bot.extend(&b.gap_bot);
        gap_color.extend(&b.gap_color);
    }

    Reconstructed { rows, lane, color, merge, gap_start, gap_top, gap_bot, gap_color, lane_count }
}

#[test]
fn stream_graph_core_with_a_small_batch_size_reconstructs_the_same_graph_as_build_graph() {
    let (repo, _) = build_repo();
    let path = repo.path();

    let expected = build_graph(&path, 50_000, None, None).expect("build_graph failed");

    // batch_size=2 against a 5-commit repo forces 3 batches (2, 2, 1) — real
    // multi-batch behavior, not just the trivial single-batch case.
    let mut batches: Vec<GraphBatch> = Vec::new();
    stream_graph_core(&path, None, None, 1, 2, usize::MAX, || false, |b| batches.push(b));

    assert!(batches.len() >= 2, "batch_size=2 on 5 commits should force multiple batches, got {}", batches.len());
    for (i, b) in batches.iter().enumerate() {
        assert_eq!(b.done, i == batches.len() - 1, "only the LAST batch should be marked done");
        assert_eq!(b.generation, 1);
    }
    assert!(batches.last().unwrap().error.is_none());
    assert!(!batches.last().unwrap().truncated, "a complete walk under max_commits must not report truncated");

    let got = reconstruct(&batches);
    assert_eq!(got.lane, expected.lane);
    assert_eq!(got.color, expected.color);
    assert_eq!(got.merge, expected.merge);
    assert_eq!(got.gap_start, expected.gap_start);
    assert_eq!(got.gap_top, expected.gap_top);
    assert_eq!(got.gap_bot, expected.gap_bot);
    assert_eq!(got.gap_color, expected.gap_color);
    assert_eq!(got.lane_count, expected.lane_count);
    assert_eq!(got.rows.len(), expected.rows.len());
    for (g, e) in got.rows.iter().zip(expected.rows.iter()) {
        assert_eq!(g.sha, e.sha);
        assert_eq!(g.subject, e.subject);
        assert_eq!(g.merge, e.merge);
    }
}

#[test]
fn stream_graph_core_stops_early_and_never_marks_done_once_cancelled() {
    let (repo, _) = build_repo(); // 5 commits
    let path = repo.path();

    let mut batches: Vec<GraphBatch> = Vec::new();
    let mut seen = 0usize;
    stream_graph_core(
        &path,
        None,
        None,
        7,
        1, // batch_size=1: emits after every single commit, so cancellation mid-walk is observable
        usize::MAX,
        || {
            seen += 1;
            seen > 2 // cancel after letting 2 commits through
        },
        |b| batches.push(b),
    );

    assert!(!batches.is_empty(), "some batches should have been emitted before cancellation");
    assert!(
        batches.iter().map(|b| b.rows.len()).sum::<usize>() < 5,
        "a cancelled walk must not deliver the full 5-commit history"
    );
    assert!(batches.iter().all(|b| !b.done), "a superseded/cancelled walk must never mark a batch done");
    assert!(batches.iter().all(|b| b.generation == 7));
}

#[test]
fn stream_graph_core_a_bad_path_still_emits_one_final_batch_carrying_the_error() {
    let mut batches: Vec<GraphBatch> = Vec::new();
    stream_graph_core("/no/such/path/at/all", None, None, 1, 100, usize::MAX, || false, |b| batches.push(b));

    assert_eq!(batches.len(), 1, "a bad path should still produce exactly one terminal batch");
    let b = &batches[0];
    assert!(b.done);
    assert!(b.rows.is_empty());
    assert!(b.error.is_some(), "the open failure must be surfaced, not silently swallowed");
}

#[test]
fn stream_graph_core_never_called_with_should_cancel_true_from_the_start_emits_nothing() {
    let (repo, _) = build_repo();
    let mut batches: Vec<GraphBatch> = Vec::new();
    stream_graph_core(&repo.path(), None, None, 1, 100, usize::MAX, || true, |b| batches.push(b));
    assert!(batches.is_empty(), "an already-superseded generation must never emit anything, not even an empty done batch");
}

#[test]
fn stream_graph_core_hitting_max_commits_stops_early_and_marks_the_final_batch_truncated() {
    let (repo, _) = build_repo(); // 5 commits
    let path = repo.path();

    let mut batches: Vec<GraphBatch> = Vec::new();
    // max_commits=3 on a 5-commit repo: must stop well short of the real 5,
    // and unlike cancellation (see
    // stream_graph_core_stops_early_and_never_marks_done_once_cancelled above)
    // this DOES still emit a final done batch — it's a real stopping point the
    // frontend needs to know about, not a superseded walk quietly winding
    // down. Expect max_commits+1 rows, not max_commits exactly: the ceiling
    // check runs BEFORE a commit's own push() (so it can't cut off a commit
    // already in flight), but the one-row lag (a row's trailing gap is only
    // known once the NEXT commit is processed — see LayoutBuilder's own doc
    // comment) means the row already sitting in `pending` when the ceiling
    // trips still gets flushed as the walk's own "last row" — one harmless
    // extra row past the nominal cap, not a real budget violation for a
    // memory backstop.
    stream_graph_core(&path, None, None, 1, 100, 3, || false, |b| batches.push(b));

    assert_eq!(batches.len(), 1, "small enough to fit in one batch");
    let b = &batches[0];
    assert!(b.done, "hitting max_commits is a real stop, not a supersede — must still mark done");
    assert!(b.truncated, "must be flagged truncated so the frontend doesn't mistake this for a complete history");
    assert!(b.error.is_none(), "truncation isn't a walk error");
    assert_eq!(b.rows.len(), 4, "stops at max_commits+1 rows (see comment above), well short of the repo's real 5");
}

#[test]
fn stream_graph_core_a_complete_walk_under_max_commits_is_never_flagged_truncated() {
    let (repo, _) = build_repo(); // 5 commits
    let mut batches: Vec<GraphBatch> = Vec::new();
    stream_graph_core(&repo.path(), None, None, 1, 100, 5, || false, |b| batches.push(b));
    let b = batches.last().expect("at least one batch");
    assert!(b.done);
    assert!(!b.truncated, "reaching max_commits EXACTLY as the walk naturally ends is a complete finish, not a cap");
    assert_eq!(b.rows.len(), 5);
}
