//! Tauri commands exposed to the frontend.

use std::time::Instant;

use git2::{Delta, DiffFindOptions, DiffOptions, Patch, Repository};

use crate::git_read::read_repo;
use crate::layout::{layout, NCOL};
use crate::model::{
    CommitDetail, CommitMeta, DiffHunkRow, DiffLineRow, FileChange, GraphData, Person,
};

/// Caps so a monster commit (vendored dir, generated lockfile) can't stall the
/// UI or blow up the payload. Beyond these we flag truncation and stop.
const MAX_FILES: usize = 40;
const MAX_LINES_PER_FILE: usize = 2000;

/// Default cap so a giant repo can't hang the UI on first load (M0 target: 10k < 1s).
const DEFAULT_LIMIT: usize = 50_000;

/// Tauri command wrapper — see [`build_graph`].
#[tauri::command]
pub fn load_graph(path: String, limit: Option<usize>) -> Result<GraphData, String> {
    build_graph(&path, limit.unwrap_or(DEFAULT_LIMIT))
}

/// Open `path`, walk its commits, lay out the swimlane graph, and return the
/// full payload the canvas renders. `limit` caps how many commits are loaded.
pub fn build_graph(path: &str, limit: usize) -> Result<GraphData, String> {

    let t0 = Instant::now();
    let mut read = read_repo(path, limit).map_err(|e| e.message().to_string())?;
    let read_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let t1 = Instant::now();
    let lay = layout(&read.commits);
    let layout_ms = t1.elapsed().as_secs_f64() * 1000.0;

    // Build per-row metadata, moving ref chips out of the map as we go.
    let rows: Vec<CommitMeta> = read
        .commits
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let sha = c.id.to_string();
            CommitMeta {
                sha: sha[..7.min(sha.len())].to_string(),
                subject: c.subject.clone(),
                an: Person { n: c.author.0.clone(), e: c.author.1.clone(), t: c.author.2 },
                cm: Person { n: c.committer.0.clone(), e: c.committer.1.clone(), t: c.committer.2 },
                refs: read.refs.remove(&sha).unwrap_or_default(),
                merge: lay.merge[i] == 1,
            }
        })
        .collect();

    Ok(GraphData {
        n: read.commits.len(),
        lane: lay.lane,
        color: lay.color,
        merge: lay.merge,
        gap_start: lay.gap_start,
        gap_top: lay.gap_top,
        gap_bot: lay.gap_bot,
        gap_color: lay.gap_color,
        rows,
        ncol: NCOL,
        lane_count: lay.lane_count,
        layout_ms,
        read_ms,
    })
}

/// Tauri command: return the full message + real changed-file tree + diff hunks
/// for a single commit. Diffs the commit tree against its FIRST parent (empty
/// tree for a root commit; first parent for a merge). Read-only.
#[tauri::command]
pub fn commit_detail(path: String, sha: String) -> Result<CommitDetail, String> {
    commit_detail_inner(&path, &sha).map_err(|e| e.message().to_string())
}

