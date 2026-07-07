//! Serializable graph payload sent to the frontend canvas renderer.
//!
//! The field names use camelCase to match the existing prototype's `draw()`,
//! which consumes a Structure-of-Arrays + a compressed-sparse-row (CSR) edge
//! model so that rendering stays O(visible rows), independent of commit count.

use serde::Serialize;

/// One author/committer identity. `t` is a unix timestamp; the frontend formats it.
#[derive(Serialize, specta::Type)]
pub struct Person {
    pub n: String, // name
    pub e: String, // email
    pub t: i64,    // unix seconds
}

/// A ref chip pointing at a commit. `t` is one of: head | branch | remote | tag.
#[derive(Serialize, specta::Type)]
pub struct RefChip {
    pub n: String, // short label, e.g. "main", "origin/main", "v0.3.0"
    pub t: String, // kind
}

/// Per-commit metadata (one entry per row, row = index).
#[derive(Serialize, specta::Type)]
pub struct CommitMeta {
    pub sha: String,     // short hash (7 chars)
    pub subject: String, // first line of the message
    pub an: Person,      // author
    pub cm: Person,      // committer
    pub refs: Vec<RefChip>,
    pub merge: bool,     // >= 2 parents
}

/// One line inside a diff hunk. `old_no`/`new_no` are the 1-based line numbers
/// on each side; the added side has `old_no == None`, the deleted side
/// `new_no == None`, context lines carry both. `text` is the raw line content
/// with any trailing CR/LF stripped — the frontend HTML-escapes it.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffLineRow {
    pub kind: String,        // " " context | "+" add | "-" del
    pub old_no: Option<u32>, // 1-based old-file line number, if present
    pub new_no: Option<u32>, // 1-based new-file line number, if present
    pub text: String,        // line content, no trailing newline (raw; JS escapes)
}

/// One hunk within a file patch. `header` is the `@@ -a,b +c,d @@ ...` line.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunkRow {
    pub header: String,
    pub lines: Vec<DiffLineRow>,
}

/// One changed file: its status, per-file stats, and hunks. `hunks` is empty
/// for a binary file (`binary == true`) or when the file was capped
/// (`truncated == true`). `old_path` is set only for renames/copies.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,             // new path (old path for a delete)
    pub old_path: Option<String>, // set for rename/copy (status R/C)
    pub status: String,           // "M" | "A" | "D" | "R" | "C" | "T"
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,             // true -> hunks intentionally empty
    pub truncated: bool,          // per-file line cap hit -> hunks partial
    pub lang: String,             // extension hint for the JS highlighter
    pub hunks: Vec<DiffHunkRow>,
}

/// Full payload for the M1 commit detail panel: message + real diff tree.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub sha: String,       // full 40-char oid
    pub short_sha: String, // 7-char prefix
    pub subject: String,   // first line of the message
    pub body: String,      // message minus subject (may be empty)
    pub message: String,   // full raw commit message
    pub additions: usize,  // totals across the (possibly capped) file set
    pub deletions: usize,
    pub files_changed: usize,      // number of files reported (after cap)
    pub truncated: bool,           // diff exceeded the file cap -> list partial
    pub file_tree: Vec<FileChange>,
}

/// The full graph payload. Rows are in reverse-chronological/topological order
/// (child before parent). `lane`/`color`/`merge` are one-per-row.
///
/// Edges are stored CSR-style: `gap g` is the band between row g and row g+1;
/// `gapStart[g]..gapStart[g+1]` indexes into `gapTop`/`gapBot`/`gapColor`, each
/// entry a line segment {top lane @row g, bottom lane @row g+1, colour index}.
#[derive(Serialize, specta::Type)]
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
