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
