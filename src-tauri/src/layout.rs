//! Swimlane DAG layout: assign each commit a lane and emit the per-gap edge
//! segments the canvas renderer draws. Single forward pass over commits in
//! child-before-parent order; lanes are recycled via a free-slot scan.
//!
//! Output matches the prototype's CSR model: for each `gap r` (band between
//! row r and row r+1) a list of segments {top lane @row r, bottom lane @row r+1,
//! colour}. Straight when top == bottom, an S-curve otherwise (merge / converge).
//!
//! [`LayoutBuilder`] is the pushable core this whole module is built from —
//! its `push()` processes exactly one commit at a time against small,
//! self-contained running state (`lanes`/`top_of`/`color_ctr`), which is what
//! lets `commands::stream_graph` interleave layout with the revwalk itself
//! and emit batches as they're ready, instead of waiting for the whole walk
//! to finish first. [`layout`] (the original, still-used-by-tests batch
//! entry point) is now just a thin loop over `LayoutBuilder::push` that
//! reassembles the exact same [`Layout`]/CSR shape — a behavior-preserving
//! wrapper, not a parallel implementation to keep in sync.

use git2::Oid;

use crate::git_read::RawCommit;

pub const NCOL: u8 = 7;

struct Lane {
    target: Oid, // the parent commit this descending line is heading toward
    color: u8,
}

pub struct Layout {
    pub lane: Vec<i16>,
    pub color: Vec<u8>,
    pub merge: Vec<u8>,
    pub gap_start: Vec<i32>,
    pub gap_top: Vec<i16>,
    pub gap_bot: Vec<i16>,
    pub gap_color: Vec<u8>,
    pub lane_count: usize,
}

/// Find the lowest free lane index (reuse recycles branch lanes so the graph
/// stays compact); grow if none free. Initialises the new lane's `top_of`.
fn alloc(lanes: &mut Vec<Option<Lane>>, top_of: &mut Vec<i16>) -> usize {
    for l in 0..lanes.len() {
        if lanes[l].is_none() {
            top_of[l] = l as i16;
            return l;
        }
    }
    lanes.push(None);
    top_of.push((lanes.len() - 1) as i16);
    lanes.len() - 1
}

/// One commit's own layout result from [`LayoutBuilder::push`].
pub struct RowOut {
    pub lane: i16,
    pub color: u8,
    pub merge: u8,
    /// Gap segments finalized as a side effect of processing this commit —
    /// these belong to the PREVIOUS commit's own trailing gap (the band
    /// between it and THIS commit), not this commit's own. Empty on the very
    /// first `push()` call (no prior lane state exists yet to close out) and,
    /// by construction, on any call where every incoming lane converges
    /// straight down with nothing else active — same semantics the original
    /// single-pass `layout()` loop's `if r>0 { gaps[r-1]... }` block had.
    pub gap_segments: Vec<(i16, i16, u8)>,
}

/// Incremental swimlane layout: feed commits one at a time via [`push`],
/// child-before-parent order (the same order `walk_repo`'s revwalk already
/// produces) — see this module's own doc comment for why this shape exists.
///
/// [`push`]: LayoutBuilder::push
#[derive(Default)]
pub struct LayoutBuilder {
    lanes: Vec<Option<Lane>>,
    top_of: Vec<i16>, // per active lane: its x at the top of the next gap
    color_ctr: u32,
    lane_count: usize,
}

