//! Graph read + layout (model after examples/graphcheck.rs).
//!
//! Builds a small temp repo with a linear run, a diverging branch, and a merge
//! commit, then drives `gitcat_lib::commands::build_graph` (the non-#[tauri::
//! command] entry point `load_graph` wraps) and asserts the row count, that a
//! merge commit is flagged, that sha/subject round-trip, and that the swimlane
//! layout never assigns the same lane to two active lines within one gap.

mod common;

use std::collections::HashSet;

use gitcat_lib::commands::build_graph;
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

    let g = build_graph(&path, 50_000).expect("build_graph failed");

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
fn graph_layout_has_no_impossible_lane_overlaps() {
    let (repo, _) = build_repo();
    let path = repo.path();
    let g = build_graph(&path, 50_000).expect("build_graph failed");

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

    let g = build_graph(&path, 2).expect("build_graph failed");
    assert_eq!(g.n, 2, "limit=2 should cap the walk to 2 commits");
    assert_eq!(g.rows.len(), 2);
}
