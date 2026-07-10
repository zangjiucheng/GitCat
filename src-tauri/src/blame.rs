//! Blame (line-annotation) view — read-only inspection of who last touched
//! each line of a file, at an arbitrary commit (or HEAD).
//!
//! Read/write split: PURE READ, same shape as `plumbing.rs`/`reflog.rs`'s read
//! half — git2 only, never shells out, never calls `crate::safety::snapshot`
//! (nothing here mutates anything, so a pre-op backup would be meaningless
//! overhead).
//!
//! `at_commit` is resolved via `find_commit_by_prefix`, matching
//! `commands::commit_detail_inner`'s own `sha` convention — a full/short sha
//! only, never a branch/tag name, keeping resolution unambiguous. `None`
//! means HEAD.
//!
//! The blamed blob is ALWAYS read from `at_commit`'s own committed tree
//! (never the working directory) — this is a `git2::Repository::blame_file`
//! /libgit2 fact, not a GitCat choice: `git_blame_file`'s `load_blob()` does
//! `git_commit_lookup` + `git_object_lookup_bypath` and never touches the
//! workdir. So blaming a dirty-but-tracked file from the Workdir panel always
//! shows HEAD's last committed version, never uncommitted edits — the
//! frontend states this explicitly rather than let it look like a silent
//! mismatch.
//!
//! Move/copy detection: `BlameOptions`'s four `track_copies_*` flags are
//! verified (against the vendored libgit2 `blame.c`/`blame.h`) to be either
//! unimplemented or to only ever affect `orig_commit_id`/`orig_signature`
//! (which we don't surface) — so none of them is exposed here. What IS always
//! on, unconditionally, with zero configuration: `find_origin()` in
//! `blame_git.c` always asks `git_diff_find_similar` (`GIT_DIFF_FIND_RENAMES`)
//! when a line's history crosses a commit where the file wasn't at the same
//! path, so `BlameHunk::path()` (`orig_path` below) is already populated
//! whenever a hunk's lines predate the file's own most recent rename.
//!
//! Large files: capped at [`MAX_BLAME_LINES`] (same numeric value as
//! `commands::MAX_LINES_PER_FILE` / `workdir::MAX_LINES_PER_FILE`'s diff-view
//! cap, duplicated per-module rather than shared across module boundaries —
//! matching `workdir.rs`'s own "duplicate small per-module constants"
//! precedent). Truncation happens BEFORE the blame walk: the blob's line
//! count is cheap to compute from its raw bytes, and if it exceeds the cap we
//! pass `BlameOptions::max_line` so libgit2 only computes hunks for the
//! retained prefix, rather than blaming the whole file and throwing away the
//! back half.

use std::path::Path;

use git2::BlameOptions;
use serde::Serialize;

use crate::model::Person;

/// Cap on rendered lines/hunks — see module doc. Duplicated (not imported)
/// from `commands::MAX_LINES_PER_FILE`, but kept at the SAME numeric value so
/// the app has one consistent "how many text rows will this render before
/// capping" number to reason about.
const MAX_BLAME_LINES: usize = 2000;

// ---------------------------------------------------------------------------
// Payloads (local to this module — matches workdir.rs/reflog.rs/plumbing.rs's
// precedent of each feature module owning its own DTOs rather than growing
// model.rs)
// ---------------------------------------------------------------------------

/// One run of CONSECUTIVE lines last touched by the same commit — git2's own
/// hunking, not one entry per line (far cheaper for a typical file: a few
/// dozen hunks vs. thousands of lines).
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BlameHunkRow {
    pub sha: String,           // full 40-char final_commit_id
    pub short_sha: String,     // 7-char prefix
    pub author: Person,        // from final_signature() — n/e/t
    pub start_line: u32,       // 1-based, final_start_line() — index into `FileBlame.lines`
    pub lines_in_hunk: u32,
    /// Set only when the file's OWN rename lineage (always-on in libgit2, no
    /// flag needed — see module doc) traces this hunk's lines back to a
    /// different path than the one queried.
    pub orig_path: Option<String>,
}

/// Full payload for the Blame modal: the file's (possibly capped) content, as
/// a flat per-line array, plus the hunks covering ranges over it — kept
/// SEPARATE from the lines (not nested, unlike DiffHunkRow/DiffLineRow) so
/// hunk metadata stays O(hunks), not O(lines).
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileBlame {
    pub path: String,
    pub at_sha: String,      // resolved full commit oid actually blamed (HEAD's oid if at_commit was None)
    pub lang: String,        // same guess_lang() convention as FileChange.lang
    pub total_lines: usize,  // real line count, pre-cap
    pub truncated: bool,     // hit MAX_BLAME_LINES
    pub lines: Vec<String>,  // file content, one entry per line, no trailing newline, capped
    pub hunks: Vec<BlameHunkRow>, // capped to match `lines`
}

// ---------------------------------------------------------------------------
// Tauri command (registered in lib.rs)
// ---------------------------------------------------------------------------

