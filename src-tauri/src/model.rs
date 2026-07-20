//! Serializable graph payload sent to the frontend canvas renderer.
//!
//! The field names use camelCase to match the existing prototype's `draw()`,
//! which consumes a Structure-of-Arrays + a compressed-sparse-row (CSR) edge
//! model so that rendering stays O(visible rows), independent of commit count.

use serde::Serialize;

/// One author/committer identity. `t` is a unix timestamp; the frontend formats it.
#[derive(Serialize, Clone, specta::Type)]
pub struct Person {
    pub n: String, // name
    pub e: String, // email
    pub t: i64,    // unix seconds
}

/// A ref chip pointing at a commit. `t` is one of: head | branch | remote | tag.
/// When a commit has more than one, `git_read::collect_refs` returns them
/// pre-sorted tag -> head -> branch -> remote — every consumer (the canvas's
/// primary/all-refs chips, the detail panel, ⌘K's ref index) renders this
/// order as-is rather than re-sorting itself.
#[derive(Serialize, Clone, specta::Type)]
pub struct RefChip {
    pub n: String, // short label, e.g. "main", "origin/main", "v0.3.0"
    pub t: String, // kind
}

/// Per-commit metadata (one entry per row, row = index).
#[derive(Serialize, Clone, specta::Type)]
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

/// One incremental slice of a streaming graph load — see
/// `commands::stream_graph`'s own doc comment for the full protocol this is
/// part of. Emitted over the `"graph-batch"` Tauri event (not returned from
/// `load_graph` itself, which only hands back the `generation` this and
/// every sibling batch for the SAME load carry, so the frontend can drop any
/// batch belonging to a since-superseded load).
///
/// `rows`/`lane`/`color`/`merge` are this batch's NEW rows only (append,
/// don't replace) — same "one entry per row" shape as `GraphData`'s own
/// fields, just a slice of the whole instead of the whole. Edges are
/// similarly incremental: `gap_counts[i]` is how many of THIS batch's
/// `gap_top`/`gap_bot`/`gap_color` entries belong to `rows[i]`'s own
/// trailing gap (0 for a row whose trailing gap isn't finalized yet — always
/// true for the very last row of every batch except the truly final one, see
/// `stream_graph`'s one-row lag) — letting the frontend rebuild its own
/// running `gapStart` CSR index by accumulating `gap_counts` alongside
/// `rows`, without this event ever transmitting `gapStart` itself.
#[derive(Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphBatch {
    pub generation: u64,
    pub rows: Vec<CommitMeta>,
    pub lane: Vec<i16>,
    pub color: Vec<u8>,
    pub merge: Vec<u8>,
    pub gap_counts: Vec<i32>,
    pub gap_top: Vec<i16>,
    pub gap_bot: Vec<i16>,
    pub gap_color: Vec<u8>,
    pub ncol: u8,
    pub lane_count: usize, // running high-water lane count, so far
    pub total_so_far: usize,
    pub done: bool, // true only on the batch that ends the walk (exhausted, hit MAX_LIVE_COMMITS, or the walk itself errored)
    pub elapsed_ms: f64, // wall-clock since this load started — read+layout are now fully interleaved, so there's no longer a meaningful separate read_ms/layout_ms split to report
    /// Set only on the final (`done: true`) batch, only when the walk itself
    /// failed partway (e.g. mid-walk corruption) rather than completing or
    /// being superseded — a superseded generation never emits a final batch
    /// at all (see `stream_graph`), so this is never populated for that case.
    pub error: Option<String>,
    /// Set only on the final (`done: true`) batch, only when the walk stopped
    /// specifically because it hit `commands::MAX_LIVE_COMMITS` — distinct
    /// from `error` (this isn't a failure, the walk just has more history
    /// than the app is willing to hold in memory) and distinct from a
    /// genuinely complete walk, which reaches `done: true` with this false.
    /// The frontend uses this to tell the user their history was capped
    /// rather than letting a truncated load quietly look identical to a
    /// complete one.
    pub truncated: bool,
}