fn commit_detail_inner(path: &str, sha: &str) -> Result<CommitDetail, git2::Error> {
    let repo = Repository::open(path)?;
    // `sha` may be a 7-char abbreviation (the graph rows carry short shas) or a
    // full 40-char oid; find_commit_by_prefix resolves either.
    let commit = repo.find_commit_by_prefix(sha)?;
    let full_sha = commit.id().to_string();
    let subject = commit.summary().unwrap_or("").to_string();
    let body = commit.body().unwrap_or("").trim_end().to_string();
    let message = commit.message().unwrap_or("").to_string();

    // New side is this commit's tree; old side is the first parent's tree, or
    // None (the empty tree) for a root commit -> everything shows as added.
    let new_tree = commit.tree()?;
    let parent_tree = if commit.parent_count() > 0 {
        Some(commit.parent(0)?.tree()?)
    } else {
        None
    };

    let mut opts = DiffOptions::new();
    opts.context_lines(3)
        .include_typechange(true)
        .id_abbrev(7);
    let mut diff =
        repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&new_tree), Some(&mut opts))?;

    // Fold rename/copy detection in so status R/C (and old_path) are meaningful.
    let mut find = DiffFindOptions::new();
    find.renames(true).copies(true).rename_limit(1000); // bound O(files^2) scan on pathological commits
    let _ = diff.find_similar(Some(&mut find));

    let num_deltas = diff.deltas().len();
    let mut file_tree: Vec<FileChange> = Vec::new();
    let mut total_add = 0usize;
    let mut total_del = 0usize;
    let mut diff_truncated = false;

    for idx in 0..num_deltas {
        if file_tree.len() >= MAX_FILES {
            diff_truncated = true;
            break;
        }
        let delta = match diff.get_delta(idx) {
            Some(d) => d,
            None => continue,
        };
        if matches!(delta.status(), Delta::Unmodified) {
            continue;
        }

        let status = status_char(delta.status()).to_string();
        let new_path = path_of(delta.new_file().path());
        let old_path = path_of(delta.old_file().path());
        let is_rename = matches!(delta.status(), Delta::Renamed | Delta::Copied);
        // Show the new path; fall back to the old path for a delete.
        let path = new_path
            .clone()
            .filter(|p| !p.is_empty())
            .or_else(|| old_path.clone())
            .unwrap_or_default();
        let lang = guess_lang(&path);
        let old_path = if is_rename { old_path } else { None };

        // Generating the patch loads the blobs, which populates the delta's
        // binary flag. `from_diff` returns None for a binary (or unchanged)
        // file, but for some binaries it still returns a hunk-less patch, so
        // also consult the file flags.
        let patch = Patch::from_diff(&diff, idx)?;
        let is_binary =
            patch.is_none() || delta.new_file().is_binary() || delta.old_file().is_binary();
        if is_binary {
            file_tree.push(FileChange {
                path,
                old_path,
                status,
                additions: 0,
                deletions: 0,
                binary: true,
                truncated: false,
                lang,
                hunks: Vec::new(),
            });
            continue;
        }
        let patch = patch.expect("non-binary patch is Some");

        let (_context, additions, deletions) = patch.line_stats()?;
        total_add += additions;
        total_del += deletions;

        let mut hunks: Vec<DiffHunkRow> = Vec::new();
        let mut emitted = 0usize;
        let mut file_truncated = false;
        let num_hunks = patch.num_hunks();
        'hunks: for h in 0..num_hunks {
            let (hunk, _lines) = patch.hunk(h)?;
            let header = String::from_utf8_lossy(hunk.header())
                .trim_end_matches(['\n', '\r'])
                .to_string();
            let n = patch.num_lines_in_hunk(h)?;
            let mut rows: Vec<DiffLineRow> = Vec::with_capacity(n);
            for l in 0..n {
                if emitted >= MAX_LINES_PER_FILE {
                    file_truncated = true;
                    diff_truncated = true;
                    break 'hunks;
                }
                let line = patch.line_in_hunk(h, l)?;
                // Keep only real content lines; skip the "\ No newline at end of
                // file" EOFNL markers ('=','>','<') and any header pseudo-lines.
                let kind = match line.origin() {
                    '+' => "+",
                    '-' => "-",
                    ' ' => " ",
                    _ => continue,
                };
                let text = String::from_utf8_lossy(line.content())
                    .trim_end_matches(['\n', '\r'])
                    .to_string();
                rows.push(DiffLineRow {
                    kind: kind.to_string(),
                    old_no: line.old_lineno(),
                    new_no: line.new_lineno(),
                    text,
                });
                emitted += 1;
            }
            hunks.push(DiffHunkRow { header, lines: rows });
        }

        file_tree.push(FileChange {
            path,
            old_path,
            status,
            additions,
            deletions,
            binary: false,
            truncated: file_truncated,
            lang,
            hunks,
        });
    }

    let short_sha = full_sha[..7.min(full_sha.len())].to_string();
    Ok(CommitDetail {
        sha: full_sha,
        short_sha,
        subject,
        body,
        message,
        additions: total_add,
        deletions: total_del,
        files_changed: file_tree.len(),
        truncated: diff_truncated,
        file_tree,
    })
}

/// libgit2 delta status -> the one-letter code the frontend tree renders.
fn status_char(status: Delta) -> &'static str {
    match status {
        Delta::Added => "A",
        Delta::Deleted => "D",
        Delta::Renamed => "R",
        Delta::Copied => "C",
        Delta::Typechange => "T",
        _ => "M", // Modified and anything else tree-diffs produce
    }
}

/// A diff-side path (relative to repo root) as an owned String, if present.
fn path_of(p: Option<&std::path::Path>) -> Option<String> {
    p.map(|p| p.to_string_lossy().into_owned())
}

/// Extension -> a `GRAMMARS` key the frontend highlighter understands; unknown
/// extensions fall back to "generic" (the JS does `GRAMMARS[lang]||generic`).
fn guess_lang(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => "ts",
        _ => "generic",
    }
    .to_string()
}