impl LayoutBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// High-water lane count so far (the max graph width seen across every
    /// `push()` call so far) — `Layout::lane_count`'s incremental source.
    pub fn lane_count(&self) -> usize {
        self.lane_count
    }

    /// Process exactly one commit, in child-before-parent order, mutating
    /// this builder's running lane state and returning that commit's own
    /// lane/color/merge assignment plus the previous commit's now-finalized
    /// trailing gap (see [`RowOut`]'s own doc comment on that indexing).
    pub fn push(&mut self, c: &RawCommit) -> RowOut {
        // 1) which active lanes are heading toward this commit?
        let mut incoming: Vec<usize> = Vec::new();
        for l in 0..self.lanes.len() {
            if let Some(ln) = &self.lanes[l] {
                if ln.target == c.id {
                    incoming.push(l);
                }
            }
        }
        let cl: usize;
        let color_c: u8;
        if incoming.is_empty() {
            cl = alloc(&mut self.lanes, &mut self.top_of); // branch tip
            color_c = (self.color_ctr % NCOL as u32) as u8;
            self.color_ctr += 1;
        } else {
            cl = *incoming.iter().min().unwrap();
            color_c = self.lanes[cl].as_ref().unwrap().color;
        }

        // 2) the PREVIOUS commit's own trailing gap, with the incoming lanes
        // converging into cl — empty when self.lanes was empty coming in
        // (the very first push), matching the original loop's `if r>0` guard.
        let mut gap_segments = Vec::new();
        for l in 0..self.lanes.len() {
            if let Some(ln) = &self.lanes[l] {
                let bot = if incoming.contains(&l) { cl as i16 } else { l as i16 };
                gap_segments.push((self.top_of[l], bot, ln.color));
            }
        }

        // 3) transition lanes for this commit's outgoing edges (state descending below this row).
        for &l in &incoming {
            if l != cl {
                self.lanes[l] = None; // converged into cl; recycle
            }
        }
        if c.parents.is_empty() {
            self.lanes[cl] = None; // root: lane tips out
        } else {
            self.lanes[cl] = Some(Lane { target: c.parents[0], color: color_c }); // first parent continues
        }
        // default: every still-active line goes straight down in the next gap
        for l in 0..self.lanes.len() {
            if self.lanes[l].is_some() {
                self.top_of[l] = l as i16;
            }
        }
        // extra parents (merge): each diverges into a fresh lane, originating from cl
        if c.parents.len() > 1 {
            for pk in c.parents.iter().skip(1) {
                let fl = alloc(&mut self.lanes, &mut self.top_of);
                let col = (self.color_ctr % NCOL as u32) as u8;
                self.color_ctr += 1;
                self.lanes[fl] = Some(Lane { target: *pk, color: col });
                self.top_of[fl] = cl as i16; // its first segment curves out from cl
            }
        }

        self.lane_count = self.lane_count.max(self.lanes.len());

        RowOut { lane: cl as i16, color: color_c, merge: if c.parents.len() > 1 { 1 } else { 0 }, gap_segments }
    }
}