/// Blame `file` as it exists in `at_commit`'s own tree (HEAD's tree if
/// `at_commit` is `None`). Read-only. Refuses cleanly (no panic, no raw
/// libgit2 error reaching the frontend) for a binary file, a file absent from
/// the target commit, or a directory-shaped path.
///
/// JS: `commands.blameFile(path, file, atCommit, ignoreWhitespace)`.
#[tauri::command]
#[specta::specta]
pub fn blame_file(
    path: String,
    file: String,
    at_commit: Option<String>,
    ignore_whitespace: bool,
) -> Result<FileBlame, String> {
    blame_file_inner(&path, &file, at_commit.as_deref(), ignore_whitespace)
}

/// Mixes git2 errors and custom refusal strings, so (matching
/// `workdir_file_diff_inner`'s style, not `commit_detail_inner`'s pure-
/// `git2::Error` style) this returns `Result<_, String>` directly, doing
/// `.map_err(|e| e.message().to_string())` at each git2 call site.
fn blame_file_inner(
    path: &str,
    file: &str,
    at_commit: Option<&str>,
    ignore_whitespace: bool,
) -> Result<FileBlame, String> {
    let repo = crate::trust::open_repo(path)
        .map_err(|e| format!("cannot open repository: {}", e.message()))?;

    // Resolve the target commit: an explicit sha/short-sha (never a
    // branch/tag name — same convention as commit_detail_inner's `sha`), or
    // HEAD when not given.
    let commit = match at_commit {
        Some(sha) => repo
            .find_commit_by_prefix(sha)
            .map_err(|e| format!("Not a valid commit: {sha:?} ({})", e.message()))?,
        None => {
            let head = repo.head().map_err(|e| e.message().to_string())?;
            head.peel_to_commit().map_err(|e| e.message().to_string())?
        }
    };
    let at_sha = commit.id().to_string();
    let short_sha = short(&at_sha);

    // Resolve the blob at `file` inside THAT commit's own tree — never
    // guessed, never falls back to a parent or the working tree (see #1/#2 in
    // the design doc's edge-case list; the CALLER is responsible for passing
    // a first-parent sha for a deleted/renamed-away file).
    let tree = commit.tree().map_err(|e| e.message().to_string())?;
    let entry = tree
        .get_path(Path::new(file))
        .map_err(|_| format!("{file} does not exist at {short_sha}."))?;
    let obj = entry
        .to_object(&repo)
        .map_err(|_| format!("{file} does not exist at {short_sha}."))?;
    let blob = obj
        .into_blob()
        .map_err(|_| format!("{file} does not exist at {short_sha}."))?;

    if blob.is_binary() {
        return Err(format!(
            "{file} is a binary file — blame is not available for binary content."
        ));
    }

    // Cheap line count from the raw bytes — no blame walk needed for this.
    let text = String::from_utf8_lossy(blob.content()).into_owned();
    let all_lines: Vec<String> = if blob.content().is_empty() {
        Vec::new()
    } else {
        text.lines().map(|l| l.to_string()).collect()
    };
    let total_lines = all_lines.len();
    let truncated = total_lines > MAX_BLAME_LINES;
    let lines: Vec<String> = if truncated {
        all_lines[..MAX_BLAME_LINES].to_vec()
    } else {
        all_lines
    };

    // Net: one exposed option (ignoreWhitespace); track-copies flags left
    // off (see module doc — verified inert/unsurfaced), first_parent/
    // use_mailmap left at their off-by-default values too.
    let mut opts = BlameOptions::new();
    opts.newest_commit(commit.id());
    opts.ignore_whitespace(ignore_whitespace);
    if truncated {
        opts.max_line(MAX_BLAME_LINES);
    }

    let blame = repo
        .blame_file(Path::new(file), Some(&mut opts))
        .map_err(|e| e.message().to_string())?;

    let mut hunks = Vec::with_capacity(blame.len());
    for hunk in blame.iter() {
        let sha = hunk.final_commit_id().to_string();
        let sig = hunk.final_signature();
        let author = Person {
            n: sig.name().unwrap_or("").to_string(),
            e: sig.email().unwrap_or("").to_string(),
            t: sig.when().seconds(),
        };
        // Only surface orig_path when it actually differs from the queried
        // path — i.e. this hunk's lines predate the file's own rename.
        let orig_path = hunk
            .path()
            .map(|p| p.to_string_lossy().into_owned())
            .filter(|p| p != file);
        hunks.push(BlameHunkRow {
            short_sha: short(&sha),
            sha,
            author,
            start_line: hunk.final_start_line() as u32,
            lines_in_hunk: hunk.lines_in_hunk() as u32,
            orig_path,
        });
    }

    Ok(FileBlame {
        path: file.to_string(),
        at_sha,
        lang: guess_lang(file),
        total_lines,
        truncated,
        lines,
        hunks,
    })
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// Extension -> a `GRAMMARS` key the frontend highlighter understands; unknown
/// extensions fall back to "generic". Duplicated from
/// `commands.rs`/`workdir.rs`'s own copy — matching this codebase's
/// duplicate-small-per-module-helpers precedent (see `workdir.rs`'s module
/// doc) rather than reaching across module boundaries for a four-line fn.
fn guess_lang(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => "ts",
        _ => "generic",
    }
    .to_string()
}
