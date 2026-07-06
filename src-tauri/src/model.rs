//! Serializable graph payload sent to the frontend canvas renderer.
//!
//! The field names use camelCase to match the existing prototype's `draw()`,
//! which consumes a Structure-of-Arrays + a compressed-sparse-row (CSR) edge
//! model so that rendering stays O(visible rows), independent of commit count.

use serde::Serialize;

/// One author/committer identity. `t` is a unix timestamp; the frontend formats it.
#[derive(Serialize)]
pub struct Person {
    pub n: String, // name
    pub e: String, // email
    pub t: i64,    // unix seconds
}

/// A ref chip pointing at a commit. `t` is one of: head | branch | remote | tag.
#[derive(Serialize)]
pub struct RefChip {
    pub n: String, // short label, e.g. "main", "origin/main", "v0.3.0"
    pub t: String, // kind
}

/// Per-commit metadata (one entry per row, row = index).
#[derive(Serialize)]
pub struct CommitMeta {
    pub sha: String,     // short hash (7 chars)
    pub subject: String, // first line of the message
    pub an: Person,      // author
    pub cm: Person,      // committer
    pub refs: Vec<RefChip>,
    pub merge: bool,     // >= 2 parents
}

/// The full graph payload. Rows are in reverse-chronological/topological order
/// (child before parent). `lane`/`color`/`merge` are one-per-row.
///
/// Edges are stored CSR-style: `gap g` is the band between row g and row g+1;
/// `gapStart[g]..gapStart[g+1]` indexes into `gapTop`/`gapBot`/`gapColor`, each
/// entry a line segment {top lane @row g, bottom lane @row g+1, colour index}.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    pub n: usize,
    pub lane: Vec<i16>,
    pub color: Vec<u8>,
    pub merge: Vec<u8>,
    pub gap_start: Vec<i32>,
    pub gap_top: Vec<i16>,
    pub gap_bot: Vec<i16>,
    pub gap_color: Vec<u8>,
    pub rows: Vec<CommitMeta>,
    pub ncol: u8,
    pub lane_count: usize, // high-water lane count (max graph width)
    pub layout_ms: f64,    // layout time, for the perf HUD / M0 benchmark
    pub read_ms: f64,      // git read time
}