/// Batch entry point — a thin loop over [`LayoutBuilder::push`] that
/// reassembles the exact same CSR-flattened [`Layout`] the original
/// single-pass implementation produced. Existing callers/tests use this
/// unchanged; new streaming code (`commands::stream_graph`) drives
/// `LayoutBuilder` directly instead.
pub fn layout(commits: &[RawCommit]) -> Layout {
    let n = commits.len();
    let mut builder = LayoutBuilder::new();
    let mut lane_out = vec![0i16; n];
    let mut color_out = vec![0u8; n];
    let mut merge_out = vec![0u8; n];
    let mut gaps: Vec<Vec<(i16, i16, u8)>> = vec![Vec::new(); n];

    for (r, c) in commits.iter().enumerate() {
        let out = builder.push(c);
        lane_out[r] = out.lane;
        color_out[r] = out.color;
        merge_out[r] = out.merge;
        if r > 0 {
            gaps[r - 1] = out.gap_segments;
        }
    }

    // flatten gaps -> CSR
    let total: usize = gaps.iter().map(|g| g.len()).sum();
    let mut gap_start = vec![0i32; n + 1];
    let mut gap_top = Vec::with_capacity(total);
    let mut gap_bot = Vec::with_capacity(total);
    let mut gap_color = Vec::with_capacity(total);
    let mut idx = 0i32;
    for r in 0..n {
        gap_start[r] = idx;
        for &(t, b, c) in &gaps[r] {
            gap_top.push(t);
            gap_bot.push(b);
            gap_color.push(c);
            idx += 1;
        }
    }
    gap_start[n] = idx;

    Layout {
        lane: lane_out,
        color: color_out,
        merge: merge_out,
        gap_start,
        gap_top,
        gap_bot,
        gap_color,
        lane_count: builder.lane_count(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Oid;

    /// Deterministic fake oid, no real repo needed — `Oid::from_str` accepts
    /// any valid (possibly short, zero-extended) hex string.
    fn oid(hex: &str) -> Oid {
        Oid::from_str(hex).expect("valid hex")
    }

    fn commit(id: &str, parents: &[&str]) -> RawCommit {
        RawCommit {
            id: oid(id),
            parents: parents.iter().map(|p| oid(p)).collect(),
            subject: format!("commit {id}"),
            author: (String::new(), String::new(), 0),
            committer: (String::new(), String::new(), 0),
        }
    }

    /// Flatten a `Layout`'s CSR gap arrays back into one `Vec<(i16,i16,u8)>`
    /// per row — easier to compare/assert against than raw CSR offsets.
    fn gaps_per_row(l: &Layout) -> Vec<Vec<(i16, i16, u8)>> {
        let n = l.lane.len();
        (0..n)
            .map(|r| {
                let s = l.gap_start[r] as usize;
                let e = l.gap_start[r + 1] as usize;
                (s..e).map(|i| (l.gap_top[i], l.gap_bot[i], l.gap_color[i])).collect()
            })
            .collect()
    }

    /// `LayoutBuilder::push`, driven manually one commit at a time and
    /// reassembled BY HAND the same way `layout()` itself does internally,
    /// must reproduce `layout()`'s own output exactly — the property that
    /// matters for `commands::stream_graph`, which drives `push()` directly
    /// (across many separate batches) rather than through this loop.
    fn assert_manual_push_matches_layout(commits: &[RawCommit]) {
        let expected = layout(commits);

        let mut builder = LayoutBuilder::new();
        let mut lane = Vec::new();
        let mut color = Vec::new();
        let mut merge = Vec::new();
        // out.gap_segments returned while processing row r belongs to row
        // r-1's own trailing gap (empty/unused at r=0) — same indexing
        // `layout()` itself uses internally (`if r > 0 { gaps[r-1] = ... }`).
        let mut gaps: Vec<Vec<(i16, i16, u8)>> = Vec::new();
        for (r, c) in commits.iter().enumerate() {
            let out = builder.push(c);
            lane.push(out.lane);
            color.push(out.color);
            merge.push(out.merge);
            if r > 0 {
                gaps.push(out.gap_segments);
            }
        }
        // The very last commit's own trailing gap is never finalized (there's
        // nothing below the last row) — matches `layout()`'s own indexing.

        assert_eq!(lane, expected.lane);
        assert_eq!(color, expected.color);
        assert_eq!(merge, expected.merge);
        assert_eq!(gaps, gaps_per_row(&expected)[..gaps.len()]);
        assert_eq!(builder.lane_count(), expected.lane_count);
    }

    #[test]
    fn linear_history_single_lane() {
        let commits = vec![commit("3", &["2"]), commit("2", &["1"]), commit("1", &[])];
        let l = layout(&commits);
        assert_eq!(l.lane, vec![0, 0, 0]);
        assert_eq!(l.lane_count, 1);
        assert_manual_push_matches_layout(&commits);
    }

    #[test]
    fn branch_and_merge_widens_then_recycles_lanes() {
        // c4 (merge, parents c3+c2) -> c3 (main) -> c1 (root)
        //                           -> c2 (feature) -> c1 (root)
        let commits = vec![
            commit("4", &["3", "2"]),
            commit("3", &["1"]),
            commit("2", &["1"]),
            commit("1", &[]),
        ];
        let l = layout(&commits);
        assert_eq!(l.merge, vec![1, 0, 0, 0]);
        assert!(l.lane_count >= 2, "a real branch+merge must widen past 1 lane");
        assert_manual_push_matches_layout(&commits);
    }

    #[test]
    fn octopus_merge_opens_one_lane_per_extra_parent() {
        let commits = vec![
            commit("5", &["4", "3", "2"]), // 3-parent octopus merge
            commit("4", &["1"]),
            commit("3", &["1"]),
            commit("2", &["1"]),
            commit("1", &[]),
        ];
        let l = layout(&commits);
        assert_eq!(l.merge[0], 1);
        assert!(l.lane_count >= 3, "an octopus merge with 3 parents needs at least 3 lanes");
        assert_manual_push_matches_layout(&commits);
    }

    #[test]
    fn push_on_a_fresh_builder_returns_no_gap_segments() {
        let mut b = LayoutBuilder::new();
        let out = b.push(&commit("1", &[]));
        assert!(out.gap_segments.is_empty(), "the first push has no prior lane state to close out");
    }

    #[test]
    fn empty_history_produces_an_empty_layout() {
        let l = layout(&[]);
        assert!(l.lane.is_empty());
        assert_eq!(l.gap_start, vec![0]);
        assert_eq!(l.lane_count, 0);
    }
}
