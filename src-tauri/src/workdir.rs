//! Working tree: status, stage/unstage, discard, commit, and stash.
//!
//! Read/write split (see git_write.rs / git_merge.rs for the established
//! pattern): [`workdir_status`], [`workdir_file_diff`], and [`stash_list`] are
//! READS — status/diff use git2 directly (like commands.rs's `commit_detail`);
//! `stash_list` shells out (`git stash list`) because libgit2 has no stash
//! API at all. Every WRITE shells out to the git CLI, exactly like
//! git_write.rs/git_merge.rs, and for the identical reason: libgit2 and the
//! porcelain can diverge, and the CLI is the source of truth for mutations —
//! this matters doubly here because `commit` must respect `commit.gpgsign`
//! (see below), which only the real `git commit`/`git stash` binaries do.
//!
//! Failure model: write commands return a plain [`WorkdirResult`] (never a
//! Rust `Err`), same contract as `WriteResult`/`MergeResult` — the JS promise
//! always resolves, and a refused/failed op surfaces git's own message.
//!
//! SAFETY / snapshot policy — the dividing line is explicit:
//!   * `stage_file` / `unstage_file` / `stage_all` do **not** snapshot. They
//!     only ever touch the index, never HEAD or any ref, and are perfectly
//!     undone by the paired action (stage <-> unstage). Snapshotting every
//!     click while a commit is being assembled — a very high-frequency
//!     action — would flood the Snapshot ribbon with no-op HEAD-pins and
//!     degrade that feature's own signal. This mirrors the codebase's existing
//!     precedent for a documented, narrow no-snapshot exception:
//!     `git_merge::merge_abort`'s "it must ALWAYS be able to run, so it
//!     deliberately does NOT take a snapshot".
//!   * `commit`, `stash_save`, `stash_apply`, `stash_pop`, `stash_drop` ALL
//!     snapshot first, no exceptions — each can substantively change history
//!     or the working tree/index in a way not undone by one click of an
//!     obvious opposite button.
//!   * `discard_file` is genuinely destructive on the working tree itself, and
//!     uniquely among every mutation in this app, there is no ref the Safety
//!     Manager can pin it under (the content was never committed, so
//!     `refs/gitgui/backup/*` cannot cover it). It instead writes a real
//!     backup (a `git apply`-able unified diff for a tracked file, or a raw
//!     byte copy for an untracked one) under `<git-dir>/gitgui/discard-backup/`
//!     — reusing the existing `<git-dir>/gitgui/` convention `safety.rs`
//!     already established for `oplog.jsonl` — BEFORE ever touching the
//!     working tree. The frontend is expected to route every call to
//!     `discard_file` through the existing typed-confirm (`armDanger`) scrim,
//!     the same one branch deletion already uses; this module does not (and
//!     cannot, being backend-only) enforce that gate itself.
//!
//! `commit` and `commit.gpgsign`: this shells out to the CLI, never git2's
//! commit builder — plain `git commit`/`git stash` already read
//! `commit.gpgsign` from repo/global/system config and sign accordingly (exact
//! precedent: `git_merge::merge_start` creates a real merge commit via
//! `git merge --no-edit` with zero gpgsign-specific code). The only failure
//! mode to avoid is accidentally using `git2::Repository::commit()`, which has
//! no GPG integration at all — this module never calls it.
//!
//! `stash_apply`/`stash_pop` conflicts reuse the exact shape
//! `MergeResult`/`PickResult` already established: a failed apply/pop leaves
//! `conflicted_files` populated (via a private `unmerged_files()` — a straight
//! copy of `git_merge.rs`'s own helper of the same name/body, matching that
//! file's own stated precedent of duplicating small helpers per module rather
//! than sharing them across module boundaries) and `ok:false`. Unlike merge/
//! rebase/cherry-pick, though, `git stash apply`/`stash pop` never set
//! MERGE_HEAD or any sequencer state (empirically verified), so
//! `RepositoryState` stays `Clean` straight through the conflict — there is no
//! git-native "in progress" marker for the resolver to read back later. Two
//! things exist BECAUSE of that:
//!   * `conflict.rs::conflict_status`/`resolve_conflict_file` recognize a
//!     Clean state with unmerged INDEX entries as op `"stash"` (see
//!     conflict.rs's `detect_op`), so the shared Resolver can open on it at
//!     all.
//!   * THIS module persists the context Abort/Continue need (which pre-op
//!     safety snapshot to reset to; whether it was apply or pop; the stash's
//!     own identity) in a sidecar file, `<git-dir>/gitgui/stash-conflict.json`
//!     (same `<git-dir>/gitgui/` convention as `oplog.jsonl`/
//!     `discard-backup/`), written by `apply_or_pop` the moment a conflict is
//!     detected and consumed/cleared by [`stash_conflict_abort`] /
//!     [`stash_conflict_continue`] — the stash-flavored analogue of
//!     `git_merge::merge_abort`/`merge_continue` reading MERGE_HEAD.
//!
//! Global Undo (⌘Z) after a CLEAN apply/pop: `safety::undo()`'s dirty-tree
//! guard unconditionally refuses whenever the working tree is dirty — correct
//! for every ref-rewinding mutation it protects, but a stash apply/pop leaves
//! the tree dirty BY DEFINITION even on total success (that's the whole point
//! of applying a stash), so global Undo can never fire right after one, even
//! though nothing at the ref level moved. [`stash_undo_apply`] is a dedicated,
//! ADDITIVE undo path scoped to exactly these two ops — see its own doc
//! comment — and does NOT touch `safety::undo()`'s guard, which keeps
//! refusing on unrelated dirty state exactly as before.
//!
//! Literal pathspecs: every pathspec handed to a git CLI mutation below is run
//! through [`literal_pathspec`] (`:(literal)<path>`) — EMPIRICALLY VERIFIED
//! that a bare `--` end-of-options separator does NOT disable pathspec glob
//! magic (`git add -- 'test[1].txt'` silently stages an unrelated `test1.txt`
//! if it exists), only git's own `:(literal)` magic word does.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write as _;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{Delta, DiffFindOptions, DiffOptions, FileMode, Patch, Repository, Status, StatusOptions};
use serde::{Deserialize, Serialize};

use crate::model::{DiffHunkRow, DiffLineRow, FileChange};

/// Per-file line cap for [`workdir_file_diff`], identical to commands.rs's own
/// `MAX_LINES_PER_FILE` — kept as a private copy rather than a shared const
/// (see this module's doc comment: the codebase's own stated precedent for
/// duplicating small per-module helpers/constants rather than reaching across
/// module boundaries for them).
const MAX_LINES_PER_FILE: usize = 2000;

/// Process-wide monotonic tie-breaker for discard-backup filenames, mirroring
/// `safety.rs`'s `SNAP_SEQ` — a separate counter (not shared with safety.rs)
/// since this names files, not refs.
static DISCARD_SEQ: AtomicU64 = AtomicU64::new(0);

/// Process-wide monotonic tie-breaker for pinned-dropped-stash ref names
/// (`refs/gitgui/dropped-stash/*`) — a separate counter from `DISCARD_SEQ`
/// (files) and `safety.rs`'s `SNAP_SEQ` (backup refs) since this names its own
/// ref namespace.
static STASH_SEQ: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// One working-tree/index entry. `status` reuses `FileChange`'s vocabulary
/// (A/M/D/R/T) plus `"?"` for untracked (git's own porcelain symbol; distinct
/// from `"A"` so a brand-new-but-staged file and a not-yet-tracked file never
/// look the same).
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkdirEntry {
    pub path: String,
    pub old_path: Option<String>, // set for a rename (status "R")
    pub status: String,           // "A" | "M" | "D" | "R" | "T" | "?"
}

/// Full working-tree snapshot backing the pinned "Uncommitted changes" row.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkdirStatus {
    pub staged: Vec<WorkdirEntry>,   // index vs HEAD
    pub unstaged: Vec<WorkdirEntry>, // workdir vs index + untracked
    pub conflicted: usize,          // mid-merge/rebase unmerged path count;
                                     // resolve via the EXISTING conflict.rs
    pub branch: Option<String>,     // current branch shorthand; None if detached/unborn
    pub has_stash: bool,            // refs/stash exists
}

/// Result of any working-tree mutation. Same `{ok, message}` contract as
/// `WriteResult`/`MergeResult`, extended with TWO different safety-net
/// channels (see this module's doc comment for which op populates which).
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkdirResult {
    pub ok: bool,
    pub message: String,
    /// Non-empty only for a `stash_apply`/`stash_pop` left mid-conflict.
    pub conflicted_files: Vec<String>,
    /// Safety-Manager ref snapshot (`commit`/`stash_*` only).
    pub backup_ref: Option<String>,
    /// Path to a saved pre-discard copy (`discard_file` only).
    pub backup_patch: Option<String>,
    /// Ref pinning a DROPPED stash's own commit so it survives `git gc`
    /// (`stash_drop` only). `safety::snapshot`'s `backup_ref` only ever tracks
    /// `refs/heads/*` — never `refs/stash` — so it can't make a dropped stash
    /// itself recoverable; this is the honest, separate recovery channel (see
    /// `pin_dropped_stash`). Recover with `git stash apply <this ref>` (or
    /// `git branch <name> <this ref>` to just inspect it).
    pub dropped_stash_ref: Option<String>,
}

impl WorkdirResult {
    fn ok(message: impl Into<String>, backup_ref: Option<String>) -> Self {
        Self {
            ok: true,
            message: message.into(),
            conflicted_files: Vec::new(),
            backup_ref,
            backup_patch: None,
            dropped_stash_ref: None,
        }
    }
    /// A refusal BEFORE any snapshot was attempted (validation, precondition) —
    /// `backup_ref` is always `None`, matching `WriteResult::err`'s convention
    /// (see `branch_ops.rs`'s "a refused, never-attempted mutation must not
    /// have snapshotted" test).
    fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: message.into(),
            conflicted_files: Vec::new(),
            backup_ref: None,
            backup_patch: None,
            dropped_stash_ref: None,
        }
    }
    /// A failure AFTER a snapshot was already sealed (the git command itself
    /// then failed) — keeps `backup_ref` populated, mirroring
    /// `git_merge::classify`'s choice to thread `backup` through every path
    /// (including its `"error"` state) rather than dropping it on failure.
    fn err_with_backup(message: impl Into<String>, backup_ref: Option<String>) -> Self {
        Self {
            ok: false,
            message: message.into(),
            conflicted_files: Vec::new(),
            backup_ref,
            backup_patch: None,
            dropped_stash_ref: None,
        }
    }
}

/// One stash entry, newest (`stash@{0}`) first.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: usize,           // the {N} in stash@{N}
    pub sha: String,            // short sha of the stash commit
    pub branch: Option<String>, // parsed from git's own "WIP on <branch>: …" / "On <branch>: …"
    pub message: String,        // full raw subject, verbatim
}

// ---------------------------------------------------------------------------
// git CLI runner (own copy, mirroring git_merge.rs's `git()`/`Out` — needed
// for the same reason: `no_editor` forces GIT_EDITOR=true so `commit`/`stash`
// never block on an interactive editor).
// ---------------------------------------------------------------------------

struct Out {
    ok: bool,
    code: i32,
    stdout: String,
    stderr: String,
}

fn git(path: &str, args: &[&str], no_editor: bool) -> Result<Out, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path).args(args);
    if no_editor {
        cmd.env("GIT_EDITOR", "true").env("GIT_SEQUENCE_EDITOR", "true");
    }
    let o = cmd.output().map_err(|e| format!("Could not run git: {e}"))?;
    Ok(Out {
        ok: o.status.success(),
        code: o.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&o.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&o.stderr).trim().to_string(),
    })
}

/// Best human message from a failed run (prefer stderr, then stdout).
fn git_msg(o: &Out) -> String {
    if !o.stderr.is_empty() {
        o.stderr.clone()
    } else if !o.stdout.is_empty() {
        o.stdout.clone()
    } else {
        format!("git exited with status {}", o.code)
    }
}

/// Compact tail of a backup ref, e.g. ".../1720000000-42-3" -> "1720000000-42-3".
fn short_backup(r: &str) -> String {
    r.rsplit('/').next().unwrap_or(r).to_string()
}

/// Repo-relative unmerged (conflicted) paths, via the porcelain idiom
/// `git diff --name-only --diff-filter=U`. A straight copy of
/// `git_merge.rs`'s own private helper of the same name and body.
fn unmerged_files(path: &str) -> Vec<String> {
    match git(path, &["diff", "--name-only", "--diff-filter=U"], false) {
        Ok(o) if o.ok => o
            .stdout
            .lines()
            .map(|l| l.to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// True while ANY sequencer operation (merge/rebase/cherry-pick/bisect/revert)
/// is in progress — broader than `git_merge.rs`'s MERGE_HEAD-only check
/// because `stash_apply`/`stash_pop` must refuse to run on top of ANY
/// unfinished op, not just a merge.
fn in_progress(repo: &Repository) -> bool {
    !matches!(repo.state(), git2::RepositoryState::Clean)
}

// ---------------------------------------------------------------------------
// Validation (flag/injection guard) — mirrors git_write.rs's validate_* family
// ---------------------------------------------------------------------------

/// Lighter guard than `validate_branch_name`: pathspecs legitimately contain
/// characters branch names can't (spaces, `~^:`, tabs, …). We only need to
/// stop flag injection and the handful of bytes that could smuggle another
/// argument; the literal `--` before every pathspec argument handles flags,
/// and [`literal_pathspec`]'s `:(literal)` prefix handles glob magic — so this
/// check only needs to reject NUL/CR/LF. Kept in exact alignment with
/// `conflict.rs::validate_path` (same conceptual job — sanitize a path before
/// a git CLI mutation): that one already only rejects NUL/CR/LF, and a
/// legitimately tab-named file must not be accepted by conflict resolution
/// but refused by staging.
fn validate_pathspec(file: &str) -> Result<(), String> {
    if file.is_empty() {
        return Err("File path is empty.".into());
    }
    if file.starts_with('-') {
        return Err(format!("Refusing a file path that looks like a flag: {file:?}"));
    }
    if file.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err(format!("File path has an illegal NUL/CR/LF character: {file:?}"));
    }
    Ok(())
}

/// Prefix a pathspec with git's own literal-pathspec magic word so glob
/// metacharacters in a REAL filename (`*`, `?`, `[...]`) are matched
/// literally instead of as a glob. EMPIRICALLY VERIFIED: `--` alone (already
/// used everywhere below) ends OPTION parsing but does NOT disable pathspec
/// glob magic — `git add -- 'test[1].txt'` silently stages an unrelated
/// `test1.txt` if one exists. `:(literal)` is the actual fix (see
/// `tests/workdir.rs`'s glob-metacharacter regression test).
fn literal_pathspec(file: &str) -> String {
    format!(":(literal){file}")
}

fn open_repo(path: &str) -> Result<Repository, WorkdirResult> {
    Repository::open(path)
        .map_err(|e| WorkdirResult::err(format!("Cannot open repository: {}", e.message())))
}

// ---------------------------------------------------------------------------
// FileChange-building helpers, duplicated from commands.rs's commit_detail_inner
// loop (see this module's doc comment: the codebase's own stated precedent —
// git_merge.rs's doc comment — for a per-module private copy rather than a
// shared cross-module helper).
// ---------------------------------------------------------------------------

fn status_char(status: Delta) -> &'static str {
    match status {
        // `Untracked` is what an index-vs-workdir diff widened with
        // `include_untracked` (`workdir_file_diff_inner`'s unstaged branch,
        // `fresh_diff_for_lines`) reports for a brand-new file — distinct
        // from `Added` (which only ever appears in a HEAD-vs-index/tree-vs-
        // tree diff), but the same "A" from this DTO's point of view (see
        // `FileChange.status`'s doc comment: "A" | "D" | ... — no separate
        // untracked code).
        Delta::Added | Delta::Untracked => "A",
        Delta::Deleted => "D",
        Delta::Renamed => "R",
        Delta::Copied => "C",
        Delta::Typechange => "T",
        _ => "M",
    }
}

fn path_of(p: Option<&std::path::Path>) -> Option<String> {
    p.map(|p| p.to_string_lossy().into_owned())
}

fn guess_lang(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => "ts",
        _ => "generic",
    }
    .to_string()
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// Tauri command: full working-tree/index status for the pinned "Uncommitted
/// changes" row + staging panel. Read-only (git2).
/// JS: `invoke("workdir_status", { path })`.
#[tauri::command]
#[specta::specta]
pub fn workdir_status(path: String) -> Result<WorkdirStatus, String> {
    workdir_status_inner(&path).map_err(|e| e.message().to_string())
}

fn workdir_status_inner(path: &str) -> Result<WorkdirStatus, git2::Error> {
    let repo = Repository::open(path)?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo.statuses(Some(&mut opts))?;

    let mut staged: Vec<WorkdirEntry> = Vec::new();
    let mut unstaged: Vec<WorkdirEntry> = Vec::new();
    let mut conflicted = 0usize;

    const INDEX_MASK: Status = Status::from_bits_truncate(
        Status::INDEX_NEW.bits()
            | Status::INDEX_MODIFIED.bits()
            | Status::INDEX_DELETED.bits()
            | Status::INDEX_RENAMED.bits()
            | Status::INDEX_TYPECHANGE.bits(),
    );
    const WT_MASK: Status = Status::from_bits_truncate(
        Status::WT_NEW.bits()
            | Status::WT_MODIFIED.bits()
            | Status::WT_DELETED.bits()
            | Status::WT_RENAMED.bits()
            | Status::WT_TYPECHANGE.bits(),
    );

    for entry in statuses.iter() {
        let status = entry.status();
        if status.is_conflicted() {
            conflicted += 1;
            continue;
        }
        if status.is_ignored() {
            continue;
        }

        if status.intersects(INDEX_MASK) {
            if let Some(delta) = entry.head_to_index() {
                let (path, old_path) = entry_paths(&delta);
                let s = if status.is_index_new() {
                    "A"
                } else if status.is_index_deleted() {
                    "D"
                } else if status.is_index_renamed() {
                    "R"
                } else if status.is_index_typechange() {
                    "T"
                } else {
                    "M"
                };
                staged.push(WorkdirEntry { path, old_path, status: s.to_string() });
            }
        }
        if status.intersects(WT_MASK) {
            if let Some(delta) = entry.index_to_workdir() {
                let (path, old_path) = entry_paths(&delta);
                // WT_NEW with no index entry -> untracked, git's own "?" symbol
                // (never "A" — that would look like a staged new file).
                let s = if status.is_wt_new() {
                    "?"
                } else if status.is_wt_deleted() {
                    "D"
                } else if status.is_wt_renamed() {
                    "R"
                } else if status.is_wt_typechange() {
                    "T"
                } else {
                    "M"
                };
                unstaged.push(WorkdirEntry { path, old_path, status: s.to_string() });
            }
        }
    }

    let branch = match repo.head() {
        Ok(h) if h.is_branch() => h.shorthand().map(|s| s.to_string()),
        _ => None,
    };
    let has_stash = repo.refname_to_id("refs/stash").is_ok();

    Ok(WorkdirStatus { staged, unstaged, conflicted, branch, has_stash })
}

/// new/old path pair from a `DiffDelta`, exactly like commands.rs's `path_of`
/// use in `commit_detail_inner`: prefer the new path, fall back to the old
/// path (delete), and only surface `old_path` for a rename/copy.
fn entry_paths(delta: &git2::DiffDelta) -> (String, Option<String>) {
    let new_path = path_of(delta.new_file().path());
    let old_path_raw = path_of(delta.old_file().path());
    let is_rename = matches!(delta.status(), Delta::Renamed | Delta::Copied);
    let path = new_path
        .clone()
        .filter(|p| !p.is_empty())
        .or_else(|| old_path_raw.clone())
        .unwrap_or_default();
    let old_path = if is_rename { old_path_raw.filter(|p| !p.is_empty()) } else { None };
    (path, old_path)
}

/// Tauri command: the real diff for ONE file, either the staged side (index
/// vs HEAD) or the unstaged side (workdir vs index). Reuses `model::FileChange`
/// verbatim so the frontend's diff viewer can share `Detail.svelte`'s markup.
/// JS: `invoke("workdir_file_diff", { path, file, staged })`.
#[tauri::command]
#[specta::specta]
pub fn workdir_file_diff(path: String, file: String, staged: bool) -> Result<FileChange, String> {
    validate_pathspec(&file)?;
    workdir_file_diff_inner(&path, &file, staged)
}

fn workdir_file_diff_inner(path: &str, file: &str, staged: bool) -> Result<FileChange, String> {
    let repo = Repository::open(path).map_err(|e| format!("Cannot open repository: {}", e.message()))?;

    // NO `DiffOptions::pathspec` here — EMPIRICALLY VERIFIED that libgit2's
    // own pathspec matcher (unlike the git CLI's) has no `:(literal)` magic
    // at all (see `pathspec.c`'s plain `fnmatch`-based `git_pathspec__match`):
    // handing it a raw filename with glob metacharacters (`test[1].txt`) is
    // interpreted as a GLOB, not a literal path, and can silently miss the
    // real file or match an unrelated one. Diffing the whole tree and
    // filtering deltas by an EXACT string match on the path below (see the
    // `out_path != file` guard) sidesteps libgit2's pathspec matching for
    // correctness entirely, rather than relying on a magic prefix it doesn't
    // understand.
    let mut opts = DiffOptions::new();
    opts.context_lines(3).include_typechange(true).id_abbrev(7);

    if !staged {
        // Widen to untracked files — WITHOUT this, an untracked ("?") file
        // never appears as a delta at all and this function falls straight
        // through to the "No unstaged changes found" error below, even
        // though `workdir_status`'s own `unstaged` list (and the frontend's
        // "Unstaged" section, which renders "?" entries inline and wires
        // every row to this same call) both treat it as a normal, selectable
        // unstaged entry. Same three options `fresh_diff_for_lines` uses for
        // its own untracked-widened read (see that function's doc comment
        // for why all three, together, are required) — kept in lockstep so
        // this read-only view shows EXACTLY the hunks
        // `stage_lines`/`discard_lines` will later re-verify against.
        opts.include_untracked(true).recurse_untracked_dirs(true).show_untracked_content(true);
    }

    let mut diff = if staged {
        // Unborn HEAD (no commits yet) -> None tree (the empty tree), so a
        // staged file in a brand-new repo shows fully as "added".
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
            .map_err(|e| e.message().to_string())?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts))
            .map_err(|e| e.message().to_string())?
    };

    // Fold rename detection in, same as commit_detail_inner, so a renamed
    // file's old_path is populated instead of showing as a delete + add pair.
    let mut find = DiffFindOptions::new();
    find.renames(true).copies(true).rename_limit(1000);
    let _ = diff.find_similar(Some(&mut find));

    let num_deltas = diff.deltas().len();
    for idx in 0..num_deltas {
        let delta = match diff.get_delta(idx) {
            Some(d) => d,
            None => continue,
        };
        if matches!(delta.status(), Delta::Unmodified) {
            continue;
        }

        let status = status_char(delta.status()).to_string();
        let new_path = path_of(delta.new_file().path());
        let old_path_raw = path_of(delta.old_file().path());
        let is_rename = matches!(delta.status(), Delta::Renamed | Delta::Copied);
        let out_path = new_path
            .clone()
            .filter(|p| !p.is_empty())
            .or_else(|| old_path_raw.clone())
            .unwrap_or_default();
        if out_path != file {
            continue; // not the requested file — see the pathspec note above
        }
        let lang = guess_lang(&out_path);
        let old_path = if is_rename { old_path_raw } else { None };

        let patch = Patch::from_diff(&diff, idx).map_err(|e| e.message().to_string())?;
        let is_binary =
            patch.is_none() || delta.new_file().is_binary() || delta.old_file().is_binary();
        if is_binary {
            return Ok(FileChange {
                path: out_path,
                old_path,
                status,
                additions: 0,
                deletions: 0,
                binary: true,
                truncated: false,
                lang,
                hunks: Vec::new(),
            });
        }
        let patch = patch.expect("non-binary patch is Some");
        let (_ctx, additions, deletions) = patch.line_stats().map_err(|e| e.message().to_string())?;

        let mut hunks: Vec<DiffHunkRow> = Vec::new();
        let mut emitted = 0usize;
        let mut truncated = false;
        let num_hunks = patch.num_hunks();
        'hunks: for h in 0..num_hunks {
            let (hunk, _lines) = patch.hunk(h).map_err(|e| e.message().to_string())?;
            let header = String::from_utf8_lossy(hunk.header())
                .trim_end_matches(['\n', '\r'])
                .to_string();
            let n = patch.num_lines_in_hunk(h).map_err(|e| e.message().to_string())?;
            let mut rows: Vec<DiffLineRow> = Vec::with_capacity(n);
            for l in 0..n {
                if emitted >= MAX_LINES_PER_FILE {
                    truncated = true;
                    break 'hunks;
                }
                let line = patch.line_in_hunk(h, l).map_err(|e| e.message().to_string())?;
                let kind = match line.origin() {
                    '+' => "+",
                    '-' => "-",
                    ' ' => " ",
                    _ => continue,
                };
                let text = String::from_utf8_lossy(line.content())
                    .trim_end_matches(['\n', '\r'])
                    .to_string();
                rows.push(DiffLineRow { kind: kind.to_string(), old_no: line.old_lineno(), new_no: line.new_lineno(), text });
                emitted += 1;
            }
            hunks.push(DiffHunkRow { header, lines: rows });
        }

        return Ok(FileChange {
            path: out_path,
            old_path,
            status,
            additions,
            deletions,
            binary: false,
            truncated,
            lang,
            hunks,
        });
    }

    Err(format!(
        "No {} changes found for {file}.",
        if staged { "staged" } else { "unstaged" }
    ))
}

/// Tauri command: list stash entries, newest first, via
/// `git stash list --format=%gd\x01%H\x01%gs` (libgit2 has no stash API).
/// JS: `invoke("stash_list", { path })`.
#[tauri::command]
#[specta::specta]
pub fn stash_list(path: String) -> Result<Vec<StashEntry>, String> {
    let out = git(&path, &["stash", "list", "--format=%gd%x01%H%x01%gs"], false)?;
    if !out.ok {
        return Err(git_msg(&out));
    }
    let mut entries = Vec::new();
    for line in out.stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\u{1}');
        let gd = parts.next().unwrap_or("");
        let sha = parts.next().unwrap_or("").to_string();
        let message = parts.next().unwrap_or("").to_string();
        let index = stash_index(gd);
        let branch = parse_stash_branch(&message);
        entries.push(StashEntry { index, sha: short_sha(&sha), branch, message });
    }
    Ok(entries)
}

/// Parse the `{N}` out of a `stash@{N}` reflog selector; `0` on anything
/// unparseable (should not happen — `%gd` always has this shape).
fn stash_index(gd: &str) -> usize {
    gd.rfind('{')
        .zip(gd.rfind('}'))
        .filter(|(i, j)| j > i)
        .and_then(|(i, j)| gd[i + 1..j].parse::<usize>().ok())
        .unwrap_or(0)
}

/// Best-effort branch name out of git's own generated subject: "WIP on
/// <branch>: <sha> <msg>" (auto) or "On <branch>: <msg>" (`stash push -m`).
/// `None` on anything that doesn't match either shape — a defensive,
/// best-effort enrichment layered on top of the always-correct raw `message`.
fn parse_stash_branch(subject: &str) -> Option<String> {
    let rest = subject.strip_prefix("WIP on ").or_else(|| subject.strip_prefix("On "))?;
    let colon = rest.find(':')?;
    Some(rest[..colon].to_string())
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

// ---------------------------------------------------------------------------
// Writes: index-only (NO snapshot — see this module's doc comment)
// ---------------------------------------------------------------------------

/// Stage one file's full state (new/modified/deleted) with a single explicit
/// pathspec. JS: `invoke("stage_file", { path, file })`.
#[tauri::command]
#[specta::specta]
pub fn stage_file(path: String, file: String) -> WorkdirResult {
    if let Err(e) = validate_pathspec(&file) {
        return WorkdirResult::err(e);
    }
    let spec = literal_pathspec(&file);
    match git(&path, &["add", "-A", "--", &spec], false) {
        Ok(out) if out.ok => WorkdirResult::ok(format!("Staged {file}."), None),
        Ok(out) => WorkdirResult::err(git_msg(&out)),
        Err(e) => WorkdirResult::err(e),
    }
}

/// Unstage one file (`git restore --staged`), leaving the working tree as-is.
/// JS: `invoke("unstage_file", { path, file })`.
#[tauri::command]
#[specta::specta]
pub fn unstage_file(path: String, file: String) -> WorkdirResult {
    if let Err(e) = validate_pathspec(&file) {
        return WorkdirResult::err(e);
    }
    let spec = literal_pathspec(&file);
    match git(&path, &["restore", "--staged", "--", &spec], false) {
        Ok(out) if out.ok => WorkdirResult::ok(format!("Unstaged {file}."), None),
        Ok(out) => WorkdirResult::err(git_msg(&out)),
        Err(e) => WorkdirResult::err(e),
    }
}

/// Stage every unstaged/untracked path (`git add -A`).
/// JS: `invoke("stage_all", { path })`.
#[tauri::command]
#[specta::specta]
pub fn stage_all(path: String) -> WorkdirResult {
    match git(&path, &["add", "-A"], false) {
        Ok(out) if out.ok => WorkdirResult::ok("Staged all changes.", None),
        Ok(out) => WorkdirResult::err(git_msg(&out)),
        Err(e) => WorkdirResult::err(e),
    }
}

// ---------------------------------------------------------------------------
// Write: discard (destructive — content-backup safety net, see doc comment)
// ---------------------------------------------------------------------------

/// `<git-dir>/gitgui/discard-backup/` — reuses the existing `<git-dir>/gitgui/`
/// convention `safety.rs` established for `oplog.jsonl`.
fn discard_backup_dir(repo: &Repository) -> std::path::PathBuf {
    repo.path().join("gitgui").join("discard-backup")
}

/// `<secs>-<nanos>-<seq>-<path-with-/-replaced-by-_>`, unique even for two
/// discards of the same file in the same nanosecond.
fn discard_backup_stem(file: &str) -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let seq = DISCARD_SEQ.fetch_add(1, Ordering::SeqCst);
    let sanitized = file.replace('/', "_");
    format!("{}-{}-{}-{}", now.as_secs(), now.subsec_nanos(), seq, sanitized)
}

/// Back up a TRACKED file's unstaged changes as a real `git apply`-able
/// unified diff, via the same libgit2 diff API `commands::commit_detail_inner`
/// already uses (`diff_index_to_workdir` -> `Patch` -> `to_buf`) — a read, so
/// it stays on the git2 side of the read/CLI split. Returns the backup's
/// git-dir-relative path (e.g. `gitgui/discard-backup/....patch`).
///
/// `include_untracked`: `discard_file`'s existing call site passes `false`,
/// preserving that command's exact prior behavior/tests byte-for-byte (an
/// untracked file was always `discard_file`'s OTHER branch,
/// `backup_untracked_bytes`, never this one). [`discard_lines`] passes `true`
/// — it must also be able to back up a partial-discard of a brand-new
/// untracked file (see this module's `apply_selected_lines`/`fresh_diff_for_lines`,
/// which widen the READ side the same way for `stage_lines`/`discard_lines`).
fn backup_tracked_patch(repo: &Repository, file: &str, include_untracked: bool) -> Result<String, String> {
    // NO `DiffOptions::pathspec` — see `workdir_file_diff_inner`'s doc comment:
    // libgit2's pathspec matcher has no `:(literal)` magic, so a raw filename
    // with glob metacharacters would be (mis)interpreted as a glob. Diff the
    // whole index-to-workdir set and pick the delta whose NEW path is an
    // EXACT match instead — correct regardless of what characters `file`
    // contains.
    let mut opts = DiffOptions::new();
    opts.context_lines(3);
    if include_untracked {
        // See `fresh_diff_for_lines`'s doc comment: `show_untracked_content`
        // is required (not just `include_untracked`) for an untracked
        // delta's `Patch` to actually carry any hunks.
        opts.include_untracked(true).recurse_untracked_dirs(true).show_untracked_content(true);
    }
    let diff = repo
        .diff_index_to_workdir(None, Some(&mut opts))
        .map_err(|e| e.message().to_string())?;
    let num_deltas = diff.deltas().len();
    let idx = (0..num_deltas)
        .find(|&i| diff.get_delta(i).and_then(|d| path_of(d.new_file().path())).as_deref() == Some(file))
        .ok_or_else(|| format!("No unstaged changes to discard for {file}."))?;
    let mut patch = Patch::from_diff(&diff, idx)
        .map_err(|e| e.message().to_string())?
        .ok_or_else(|| format!("Could not build a patch for {file} (binary file?)."))?;
    let buf = patch.to_buf().map_err(|e| e.message().to_string())?;

    let dir = discard_backup_dir(repo);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create backup dir: {e}"))?;
    let name = format!("{}.patch", discard_backup_stem(file));
    fs::write(dir.join(&name), buf.as_str().unwrap_or_default())
        .map_err(|e| format!("could not write backup: {e}"))?;
    Ok(format!("gitgui/discard-backup/{name}"))
}

/// Back up an UNTRACKED path's raw bytes (nothing to diff against). Usually a
/// single file, but NOT always: `git status` reports a directory containing
/// its own nested `.git` (a git repository — e.g. an orphaned submodule
/// checkout left behind after a revert/reset removed its gitlink but, same as
/// real git, couldn't rmdir its populated working tree) as ONE untracked
/// entry rather than recursing into it, regardless of `recurse_untracked_dirs`
/// — that boundary is intentional (git/libgit2 never treat another repo's
/// internals as this one's untracked content). A plain untracked directory
/// can reach here too. Either way, `fs::read` on a directory path fails with
/// "Is a directory" — dispatch on the path's actual type instead of assuming
/// it's always a file.
fn backup_untracked_bytes(repo: &Repository, workdir_path: &str, file: &str) -> Result<String, String> {
    let src = std::path::Path::new(workdir_path).join(file);
    let dir = discard_backup_dir(repo);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create backup dir: {e}"))?;
    let stem = discard_backup_stem(file);

    // symlink_metadata (NOT metadata, which follows the link) — same
    // reasoning as backup_submodule_dirty_content's own dangling-symlink fix
    // in submodule.rs: a broken symlink has no bytes of its own to read, but
    // recording where it pointed is still a real backup.
    let meta = fs::symlink_metadata(&src).map_err(|e| format!("could not read {file}: {e}"))?;
    if meta.file_type().is_symlink() {
        let target = fs::read_link(&src).map_err(|e| format!("could not read symlink target for {file}: {e}"))?;
        let name = format!("{stem}.link");
        fs::write(dir.join(&name), target.to_string_lossy().as_bytes()).map_err(|e| format!("could not write backup: {e}"))?;
        return Ok(format!("gitgui/discard-backup/{name}"));
    }
    if meta.is_dir() {
        backup_dir_recursive(&src, &dir.join(&stem))?;
        return Ok(format!("gitgui/discard-backup/{stem}/"));
    }

    let bytes = fs::read(&src).map_err(|e| format!("could not read {file}: {e}"))?;
    let name = format!("{stem}.orig");
    fs::write(dir.join(&name), &bytes).map_err(|e| format!("could not write backup: {e}"))?;
    Ok(format!("gitgui/discard-backup/{name}"))
}

/// Recursively copy `src` (a directory) into `dest` (created if needed),
/// preserving structure — `backup_untracked_bytes`'s directory case above.
/// Dangling symlinks are backed up as their target path text, same
/// convention (and same reason) as that function's own top-level case.
fn backup_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("could not create {}: {e}", dest.display()))?;
    for entry in fs::read_dir(src).map_err(|e| format!("could not read {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("could not read a directory entry under {}: {e}", src.display()))?;
        let child_src = entry.path();
        let child_dest = dest.join(entry.file_name());
        let meta = fs::symlink_metadata(&child_src).map_err(|e| format!("could not read {}: {e}", child_src.display()))?;
        if meta.file_type().is_symlink() {
            let target = fs::read_link(&child_src)
                .map_err(|e| format!("could not read symlink target for {}: {e}", child_src.display()))?;
            fs::write(&child_dest, target.to_string_lossy().as_bytes())
                .map_err(|e| format!("could not back up {}: {e}", child_src.display()))?;
        } else if meta.is_dir() {
            backup_dir_recursive(&child_src, &child_dest)?;
        } else {
            let bytes = fs::read(&child_src).map_err(|e| format!("could not read {}: {e}", child_src.display()))?;
            fs::write(&child_dest, &bytes).map_err(|e| format!("could not back up {}: {e}", child_src.display()))?;
        }
    }
    Ok(())
}

/// If `file` is CURRENTLY an unstaged rename (some `old_path` renamed on disk
/// to `file`, never staged), return `old_path` — re-derives the rename from
/// git2's own rename-aware status (the exact computation `workdir_status`
/// already performs for its "unstaged" list) rather than adding an `old_path`
/// parameter to `discard_file`'s signature: the frontend already knows the
/// shape from `workdir_status`'s own response, but re-deriving here keeps
/// this command's signature (and every existing call site) unchanged.
fn unstaged_rename_old_path(repo: &Repository, file: &str) -> Option<String> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true).renames_index_to_workdir(true);
    let statuses = repo.statuses(Some(&mut opts)).ok()?;
    for entry in statuses.iter() {
        if !entry.status().is_wt_renamed() {
            continue;
        }
        let delta = entry.index_to_workdir()?;
        if path_of(delta.new_file().path()).as_deref() == Some(file) {
            return path_of(delta.old_file().path());
        }
    }
    None
}

/// Discard an UNSTAGED rename (`old_path` -> `file`, on disk only — never
/// `git add`ed). `backup_tracked_patch`'s plain `diff_index_to_workdir` sees
/// ZERO deltas for this shape: the new path has no index entry so it's
/// simply untracked (excluded unless `include_untracked` is set, which that
/// fn deliberately doesn't — see its own doc comment), and the old path has
/// no working-tree entry to diff against either. Reversing the on-disk rename
/// is a dedicated two-step instead: back up `file`'s bytes (it was never
/// staged/committed anywhere, so those bytes are the only copy of "the
/// rename"), restore `old_path` from the index (`git restore --worktree`,
/// same source as the plain tracked-file discard path below), then remove
/// `file` (`git clean -f`, same as the plain untracked-file discard path).
/// Defensively backs up `old_path` too if something ALREADY sits there (rare,
/// but the restore would otherwise silently clobber it) — mirrors this
/// file's "always back up before mutating" discipline.
fn discard_unstaged_rename(path: &str, repo: &Repository, old_path: &str, new_path: &str) -> WorkdirResult {
    if let Err(e) = validate_pathspec(old_path) {
        return WorkdirResult::err(format!("Cannot restore the old path {old_path:?}: {e}"));
    }

    let backup_patch = match backup_untracked_bytes(repo, path, new_path) {
        Ok(p) => p,
        Err(e) => return WorkdirResult::err(format!("Could not back up {new_path} before discarding, refusing: {e}")),
    };

    if std::path::Path::new(path).join(old_path).exists() {
        if let Err(e) = backup_untracked_bytes(repo, path, old_path) {
            return WorkdirResult {
                ok: false,
                message: format!(
                    "Refusing: {old_path} already exists and could not be backed up before restoring it: {e}"
                ),
                conflicted_files: Vec::new(),
                backup_ref: None,
                backup_patch: Some(backup_patch),
                dropped_stash_ref: None,
            };
        }
    }

    let old_spec = literal_pathspec(old_path);
    if let Err(msg) = match git(path, &["restore", "--worktree", "--", &old_spec], false) {
        Ok(out) if out.ok => Ok(()),
        Ok(out) => Err(format!("Could not restore {old_path}: {}", git_msg(&out))),
        Err(e) => Err(format!("Could not restore {old_path}: {e}")),
    } {
        return WorkdirResult {
            ok: false,
            message: msg,
            conflicted_files: Vec::new(),
            backup_ref: None,
            backup_patch: Some(backup_patch),
            dropped_stash_ref: None,
        };
    }

    let new_spec = literal_pathspec(new_path);
    match git(path, &["clean", "-f", "--", &new_spec], false) {
        Ok(out) if out.ok => WorkdirResult {
            ok: true,
            message: format!(
                "Discarded the rename ({old_path} -> {new_path}): restored {old_path}, removed {new_path} (backup: {backup_patch})."
            ),
            conflicted_files: Vec::new(),
            backup_ref: None,
            backup_patch: Some(backup_patch),
            dropped_stash_ref: None,
        },
        Ok(out) => WorkdirResult {
            ok: false,
            message: format!("Restored {old_path}, but could not remove {new_path}: {}", git_msg(&out)),
            conflicted_files: Vec::new(),
            backup_ref: None,
            backup_patch: Some(backup_patch),
            dropped_stash_ref: None,
        },
        Err(e) => WorkdirResult {
            ok: false,
            message: format!("Restored {old_path}, but could not remove {new_path}: {e}"),
            conflicted_files: Vec::new(),
            backup_ref: None,
            backup_patch: Some(backup_patch),
            dropped_stash_ref: None,
        },
    }
}

/// Discard unstaged changes to one file. Destructive: this is the ONE gap the
/// Safety-Manager ref mechanism cannot cover (see doc comment), so it ALWAYS
/// writes a content backup first, then mutates. `untracked=false` restores a
/// tracked file's content to what's in the index (`git restore --worktree`);
/// `untracked=true` removes an untracked file (`git clean -f`). An UNSTAGED
/// RENAME (`old_path` set, `untracked=false`) is a special case handled by
/// [`discard_unstaged_rename`] — see its doc comment for why the plain path
/// below can't handle it (it always finds zero deltas and refuses with "No
/// unstaged changes to discard", even though the status view correctly shows
/// a rename). The caller (frontend controller) is responsible for a
/// typed-confirm gate before this is ever invoked — this command itself does
/// not prompt.
/// JS: `invoke("discard_file", { path, file, untracked })`.
#[tauri::command]
#[specta::specta]
pub fn discard_file(path: String, file: String, untracked: bool) -> WorkdirResult {
    if let Err(e) = validate_pathspec(&file) {
        return WorkdirResult::err(e);
    }
    let repo = match open_repo(&path) {
        Ok(r) => r,
        Err(w) => return w,
    };

    if !untracked {
        if let Some(old_path) = unstaged_rename_old_path(&repo, &file) {
            return discard_unstaged_rename(&path, &repo, &old_path, &file);
        }
    }

    let backup_patch = if untracked {
        backup_untracked_bytes(&repo, &path, &file)
    } else {
        backup_tracked_patch(&repo, &file, false)
    };
    let backup_patch = match backup_patch {
        Ok(p) => p,
        Err(e) => return WorkdirResult::err(format!("Could not back up {file} before discarding, refusing: {e}")),
    };

    let spec = literal_pathspec(&file);
    // `-d` matters now that the backup above can cover a directory: `git
    // clean -f` alone silently leaves untracked DIRECTORIES in place (`-d` is
    // what tells it to remove those, not just untracked files). A SECOND `-f`
    // matters too, specifically for a directory containing its own nested
    // `.git` (an orphaned submodule checkout is exactly this shape) — git
    // silently refuses to remove one of those unless force is given TWICE,
    // an extra, distinct safety gate on top of `-d` (EMPIRICALLY VERIFIED:
    // `-f -d` alone leaves it in place with no error, no output). Safe to
    // pass unconditionally: it's already been backed up above, and `-f -f`
    // is a no-op for a plain file or an ordinary untracked directory.
    let result = if untracked {
        git(&path, &["clean", "-f", "-f", "-d", "--", &spec], false)
    } else {
        git(&path, &["restore", "--worktree", "--", &spec], false)
    };

    match result {
        Ok(out) if out.ok => WorkdirResult {
            ok: true,
            message: format!("Discarded changes to {file} (backup: {backup_patch})."),
            conflicted_files: Vec::new(),
            backup_ref: None,
            backup_patch: Some(backup_patch),
            dropped_stash_ref: None,
        },
        // The backup was already written even though the mutation itself
        // failed — keep pointing at it so nothing is orphaned/unexplained.
        Ok(out) => WorkdirResult {
            ok: false,
            message: git_msg(&out),
            conflicted_files: Vec::new(),
            backup_ref: None,
            backup_patch: Some(backup_patch),
            dropped_stash_ref: None,
        },
        Err(e) => WorkdirResult {
            ok: false,
            message: e,
            conflicted_files: Vec::new(),
            backup_ref: None,
            backup_patch: Some(backup_patch),
            dropped_stash_ref: None,
        },
    }
}

// ---------------------------------------------------------------------------
// Writes: hunk/line-level staging (stage_lines / unstage_lines / discard_lines)
//
// Same "re-derive fresh, validate, refuse-wholesale-on-mismatch" discipline as
// `git_rebase::rebase_interactive_start` (see that function's doc comment):
// the frontend never sends a constructed patch, only POSITIONS (a hunk
// `header` + per-line `kind`/`old_no`/`new_no`) copied verbatim from what
// `workdir_file_diff` last returned. Before doing anything, this re-reads the
// relevant diff (index<->workdir for stage/discard, HEAD<->index for
// unstage) and requires an EXACT match for every requested hunk header and
// every requested line — any mismatch (the diff changed since the caller
// looked) refuses the ENTIRE request, never partially applies. Snapshot
// policy: `stage_lines`/`unstage_lines` are index-only, same as
// `stage_file`/`unstage_file` — no snapshot (see module doc comment).
// `discard_lines` is destructive on the working tree, same as `discard_file`
// — it always calls `backup_tracked_patch` first, same ordering discipline.
// ---------------------------------------------------------------------------

/// One selected "+"/"-" row, identified the SAME way `DiffLineRow` already
/// describes it to the frontend (`model.rs`) — `kind`/`old_no`/`new_no`. A
/// context (`" "`) row is never sent here: context is always implicitly kept.
#[derive(Deserialize, specta::Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SelectedLine {
    pub kind: String,        // "+" | "-" — never " "
    pub old_no: Option<u32>, // Some for "-", None for "+"
    pub new_no: Option<u32>, // Some for "+", None for "-"
}

/// One hunk's selection. `header` is `DiffHunkRow::header` byte-for-byte, as
/// last fetched by `workdir_file_diff` — the anchor this module re-verifies
/// against a FRESH read before trusting anything else in this struct.
/// `Vec<HunkSelection>` (not a single hunk) so one call covers a multi-hunk
/// selection — this is what makes hunk-level ("all lines of this hunk") and
/// line-level ("these three lines across two different hunks") the SAME
/// backend call shape, differing only in how many `SelectedLine`s the
/// frontend puts in each `HunkSelection`.
#[derive(Deserialize, specta::Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HunkSelection {
    pub header: String,
    pub lines: Vec<SelectedLine>,
}

/// Which of the three ops [`apply_selected_lines`] is performing — see
/// `fresh_diff_for_lines`/the match in `apply_selected_lines` for how each
/// picks its source diff and `git apply` invocation.
enum LineOpDirection {
    Stage,
    Unstage,
    Discard,
}

/// Stage only the selected `+`/`-` lines (whole hunks or a subset) out of a
/// file's CURRENT unstaged diff. JS: `invoke("stage_lines", { path, file, hunks })`.
#[tauri::command]
#[specta::specta]
pub fn stage_lines(path: String, file: String, hunks: Vec<HunkSelection>) -> WorkdirResult {
    apply_selected_lines(&path, &file, &hunks, LineOpDirection::Stage)
}

/// Unstage only the selected `+`/`-` lines out of a file's CURRENT staged
/// diff (HEAD vs index). JS: `invoke("unstage_lines", { path, file, hunks })`.
#[tauri::command]
#[specta::specta]
pub fn unstage_lines(path: String, file: String, hunks: Vec<HunkSelection>) -> WorkdirResult {
    apply_selected_lines(&path, &file, &hunks, LineOpDirection::Unstage)
}

/// Discard (from the working tree) only the selected `+`/`-` lines out of a
/// file's CURRENT unstaged diff. Destructive — always backs up first, same
/// discipline as `discard_file`. The caller (frontend controller) is
/// responsible for a typed-confirm gate before this is ever invoked, exactly
/// like `discard_file`. JS: `invoke("discard_lines", { path, file, hunks })`.
#[tauri::command]
#[specta::specta]
pub fn discard_lines(path: String, file: String, hunks: Vec<HunkSelection>) -> WorkdirResult {
    apply_selected_lines(&path, &file, &hunks, LineOpDirection::Discard)
}

/// One line inside a hunk, as read straight off the fresh `git2::Patch` — the
/// RAW walk, not `workdir_file_diff_inner`'s DTO-building loop (that loop's
/// `match line.origin() { '+'|'-'|' ' => ..., _ => continue }` silently drops
/// the `'='`/`'>'`/`'<'` "no newline at end of file" marker lines; this
/// reconstruction path must not lose that). `eof_marker`, if set, is the raw
/// text of the marker line immediately following this one in the hunk (always
/// the final unit of a hunk, and only ever in a file's last hunk).
struct RawUnit {
    origin: char, // ' ' | '+' | '-'
    old_no: Option<u32>,
    new_no: Option<u32>,
    text: String, // as returned by DiffLine::content(), trailing '\n' kept as-is
    eof_marker: Option<String>,
}

fn collect_raw_units(patch: &Patch, h: usize) -> Result<Vec<RawUnit>, String> {
    let n = patch.num_lines_in_hunk(h).map_err(|e| e.message().to_string())?;
    let mut units: Vec<RawUnit> = Vec::with_capacity(n);
    for l in 0..n {
        let line = patch.line_in_hunk(h, l).map_err(|e| e.message().to_string())?;
        let text = String::from_utf8_lossy(line.content()).into_owned();
        match line.origin() {
            '+' | '-' | ' ' => units.push(RawUnit {
                origin: line.origin(),
                old_no: line.old_lineno(),
                new_no: line.new_lineno(),
                text,
                eof_marker: None,
            }),
            // "No newline at end of file" markers: always immediately follow
            // the content line they annotate (see struct doc comment) — fold
            // it into that unit rather than emitting it as its own row.
            //
            // EMPIRICALLY VERIFIED: libgit2's `DiffLine::content()` for one of
            // these synthetic marker lines is prefixed with a LEADING '\n' —
            // representing the previous content line's own (now-absent)
            // newline terminator, not part of the "\ No newline..." text
            // itself. Left in, that leading '\n' reconstructs as a spurious
            // blank line between the content line and its annotation, which
            // `git apply` then rejects outright ("patch does not apply").
            '=' | '>' | '<' => {
                if let Some(last) = units.last_mut() {
                    last.eof_marker = Some(text.trim_start_matches(['\n', '\r']).to_string());
                }
            }
            _ => {}
        }
    }
    Ok(units)
}

/// One fresh hunk: its verbatim (trimmed) header text — the anchor the caller's
/// `HunkSelection.header` must match byte-for-byte — plus its start lines
/// (copied verbatim into the reconstructed header, never recomputed — see
/// `build_sub_patch`'s doc comment on `--recount`) and raw line units.
struct FreshHunk {
    header: String,
    old_start: u32,
    new_start: u32,
    units: Vec<RawUnit>,
}

/// The FRESH diff `apply_selected_lines` re-derives and validates every
/// request against, before trusting anything in it. `staged`: HEAD-vs-index
/// (for `unstage_lines`) or index-vs-workdir (`stage_lines`/`discard_lines`).
/// `include_untracked`: widen the index-vs-workdir read so a brand-new file's
/// lines are selectable at all (`workdir_file_diff_inner`'s own plain
/// unstaged-diff READ deliberately does not widen this way — a separate,
/// existing choice for that read-only view — but the selection/mutation path
/// here needs to see exactly the hunks the untracked-widened view would show).
/// Folds in the SAME rename-detection options as `workdir_file_diff_inner`
/// (`renames(true).copies(true).rename_limit(1000)`) — otherwise this fresh
/// read could fold/not-fold a rename differently than the read the frontend's
/// hunk headers came from, and every header would mismatch spuriously.
fn fresh_diff_for_lines(
    repo: &Repository,
    staged: bool,
    include_untracked: bool,
) -> Result<git2::Diff<'_>, String> {
    let mut opts = DiffOptions::new();
    opts.context_lines(3).include_typechange(true).id_abbrev(7);
    if include_untracked {
        // `include_untracked` alone only lists an untracked file as a delta —
        // EMPIRICALLY VERIFIED it does NOT populate that delta's patch with
        // any hunks (`Patch::from_diff` succeeds but `num_hunks() == 0`)
        // unless `show_untracked_content` is ALSO set; `recurse_untracked_dirs`
        // is separately needed so untracked directories are walked at all
        // (both are needed together, per git2's own doc comment on
        // `show_untracked_content`: it "does not turn on
        // recurse_untracked_dirs").
        opts.include_untracked(true).recurse_untracked_dirs(true).show_untracked_content(true);
    }
    let mut diff = if staged {
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
            .map_err(|e| e.message().to_string())?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts)).map_err(|e| e.message().to_string())?
    };
    let mut find = DiffFindOptions::new();
    find.renames(true).copies(true).rename_limit(1000);
    let _ = diff.find_similar(Some(&mut find));
    Ok(diff)
}

/// `100644` / `100755` / `120000` / `160000` / `040000` for a `new file
/// mode`/`deleted file mode` header line. Anything else (`Unreadable` — should
/// not occur on a real delta) falls back to the ordinary blob mode.
fn mode_string(mode: FileMode) -> &'static str {
    match mode {
        FileMode::Link => "120000",
        FileMode::Commit => "160000",
        FileMode::BlobExecutable => "100755",
        FileMode::Tree => "040000",
        _ => "100644",
    }
}

/// The reconstructed sub-patch text plus a human count of lines actually
/// selected (for the success message only — never load-bearing).
struct BuiltPatch {
    text: String,
    line_count: usize,
}

/// Locate `file`'s delta in the fresh `diff` (exact new-path string match,
/// same convention as `workdir_file_diff_inner`/`backup_tracked_patch` — see
/// their doc comments for why libgit2's own pathspec matcher can't be trusted
/// here), validate every requested hunk/line against it EXACTLY, and — only
/// once everything checks out — reconstruct one sub-patch covering just the
/// selected lines, per this feature's design doc §2.1/§2.5.
///
/// Header line counts: uses `--recount`-friendly best-effort counts (the
/// actual `git apply --recount` invocation in `apply_selected_lines`
/// recomputes them from the body regardless — see that function's doc
/// comment — so these are read-back convenience only, never load-bearing).
/// `old_start`/`new_start` ARE load-bearing (they say WHERE to apply) and are
/// copied verbatim from the fresh hunk, never recomputed.
///
/// `reverse`: true for `unstage_lines`/`discard_lines`, both of which apply
/// the reconstructed sub-patch via `git apply -R`. This flips WHICH side of
/// an unselected modification pair (`-old` / `+new`) must be demoted to
/// context rather than dropped: a forward `git apply` matches the patch's OLD
/// side against the current base (index for stage), so an unselected `-`
/// (still genuinely present, unchanged, in that base) demotes to context and
/// an unselected `+` is simply dropped. `git apply -R` instead matches the
/// patch's NEW side against the current base (index for unstage, workdir for
/// discard) — EMPIRICALLY VERIFIED: demoting the unselected `-` there (as the
/// forward rule would) fabricates a context line that does NOT match what's
/// actually in that base (it's already reflecting the unselected NEW-side
/// content), so the reverse apply fails with "patch does not apply". The fix
/// is the mirror image: for `reverse`, an unselected `+` demotes to context
/// (it genuinely IS what the matched base currently holds) and an unselected
/// `-` is dropped (its old content was never really part of the matched
/// side).
fn build_sub_patch(
    diff: &git2::Diff,
    file: &str,
    hunks: &[HunkSelection],
    reverse: bool,
) -> Result<BuiltPatch, String> {
    const STALE_MSG: &str =
        "This file's diff has changed since you last looked — refresh and try again.";

    let num_deltas = diff.deltas().len();
    let mut found: Option<usize> = None;
    for i in 0..num_deltas {
        let Some(delta) = diff.get_delta(i) else { continue };
        let new_path = path_of(delta.new_file().path()).filter(|p| !p.is_empty());
        if new_path.as_deref() == Some(file) {
            found = Some(i);
            break;
        }
        // A full delete has no new-side path at all — match on the old path
        // instead (a rename still identifies itself by its NEW path only,
        // same convention `discard_file`'s unstaged-rename case already uses).
        if matches!(delta.status(), Delta::Deleted) {
            let old_path = path_of(delta.old_file().path()).filter(|p| !p.is_empty());
            if old_path.as_deref() == Some(file) {
                found = Some(i);
                break;
            }
        }
    }
    let Some(idx) = found else {
        return Err(STALE_MSG.into());
    };
    let delta = diff.get_delta(idx).expect("idx was just found in this same diff");

    if matches!(delta.status(), Delta::Typechange) {
        return Err(format!(
            "{file} changed type (file <-> symlink, etc.) — line-level staging isn't supported; stage/discard the whole file instead."
        ));
    }

    // Building the `Patch` FIRST, then checking `is_binary`, exactly matches
    // `workdir_file_diff_inner`'s own order — EMPIRICALLY VERIFIED that
    // `delta.new_file().is_binary()`/`old_file().is_binary()` are NOT yet
    // populated on a delta fresh off `get_delta()`; libgit2 only fills them in
    // once the actual patch/content diffing has run (i.e. inside
    // `Patch::from_diff`). Checking them beforehand would silently treat
    // every binary file as non-binary.
    let patch = match Patch::from_diff(diff, idx) {
        Ok(Some(p)) => p,
        Ok(None) => {
            return Err(format!(
                "{file} is a binary file — line-level staging isn't supported; stage/discard the whole file instead."
            ))
        }
        Err(e) => return Err(e.message().to_string()),
    };
    let delta = diff.get_delta(idx).expect("idx was just found in this same diff");
    if delta.new_file().is_binary() || delta.old_file().is_binary() {
        return Err(format!(
            "{file} is a binary file — line-level staging isn't supported; stage/discard the whole file instead."
        ));
    }

    let num_hunks = patch.num_hunks();
    let mut fresh: Vec<FreshHunk> = Vec::with_capacity(num_hunks);
    for h in 0..num_hunks {
        let (hunk, _n) = patch.hunk(h).map_err(|e| e.message().to_string())?;
        let header = String::from_utf8_lossy(hunk.header()).trim_end_matches(['\n', '\r']).to_string();
        let units = collect_raw_units(&patch, h)?;
        fresh.push(FreshHunk { header, old_start: hunk.old_start(), new_start: hunk.new_start(), units });
    }

    // Validate every requested hunk header + every requested line against the
    // fresh read, EXACTLY — any miss refuses the WHOLE request (see this
    // module's doc comment banner above `stage_lines`/etc).
    let mut selected: HashMap<usize, HashSet<(String, Option<u32>, Option<u32>)>> = HashMap::new();
    for req in hunks {
        let Some(fresh_idx) = fresh.iter().position(|f| f.header == req.header) else {
            return Err(STALE_MSG.into());
        };
        for line in &req.lines {
            if line.kind != "+" && line.kind != "-" {
                return Err(format!(
                    "Invalid selected line kind {:?} — only \"+\"/\"-\" rows can be selected.",
                    line.kind
                ));
            }
            let exists = fresh[fresh_idx]
                .units
                .iter()
                .any(|u| u.origin.to_string() == line.kind && u.old_no == line.old_no && u.new_no == line.new_no);
            if !exists {
                return Err(STALE_MSG.into());
            }
        }
        let entry = selected.entry(fresh_idx).or_default();
        for line in &req.lines {
            entry.insert((line.kind.clone(), line.old_no, line.new_no));
        }
    }
    if selected.is_empty() || selected.values().all(|s| s.is_empty()) {
        return Err("No lines selected.".into());
    }

    // A hunk containing an `eof_marker`-bearing unit is, by definition, a
    // file's LAST hunk where at least one side (old, new, or both) has no
    // trailing newline (collect_raw_units's doc comment: the marker only
    // ever appears there). EMPIRICALLY VERIFIED with real `git apply`: for
    // such a hunk, only the ORIGINAL, unmodified adjacency of a "no-newline"
    // `-`/`+` pair (both sides selected together, exactly as git's own diff
    // output shows them: `-old`, its marker, `+new`, its marker, back to
    // back) is a valid, safe reconstruction. Any PARTIAL selection touching
    // that hunk is unsafe in BOTH directions: carrying a demoted unit's own
    // marker forward produces a patch `git apply` accepts but silently
    // concatenates two lines with no separator (verified: "a3" + "a3-changed"
    // → literal "a3a3-changed", no error); dropping that marker instead
    // produces a patch `git apply` cleanly REFUSES outright, since the
    // now-marker-less context line no longer matches the real file's actual
    // (newline-less) bytes. There is no reconstruction that is both accepted
    // by git AND correct for a partial selection here — so refuse the whole
    // request up front instead of ever constructing one, matching this
    // module's "fail closed, never guess" convention elsewhere (checkout on a
    // dirty tree, pull on divergence). The user can still select the WHOLE
    // hunk (equivalent to "stage/unstage/discard this hunk"), or fully
    // stage/unstage/discard the file — only cherry-picking individual lines
    // *within* a no-trailing-newline boundary hunk is unsupported.
    for (h, fh) in fresh.iter().enumerate() {
        let Some(sel) = selected.get(&h) else { continue };
        let has_eof_marker = fh.units.iter().any(|u| u.eof_marker.is_some());
        if !has_eof_marker {
            continue;
        }
        let fully_selected = fh
            .units
            .iter()
            .filter(|u| u.origin == '+' || u.origin == '-')
            .all(|u| sel.contains(&(u.origin.to_string(), u.old_no, u.new_no)));
        if !fully_selected {
            return Err(format!(
                "{file}'s last line doesn't end with a newline on at least one side of this change — \
                 partial line selection isn't supported there. Select the whole hunk (or the whole file) instead."
            ));
        }
    }

    // Reconstruct, in the fresh patch's OWN top-to-bottom hunk order (never
    // the request array's order — `git apply` requires ascending position
    // order within one file).
    let is_delete_delta = matches!(delta.status(), Delta::Deleted);
    let mut covers_full_delete = is_delete_delta;
    // `Untracked` (a brand-new file, seen only via the untracked-widened
    // reads this module uses — see `status_char`'s doc comment) counts as an
    // "add" here exactly like `Delta::Added` does; the header match below
    // treats the two identically.
    let is_added_delta = matches!(delta.status(), Delta::Added | Delta::Untracked);
    let mut covers_full_add = is_added_delta;
    // Same idea again for `Delta::Renamed`: EMPIRICALLY VERIFIED (real `git
    // apply --cached -R`, not just reasoning) that a PARTIAL content
    // selection must NOT emit the rename header at all — `rename from/to`
    // plus a two-path `--- a/{old} +++ b/{new}` header applied to only some
    // of the content lines silently reverts the ENTIRE rename in the index
    // (git happily "un-renames" the path back to old_path even though only
    // some lines were meant to change), while the plain single-path
    // modification header (matching the generic `_ =>` branch below) leaves
    // the rename alone and only touches the selected content — confirmed
    // by checking `git ls-files -s`/`git status --porcelain=2` after
    // applying: the path stays at new_path, and git's OWN similarity
    // detection still reports it as a rename against HEAD regardless,
    // since renames are computed at diff-time from tree content, never
    // stored as a flag the sub-patch needs to assert.
    let mut covers_full_rename = matches!(delta.status(), Delta::Renamed);
    let mut body = String::new();
    let mut hunk_count = 0usize;
    let mut selected_line_count = 0usize;

    for (h, fh) in fresh.iter().enumerate() {
        let Some(sel) = selected.get(&h) else { continue };
        let mut out_lines: Vec<String> = Vec::new();
        let mut old_count = 0u32;
        let mut new_count = 0u32;
        for unit in &fh.units {
            let key = (unit.origin.to_string(), unit.old_no, unit.new_no);
            match unit.origin {
                ' ' => {
                    out_lines.push(format!(" {}", unit.text));
                    old_count += 1;
                    new_count += 1;
                    if let Some(m) = &unit.eof_marker {
                        out_lines.push(m.clone());
                    }
                }
                '+' => {
                    if sel.contains(&key) {
                        out_lines.push(format!("+{}", unit.text));
                        new_count += 1;
                        selected_line_count += 1;
                        if let Some(m) = &unit.eof_marker {
                            out_lines.push(m.clone());
                        }
                    } else if reverse {
                        // See this function's doc comment: for a REVERSE
                        // apply, the matched base already genuinely has this
                        // content — demote to context instead of dropping.
                        out_lines.push(format!(" {}", unit.text));
                        old_count += 1;
                        new_count += 1;
                        if let Some(m) = &unit.eof_marker {
                            out_lines.push(m.clone());
                        }
                        covers_full_add = false;
                        covers_full_rename = false;
                    } else {
                        // Forward, unselected: drop entirely — no pre-image
                        // to demote it into. Still a partial selection.
                        covers_full_rename = false;
                    }
                }
                '-' => {
                    if sel.contains(&key) {
                        out_lines.push(format!("-{}", unit.text));
                        old_count += 1;
                        selected_line_count += 1;
                        if let Some(m) = &unit.eof_marker {
                            out_lines.push(m.clone());
                        }
                    } else if reverse {
                        // See this function's doc comment: for a REVERSE
                        // apply, this old content was never really part of
                        // the matched (new-side) base — drop entirely.
                        covers_full_delete = false;
                        covers_full_rename = false;
                    } else {
                        // Demote to context: the old content persists
                        // unchanged as far as THIS sub-patch is concerned.
                        out_lines.push(format!(" {}", unit.text));
                        old_count += 1;
                        new_count += 1;
                        if let Some(m) = &unit.eof_marker {
                            out_lines.push(m.clone());
                        }
                        covers_full_delete = false;
                        covers_full_rename = false;
                    }
                }
                _ => {}
            }
        }
        if out_lines.is_empty() {
            continue;
        }
        hunk_count += 1;
        body.push_str(&format!("@@ -{},{} +{},{} @@\n", fh.old_start, old_count, fh.new_start, new_count));
        for l in &out_lines {
            body.push_str(l);
            if !l.ends_with('\n') {
                body.push('\n');
            }
        }
    }

    if hunk_count == 0 {
        return Err("No lines selected.".into());
    }

    // File-level header — see design §2.5 for why new/deleted/renamed each
    // need the full git extended header while a plain modification doesn't.
    let new_path = path_of(delta.new_file().path()).filter(|p| !p.is_empty());
    let old_path = path_of(delta.old_file().path()).filter(|p| !p.is_empty());
    let mut header_text = String::new();
    match delta.status() {
        // `Untracked` is folded in with `Added` throughout (see
        // `is_added_delta`'s doc comment above) — a brand-new untracked
        // file's fully-selected diff needs the SAME "new file mode" +
        // `/dev/null` header a HEAD-vs-index `Added` delta would get; `git
        // apply --cached` has no index-side blob to match against otherwise.
        Delta::Added | Delta::Untracked if covers_full_add => {
            let p = new_path.clone().unwrap_or_else(|| file.to_string());
            header_text.push_str(&format!("diff --git a/{p} b/{p}\n"));
            header_text.push_str(&format!("new file mode {}\n", mode_string(delta.new_file().mode())));
            header_text.push_str("--- /dev/null\n");
            header_text.push_str(&format!("+++ b/{p}\n"));
        }
        Delta::Added | Delta::Untracked => {
            // Partial un-add: the file survives as a shorter MODIFIED entry
            // (mirrors the `Delta::Deleted` partial-delete case below).
            let p = new_path.clone().unwrap_or_else(|| file.to_string());
            header_text.push_str(&format!("--- a/{p}\n"));
            header_text.push_str(&format!("+++ b/{p}\n"));
        }
        Delta::Deleted if covers_full_delete => {
            let p = old_path.clone().unwrap_or_else(|| file.to_string());
            header_text.push_str(&format!("diff --git a/{p} b/{p}\n"));
            header_text.push_str(&format!("deleted file mode {}\n", mode_string(delta.old_file().mode())));
            header_text.push_str(&format!("--- a/{p}\n"));
            header_text.push_str("+++ /dev/null\n");
        }
        Delta::Deleted => {
            // Partial delete: the file survives as a shorter MODIFIED entry.
            let p = old_path.clone().unwrap_or_else(|| file.to_string());
            header_text.push_str(&format!("--- a/{p}\n"));
            header_text.push_str(&format!("+++ b/{p}\n"));
        }
        Delta::Renamed if covers_full_rename => {
            let op = old_path.clone().unwrap_or_else(|| file.to_string());
            let np = new_path.clone().unwrap_or_else(|| file.to_string());
            header_text.push_str(&format!("diff --git a/{op} b/{np}\n"));
            header_text.push_str(&format!("rename from {op}\n"));
            header_text.push_str(&format!("rename to {np}\n"));
            header_text.push_str(&format!("--- a/{op}\n"));
            header_text.push_str(&format!("+++ b/{np}\n"));
        }
        Delta::Renamed => {
            // Partial: leave the rename (the file's path/identity in the
            // index) alone, touch only the selected content at its CURRENT
            // path — see this function's covers_full_rename doc comment for
            // why asserting the rename here would silently undo it instead.
            let p = new_path.clone().unwrap_or_else(|| file.to_string());
            header_text.push_str(&format!("--- a/{p}\n"));
            header_text.push_str(&format!("+++ b/{p}\n"));
        }
        _ => {
            let p = new_path.clone().or_else(|| old_path.clone()).unwrap_or_else(|| file.to_string());
            header_text.push_str(&format!("--- a/{p}\n"));
            header_text.push_str(&format!("+++ b/{p}\n"));
        }
    }

    Ok(BuiltPatch { text: format!("{header_text}{body}"), line_count: selected_line_count })
}

/// Like `git()`, but pipes `patch` to the child's stdin instead of relying on
/// filesystem paths — needed because the sub-patch built by [`build_sub_patch`]
/// is dynamically constructed text, never written to disk. Same `Out`
/// contract as every other mutation in this module.
fn git_apply_stdin(path: &str, args: &[&str], patch: &str) -> Result<Out, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Could not run git: {e}"))?;
    child
        .stdin
        .take()
        .expect("stdin was requested as piped")
        .write_all(patch.as_bytes())
        .map_err(|e| format!("Could not write the patch to git apply's stdin: {e}"))?;
    let o = child.wait_with_output().map_err(|e| format!("Could not run git: {e}"))?;
    Ok(Out {
        ok: o.status.success(),
        code: o.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&o.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&o.stderr).trim().to_string(),
    })
}

/// Shared body for `stage_lines`/`unstage_lines`/`discard_lines`: pick the
/// fresh source diff for `dir` (see [`fresh_diff_for_lines`]), validate +
/// reconstruct the sub-patch for exactly the requested lines (see
/// [`build_sub_patch`]), then apply it with the ONE `git apply` invocation
/// that differs per direction (design §2.3):
///   * Stage:   `git apply --cached --recount -`      (forward, index-only)
///   * Unstage: `git apply --cached --recount -R -`   (reverse, index-only —
///     the sub-patch is built from HEAD->index, so reversing walks the index
///     back toward HEAD for just the selected lines)
///   * Discard: `git apply --recount -R -`             (reverse, working tree
///     only — backs up first, same ordering discipline as `discard_file`)
fn apply_selected_lines(path: &str, file: &str, hunks: &[HunkSelection], dir: LineOpDirection) -> WorkdirResult {
    if let Err(e) = validate_pathspec(file) {
        return WorkdirResult::err(e);
    }
    if hunks.is_empty() || hunks.iter().all(|h| h.lines.is_empty()) {
        return WorkdirResult::err("No lines selected.");
    }
    let repo = match open_repo(path) {
        Ok(r) => r,
        Err(w) => return w,
    };

    // unstage_lines reads HEAD-vs-index (already fully represents a new
    // staged file, no widening needed); stage_lines/discard_lines read
    // index-vs-workdir, widened with include_untracked so a brand-new file's
    // lines are selectable at all (design §5, item 2).
    let staged_side = matches!(dir, LineOpDirection::Unstage);
    let include_untracked = !staged_side;

    let diff = match fresh_diff_for_lines(&repo, staged_side, include_untracked) {
        Ok(d) => d,
        Err(e) => return WorkdirResult::err(e),
    };
    // `unstage_lines`/`discard_lines` both apply the sub-patch via `git apply
    // -R` — see `build_sub_patch`'s doc comment for why that flips which side
    // of an unselected modification pair gets demoted to context.
    let reverse = matches!(dir, LineOpDirection::Unstage | LineOpDirection::Discard);
    let built = match build_sub_patch(&diff, file, hunks, reverse) {
        Ok(b) => b,
        Err(e) => return WorkdirResult::err(e),
    };
    let plural = if built.line_count == 1 { "" } else { "s" };

    match dir {
        LineOpDirection::Stage => {
            match git_apply_stdin(path, &["apply", "--cached", "--recount", "-"], &built.text) {
                Ok(out) if out.ok => WorkdirResult::ok(
                    format!("Staged {} selected line{plural} in {file}.", built.line_count),
                    None,
                ),
                Ok(out) => WorkdirResult::err(git_msg(&out)),
                Err(e) => WorkdirResult::err(e),
            }
        }
        LineOpDirection::Unstage => {
            match git_apply_stdin(path, &["apply", "--cached", "--recount", "-R", "-"], &built.text) {
                Ok(out) if out.ok => WorkdirResult::ok(
                    format!("Unstaged {} selected line{plural} in {file}.", built.line_count),
                    None,
                ),
                Ok(out) => WorkdirResult::err(git_msg(&out)),
                Err(e) => WorkdirResult::err(e),
            }
        }
        LineOpDirection::Discard => {
            // Destructive — ALWAYS back up first, same ordering discipline as
            // `discard_file` (see module doc comment). Whole-file backup is
            // sufficient (and simpler/safer than a selection-only backup —
            // see design §3): it's a strict superset of what's being
            // discarded, so replaying it trivially reproduces the exact
            // pre-discard state.
            let backup_patch = match backup_tracked_patch(&repo, file, true) {
                Ok(p) => p,
                Err(e) => {
                    return WorkdirResult::err(format!(
                        "Could not back up {file} before discarding, refusing: {e}"
                    ))
                }
            };
            match git_apply_stdin(path, &["apply", "--recount", "-R", "-"], &built.text) {
                Ok(out) if out.ok => WorkdirResult {
                    ok: true,
                    message: format!(
                        "Discarded {} selected line{plural} in {file} (backup: {backup_patch}).",
                        built.line_count
                    ),
                    conflicted_files: Vec::new(),
                    backup_ref: None,
                    backup_patch: Some(backup_patch),
                    dropped_stash_ref: None,
                },
                // The backup was already written even though the mutation
                // itself failed — keep pointing at it, same convention as
                // `discard_file`'s own failure arms.
                Ok(out) => WorkdirResult {
                    ok: false,
                    message: git_msg(&out),
                    conflicted_files: Vec::new(),
                    backup_ref: None,
                    backup_patch: Some(backup_patch),
                    dropped_stash_ref: None,
                },
                Err(e) => WorkdirResult {
                    ok: false,
                    message: e,
                    conflicted_files: Vec::new(),
                    backup_ref: None,
                    backup_patch: Some(backup_patch),
                    dropped_stash_ref: None,
                },
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Write: commit (snapshots first; respects commit.gpgsign via plain `git commit`)
// ---------------------------------------------------------------------------

/// Create a commit from the current index, or amend the previous one.
/// Snapshots FIRST (amend rewrites the previous commit's sha — history-
/// mutating). `!amend && message` empty/whitespace-only -> refused before any
/// snapshot. `amend && message` empty/`None` -> `--amend --no-edit` (keeps the
/// prior message). `amend && message` non-empty -> `--amend -m <message>`.
/// Otherwise -> `-m <message>`. Nothing preemptively re-checks "is anything
/// staged" — a refusal ("nothing to commit") surfaces verbatim from git.
/// JS: `invoke("commit", { path, message, amend })`.
#[tauri::command]
#[specta::specta]
pub fn commit(path: String, message: Option<String>, amend: Option<bool>) -> WorkdirResult {
    let is_amend = amend.unwrap_or(false);
    let msg = message.unwrap_or_default();
    let msg_empty = msg.trim().is_empty();

    if !is_amend && msg_empty {
        return WorkdirResult::err("Commit message is empty.");
    }

    let repo = match open_repo(&path) {
        Ok(r) => r,
        Err(w) => return w,
    };
    let backup = match crate::safety::snapshot(&repo) {
        Ok(b) => b,
        Err(e) => return WorkdirResult::err(format!("Safety snapshot failed, aborting: {e}")),
    };

    let mut args: Vec<&str> = vec!["commit"];
    if is_amend {
        args.push("--amend");
        if msg_empty {
            args.push("--no-edit");
        } else {
            args.push("-m");
            args.push(&msg);
        }
    } else {
        args.push("-m");
        args.push(&msg);
    }

    // GIT_EDITOR=true set defensively (mirrors git_merge.rs's `no_editor`)
    // even though -m/--no-edit should already avoid invoking one.
    match git(&path, &args, true) {
        Ok(out) if out.ok => WorkdirResult::ok(
            format!("{} (snapshot {}).", if is_amend { "Amended commit" } else { "Committed" }, short_backup(&backup)),
            Some(backup),
        ),
        Ok(out) => WorkdirResult::err_with_backup(git_msg(&out), Some(backup)),
        Err(e) => WorkdirResult::err_with_backup(e, Some(backup)),
    }
}

// ---------------------------------------------------------------------------
// Writes: stash (snapshots first, no exceptions)
// ---------------------------------------------------------------------------

/// `git stash push [-u] [-m <message>]`. Snapshots FIRST.
/// JS: `invoke("stash_save", { path, message, includeUntracked })`.
#[tauri::command]
#[specta::specta]
pub fn stash_save(path: String, message: Option<String>, include_untracked: Option<bool>) -> WorkdirResult {
    let repo = match open_repo(&path) {
        Ok(r) => r,
        Err(w) => return w,
    };
    let backup = match crate::safety::snapshot(&repo) {
        Ok(b) => b,
        Err(e) => return WorkdirResult::err(format!("Safety snapshot failed, aborting: {e}")),
    };

    let mut args: Vec<&str> = vec!["stash", "push"];
    if include_untracked.unwrap_or(false) {
        args.push("-u");
    }
    let has_msg = message.as_deref().map(|m| !m.trim().is_empty()).unwrap_or(false);
    if has_msg {
        args.push("-m");
        args.push(message.as_deref().unwrap());
    }

    match git(&path, &args, true) {
        Ok(out) if out.ok => {
            let blob = format!("{} {}", out.stdout, out.stderr).to_lowercase();
            if blob.contains("no local changes to save") {
                return WorkdirResult::err_with_backup(
                    "Nothing to stash — the working tree is clean.",
                    Some(backup),
                );
            }
            WorkdirResult::ok(format!("Stashed changes (snapshot {}).", short_backup(&backup)), Some(backup))
        }
        Ok(out) => WorkdirResult::err_with_backup(git_msg(&out), Some(backup)),
        Err(e) => WorkdirResult::err_with_backup(e, Some(backup)),
    }
}

/// `stash@{index}`'s CURRENT commit sha (full, untruncated), or `None` if it
/// doesn't resolve (bad index / no stash there). The single read both
/// [`check_stash_identity`] (compared against `StashEntry.sha`, which IS
/// truncated — see [`short_sha`]) and `stash_conflict_continue` (compared
/// full-length) build on.
fn current_stash_sha(path: &str, index: usize) -> Option<String> {
    let stash_ref = format!("stash@{{{index}}}");
    let out = git(path, &["rev-parse", &stash_ref], false).ok()?;
    (out.ok && !out.stdout.is_empty()).then(|| out.stdout.trim().to_string())
}

/// If the caller supplied `expected_sha` (the sha it last saw for this index
/// via `stash_list`'s `StashEntry.sha`), verify `stash@{index}` STILL
/// resolves to that same commit before mutating it. An external `git stash`
/// operation (confirmed to fire the repo-changed watcher — see `watch.rs`)
/// can silently shift what index N means out from under a stale frontend
/// list; the numeric `stash@{N}` selector alone can't detect that. `None`
/// (an older frontend build, or a caller that never fetched a list) skips the
/// check entirely — this is an additive safety net, not a required field.
fn check_stash_identity(path: &str, index: usize, expected_sha: &Option<String>) -> Result<(), String> {
    let Some(expected) = expected_sha.as_deref().filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    match current_stash_sha(path, index) {
        Some(actual) if short_sha(&actual) == expected => Ok(()),
        Some(actual) => Err(format!(
            "stash@{{{index}}} has changed since you last looked (was {expected}, now {}) — refresh the stash list and try again.",
            short_sha(&actual)
        )),
        None => Err(format!(
            "stash@{{{index}}} no longer exists — refresh the stash list and try again."
        )),
    }
}

/// `<git-dir>/gitgui/stash-conflict.json` — persists what
/// [`stash_conflict_abort`]/[`stash_conflict_continue`] need to finalize a
/// stash-apply/pop conflict, since (unlike merge/rebase/cherry-pick) git
/// itself leaves no in-progress marker to read back (see module doc comment).
/// A plain single JSON object, not JSONL like `oplog.jsonl`: there is only
/// ever ONE unresolved stash conflict at a time (`apply_or_pop` now refuses a
/// second attempt while one is outstanding — see its own body).
#[derive(Serialize, Deserialize)]
struct StashConflictState {
    backup_ref: String, // pre-apply/pop safety snapshot; Abort resets --hard here
    pop: bool,          // true = this was stash_pop (Continue must drop on success)
    index: usize,       // stash@{index} at the moment of the attempt
    stash_sha: String,  // that stash's full sha then, so Continue can re-verify identity
}

fn stash_conflict_state_path(repo: &Repository) -> std::path::PathBuf {
    repo.path().join("gitgui").join("stash-conflict.json")
}

/// Best-effort write: losing this sidecar would only degrade Abort/Continue's
/// UX (the conflict itself is still resolvable by hand), never lose data.
fn write_stash_conflict_state(repo: &Repository, st: &StashConflictState) {
    let p = stash_conflict_state_path(repo);
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string(st) {
        let _ = fs::write(p, s);
    }
}

fn read_stash_conflict_state(repo: &Repository) -> Option<StashConflictState> {
    let data = fs::read_to_string(stash_conflict_state_path(repo)).ok()?;
    serde_json::from_str(&data).ok()
}

/// `pub(crate)`: also called from `git_merge::merge_squash` to clear a stale
/// leftover of THIS sidecar before it starts (see that function's own
/// comment, and `conflict.rs::detect_op`'s doc comment on the misattribution
/// bug this closes).
pub(crate) fn clear_stash_conflict_state(repo: &Repository) {
    let _ = fs::remove_file(stash_conflict_state_path(repo));
}

/// Shared body for `stash_apply`/`stash_pop`: refuse on top of any in-progress
/// sequencer op OR an already-unresolved stash conflict (see below), verify
/// stash identity if the caller supplied one, snapshot, run
/// `git stash apply|pop stash@{N}`, and on failure re-classify via
/// `unmerged_files` exactly like `git_merge::classify` does — a real conflict
/// is `conflicted_files` non-empty + `ok:false`, NOT a hard error, so the
/// frontend opens the Resolver instead of just showing a toast.
fn apply_or_pop(path: &str, index: usize, pop: bool, expected_sha: Option<String>) -> WorkdirResult {
    let repo = match open_repo(path) {
        Ok(r) => r,
        Err(w) => return w,
    };
    if in_progress(&repo) {
        return WorkdirResult::err(
            "Another operation (merge/rebase/cherry-pick) is already in progress — resolve or abort it first.",
        );
    }
    // `in_progress` only reads `RepositoryState`, which stays Clean for a
    // stash conflict (see module doc comment) — check unmerged paths
    // directly too, so a second apply/pop can't be run on top of one that's
    // still unresolved.
    if !unmerged_files(path).is_empty() {
        return WorkdirResult::err(
            "There are unresolved conflicts from a previous stash apply/pop — resolve or abort them first.",
        );
    }
    // See git_merge::merge_squash's identical cleanup for the full
    // rationale: unmerged_files() being empty here proves any PRIOR
    // conflict (of either kind) is genuinely concluded, so any sidecar still
    // on disk at this point must be stale (left behind by an out-of-band
    // resolution) — clearing both here closes an adversarially-found
    // misattribution bug in conflict.rs::detect_op.
    clear_stash_conflict_state(&repo);
    crate::git_merge::clear_merge_squash_conflict_state(&repo);
    if let Err(e) = check_stash_identity(path, index, &expected_sha) {
        return WorkdirResult::err(e);
    }

    let stash_ref = format!("stash@{{{index}}}");
    // Resolve the stash's own sha NOW (before it can possibly change), so a
    // later `stash_conflict_continue` can re-verify identity before dropping
    // it on a successful pop.
    let stash_sha = current_stash_sha(path, index).unwrap_or_default();

    let backup = match crate::safety::snapshot(&repo) {
        Ok(b) => b,
        Err(e) => return WorkdirResult::err(format!("Safety snapshot failed, aborting: {e}")),
    };

    let verb = if pop { "pop" } else { "apply" };
    let out = match git(path, &["stash", verb, &stash_ref], false) {
        Ok(o) => o,
        Err(e) => return WorkdirResult::err_with_backup(e, Some(backup)),
    };

    if out.ok {
        clear_stash_conflict_state(&repo); // best-effort: clear any stale entry
        let action = if pop { "Popped" } else { "Applied" };
        return WorkdirResult::ok(
            format!("{action} {stash_ref} (snapshot {}).", short_backup(&backup)),
            Some(backup),
        );
    }

    let conflicts = unmerged_files(path);
    if !conflicts.is_empty() {
        // Persist what Abort/Continue need — see this module's doc comment on
        // why (RepositoryState stays Clean; there is no git-native marker).
        write_stash_conflict_state(
            &repo,
            &StashConflictState { backup_ref: backup.clone(), pop, index, stash_sha },
        );
        let n = conflicts.len();
        let verb_label = if pop { "Pop of" } else { "Apply of" };
        return WorkdirResult {
            ok: false,
            message: format!(
                "{verb_label} {stash_ref} hit a conflict in {n} file{}. Resolve them in the Resolver, then Continue — or Abort. The stash entry is kept.",
                if n == 1 { "" } else { "s" }
            ),
            conflicted_files: conflicts,
            backup_ref: Some(backup),
            backup_patch: None,
            dropped_stash_ref: None,
        };
    }

    WorkdirResult::err_with_backup(git_msg(&out), Some(backup))
}

/// `git stash apply stash@{index}`. On a conflict, git never drops the stash
/// entry — `stash_list` will still show it. `expected_sha` is an OPTIONAL
/// sanity check (see [`check_stash_identity`]): pass the `StashEntry.sha`
/// last fetched for this index, and the op refuses instead of silently
/// acting on a different entry if the stash list changed since (e.g. an
/// external `git stash` command). JS: `invoke("stash_apply", { path, index,
/// expectedSha })`.
#[tauri::command]
#[specta::specta]
pub fn stash_apply(path: String, index: usize, expected_sha: Option<String>) -> WorkdirResult {
    apply_or_pop(&path, index, false, expected_sha)
}

/// `git stash pop stash@{index}`. On a conflict, git leaves the stash entry in
/// place (only a clean pop drops it). `expected_sha`: see [`stash_apply`].
/// JS: `invoke("stash_pop", { path, index, expectedSha })`.
#[tauri::command]
#[specta::specta]
pub fn stash_pop(path: String, index: usize, expected_sha: Option<String>) -> WorkdirResult {
    apply_or_pop(&path, index, true, expected_sha)
}

/// Pin a dropped stash's own commit under a dedicated ref namespace
/// (`refs/gitgui/dropped-stash/<secs>-<nanos>-<seq>`) BEFORE `git stash drop`
/// ever runs — mirrors `safety::pin_deleted_tip`'s exact mechanism (pin an
/// oid about to become unreachable under `refs/gitgui/*` so it survives
/// `git gc`) but under its own namespace, since a dropped STASH is not a
/// deleted BRANCH tip and must never be confused with one. `safety::snapshot`
/// (the `backup_ref` every stash op already takes) only ever tracks
/// `refs/heads/*` — never `refs/stash` — so it can never make a dropped
/// stash itself recoverable; this pin is what actually does. Returns the
/// pinned ref name, or `Err` if the stash's sha can't even be resolved (in
/// which case `stash_drop` refuses to drop it at all, rather than mutate
/// without ever having backed it up).
fn pin_dropped_stash(repo: &Repository, path: &str, stash_ref: &str) -> Result<String, String> {
    let out = git(path, &["rev-parse", stash_ref], false)?;
    if !out.ok || out.stdout.is_empty() {
        return Err(format!("Could not resolve {stash_ref}: {}", git_msg(&out)));
    }
    let oid = git2::Oid::from_str(out.stdout.trim())
        .map_err(|e| format!("Could not parse {stash_ref}'s sha: {}", e.message()))?;

    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let seq = STASH_SEQ.fetch_add(1, Ordering::SeqCst);
    let ref_name = format!("refs/gitgui/dropped-stash/{}-{}-{}", now.as_secs(), now.subsec_nanos(), seq);
    repo.reference(&ref_name, oid, false, "gitcat pre-drop stash backup")
        .map_err(|e| format!("Could not pin dropped stash: {}", e.message()))?;
    Ok(ref_name)
}

/// `git stash drop stash@{index}`. Snapshots HEAD first like every other
/// stash op (see doc comment), but — unlike that HEAD snapshot — a stash
/// drop's own content is NOT reachable through `safety::undo()`/global Undo
/// at all (`snapshot()` only ever tracks `refs/heads/*`, never `refs/stash`),
/// so this pins the STASH's own commit under a dedicated ref
/// ([`pin_dropped_stash`]) BEFORE ever running `git stash drop`, and reports
/// that pin honestly in `dropped_stash_ref`/`message` instead of implying
/// the generic Undo button restores it. `expected_sha`: see [`stash_apply`].
/// JS: `invoke("stash_drop", { path, index, expectedSha })`.
#[tauri::command]
#[specta::specta]
pub fn stash_drop(path: String, index: usize, expected_sha: Option<String>) -> WorkdirResult {
    let repo = match open_repo(&path) {
        Ok(r) => r,
        Err(w) => return w,
    };
    if let Err(e) = check_stash_identity(&path, index, &expected_sha) {
        return WorkdirResult::err(e);
    }
    let backup = match crate::safety::snapshot(&repo) {
        Ok(b) => b,
        Err(e) => return WorkdirResult::err(format!("Safety snapshot failed, aborting: {e}")),
    };

    let stash_ref = format!("stash@{{{index}}}");

    // Back up the STASH's own content BEFORE dropping it — see doc comment.
    // Refuse (never drop unbacked-up) if we can't even pin it.
    let stash_pin = match pin_dropped_stash(&repo, &path, &stash_ref) {
        Ok(r) => r,
        Err(e) => {
            return WorkdirResult::err_with_backup(
                format!("Refusing to drop {stash_ref} — could not back it up first: {e}"),
                Some(backup),
            )
        }
    };

    match git(&path, &["stash", "drop", &stash_ref], false) {
        Ok(out) if out.ok => WorkdirResult {
            ok: true,
            message: format!(
                "Dropped {stash_ref} (HEAD snapshot {}). Its content is pinned and recoverable — \
                 NOT via the global Undo (that only rewinds HEAD/branches, which a stash drop never \
                 touches): run `git stash apply {stash_pin}` to get it back.",
                short_backup(&backup)
            ),
            conflicted_files: Vec::new(),
            backup_ref: Some(backup),
            backup_patch: None,
            dropped_stash_ref: Some(stash_pin),
        },
        Ok(out) => WorkdirResult::err_with_backup(git_msg(&out), Some(backup)),
        Err(e) => WorkdirResult::err_with_backup(e, Some(backup)),
    }
}

// ---------------------------------------------------------------------------
// Write: stash-conflict Abort/Continue (the "stash" resolver op — see module
// doc comment for why this exists as its own pair rather than reusing
// merge/rebase's MERGE_HEAD-based abort/continue)
// ---------------------------------------------------------------------------

/// Result of a stash-conflict finalize step (`stash_conflict_abort` /
/// `stash_conflict_continue`). Deliberately the SAME shape as
/// `MergeResult`/`RebaseResult` (see `git_merge.rs`'s doc comment for why each
/// op module gets its own type rather than sharing one across module
/// boundaries): the shared Resolver's `OPS`/dispatch table treats every op's
/// result structurally (`.state`/`.conflictedFiles`/`.message`/`.backupRef`),
/// so a "stash" entry with this shape slots in exactly like the others.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StashResolveResult {
    pub ok: bool,
    /// "clean" | "conflict" | "error" (never "empty" — finalizing a stash
    /// conflict is never a no-op).
    pub state: String,
    pub conflicted_files: Vec<String>,
    pub message: String,
    pub backup_ref: Option<String>,
}

impl StashResolveResult {
    fn error(message: impl Into<String>) -> Self {
        Self { ok: false, state: "error".into(), conflicted_files: Vec::new(), message: message.into(), backup_ref: None }
    }
}

/// Abort a stash-apply/pop conflict left by `apply_or_pop`. `git stash
/// apply`/`pop` has no native `--abort` of its own (unlike merge/rebase/
/// cherry-pick), so this uses the mechanism the finding calls for: reset the
/// working tree AND index back to the pre-attempt state via the safety
/// snapshot's own backup ref (`git reset --hard <backup_ref>`) sealed by
/// `apply_or_pop` right before it ran. The stash entry itself is UNTOUCHED
/// either way (apply never removes it; a conflicted pop never drops it
/// either — empirically verified, see module doc comment), so nothing about
/// the stash list changes. CAVEAT (documented, not hidden): `backup_ref` only
/// ever pins HEAD's COMMIT, not the working tree — if the tree already had
/// OTHER uncommitted changes before this apply/pop was attempted, this reset
/// discards those too, same limitation `safety::undo()`'s own dirty-tree
/// guard exists to avoid elsewhere; there is no git-level way around that for
/// an op that (unlike merge/rebase) is explicitly designed to run on top of a
/// dirty tree.
/// JS: `invoke("stash_conflict_abort", { path })`.
#[tauri::command]
#[specta::specta]
pub fn stash_conflict_abort(path: String) -> StashResolveResult {
    let repo = match Repository::open(&path) {
        Ok(r) => r,
        Err(e) => return StashResolveResult::error(format!("Cannot open repository: {}", e.message())),
    };
    let Some(state) = read_stash_conflict_state(&repo) else {
        return StashResolveResult::error("No stash conflict in progress to abort.");
    };

    let target_sha = match git(&path, &["rev-parse", &state.backup_ref], false) {
        Ok(o) if o.ok && !o.stdout.is_empty() => o.stdout.trim().to_string(),
        Ok(o) => {
            return StashResolveResult::error(format!(
                "Could not resolve the pre-conflict snapshot {}: {}",
                state.backup_ref,
                git_msg(&o)
            ))
        }
        Err(e) => return StashResolveResult::error(e),
    };

    match git(&path, &["reset", "--hard", &target_sha], false) {
        Ok(out) if out.ok => {
            clear_stash_conflict_state(&repo);
            StashResolveResult {
                ok: true,
                state: "clean".into(),
                conflicted_files: Vec::new(),
                message: format!(
                    "Stash conflict aborted — working tree restored to the pre-{} state (snapshot {}). The stash entry is untouched.",
                    if state.pop { "pop" } else { "apply" },
                    short_backup(&state.backup_ref),
                ),
                backup_ref: None,
            }
        }
        Ok(out) => StashResolveResult::error(git_msg(&out)),
        Err(e) => StashResolveResult::error(e),
    }
}

/// Finish a stash-apply/pop conflict after the user resolved every file (via
/// the shared Resolver's per-file `resolve_conflict_file`, allowlisted for
/// `"stash"` — see `conflict.rs`) and staged the result. Refuses (reporting
/// `state:"conflict"` again, same convention as `git_merge::classify`/
/// `git_rebase`'s classify) if unmerged paths remain. For `apply`, nothing
/// further is needed — the stash entry was never touched. For `pop`, the
/// whole point of popping was to remove the stash entry, but a CONFLICTED
/// pop never drops it (empirically verified, see module doc comment) — so
/// only NOW, once the user has actually kept the resolution, do we drop it,
/// re-verifying its identity first (in case the stash list changed during
/// the conflict) rather than blindly dropping whatever now sits at that
/// index.
/// JS: `invoke("stash_conflict_continue", { path })`.
#[tauri::command]
#[specta::specta]
pub fn stash_conflict_continue(path: String) -> StashResolveResult {
    let repo = match Repository::open(&path) {
        Ok(r) => r,
        Err(e) => return StashResolveResult::error(format!("Cannot open repository: {}", e.message())),
    };
    let Some(state) = read_stash_conflict_state(&repo) else {
        return StashResolveResult::error("No stash conflict in progress to continue.");
    };

    let remaining = unmerged_files(&path);
    if !remaining.is_empty() {
        let n = remaining.len();
        return StashResolveResult {
            ok: false,
            state: "conflict".into(),
            conflicted_files: remaining,
            message: format!(
                "Still conflicted in {n} file{}. Resolve them, then Continue — or Abort.",
                if n == 1 { "" } else { "s" }
            ),
            backup_ref: Some(state.backup_ref.clone()),
        };
    }

    if state.pop {
        let still_same = current_stash_sha(&path, state.index).as_deref() == Some(state.stash_sha.as_str());
        if !still_same {
            clear_stash_conflict_state(&repo);
            return StashResolveResult {
                ok: true,
                state: "clean".into(),
                conflicted_files: Vec::new(),
                message: format!(
                    "Conflict resolved. NOTE: stash@{{{}}} no longer matches the popped entry (the stash list changed during the conflict), so it was left AS-IS rather than risk dropping the wrong one — check the stash list.",
                    state.index
                ),
                backup_ref: None,
            };
        }
        let stash_ref = format!("stash@{{{}}}", state.index);
        if let Err(msg) = match git(&path, &["stash", "drop", &stash_ref], false) {
            Ok(out) if out.ok => Ok(()),
            Ok(out) => Err(format!(
                "Conflict resolved, but could not drop the popped stash entry: {}",
                git_msg(&out)
            )),
            Err(e) => Err(format!("Conflict resolved, but could not drop the popped stash entry: {e}")),
        } {
            return StashResolveResult { ok: false, state: "error".into(), conflicted_files: Vec::new(), message: msg, backup_ref: None };
        }
    }

    clear_stash_conflict_state(&repo);
    StashResolveResult {
        ok: true,
        state: "clean".into(),
        conflicted_files: Vec::new(),
        message: if state.pop {
            "Stash pop conflict resolved — the popped stash entry has been dropped.".into()
        } else {
            "Stash apply conflict resolved. The applied stash entry is untouched (apply never removes it) — drop it yourself from the stash list if you're done with it.".into()
        },
        backup_ref: None,
    }
}

// ---------------------------------------------------------------------------
// Write: stash-apply/pop Undo (dedicated path — see module doc comment for
// why `safety::undo()`'s generic dirty-tree guard can never fire right after
// these two ops, and why this is additive rather than a change to that guard)
// ---------------------------------------------------------------------------

/// Undo a `stash_apply`/`stash_pop` by re-stashing whatever is now dirty,
/// restoring a clean working tree via a real `git stash push -u`. Wired into
/// the global Undo (⌘Z) flow by the frontend specifically for these two ops
/// (the frontend knows locally which mutation just ran; see the workdir
/// controller) — NOT a change to `safety::undo()`'s own dirty-tree guard,
/// which keeps refusing on every OTHER kind of dirty state exactly as
/// before.
///
/// HONEST about what this does and doesn't restore: nothing at the ref level
/// (HEAD/branches) ever moved, so there is nothing to rewind there. This is
/// NOT a byte-for-byte replay of the exact stash that was applied/popped —
/// apply's original entry is left untouched (this push creates an ADDITIONAL
/// entry alongside it); pop's original entry was already dropped on a clean
/// pop (this push recreates its CONTENT under a brand-new stash commit/
/// timestamp, not the same object). The practical guarantee is the same one
/// Undo makes everywhere else: the working tree ends up clean again and
/// nothing is lost. Refuses if conflicted paths remain from a stash conflict
/// — that is `stash_conflict_abort`/`stash_conflict_continue`'s job (a stash
/// conflict is never a "just re-stash it" situation).
/// JS: `invoke("stash_undo_apply", { path })`.
#[tauri::command]
#[specta::specta]
pub fn stash_undo_apply(path: String) -> WorkdirResult {
    let repo = match open_repo(&path) {
        Ok(r) => r,
        Err(w) => return w,
    };
    if !unmerged_files(&path).is_empty() {
        return WorkdirResult::err(
            "There are unresolved conflicts from a stash apply/pop — resolve them via the Resolver (Continue/Abort) instead of Undo.",
        );
    }
    let dirty = match git(&path, &["status", "--porcelain"], false) {
        Ok(o) if o.ok => o.stdout,
        Ok(o) => return WorkdirResult::err(git_msg(&o)),
        Err(e) => return WorkdirResult::err(e),
    };
    if dirty.is_empty() {
        return WorkdirResult::err("Working tree is already clean — nothing to undo.");
    }

    let backup = match crate::safety::snapshot(&repo) {
        Ok(b) => b,
        Err(e) => return WorkdirResult::err(format!("Safety snapshot failed, aborting: {e}")),
    };

    match git(
        &path,
        &["stash", "push", "-u", "-m", "gitcat undo: re-stash after stash apply/pop"],
        true,
    ) {
        Ok(out) if out.ok => WorkdirResult::ok(
            format!(
                "Undid the stash apply/pop by re-stashing the working tree (snapshot {}). This created a NEW stash entry — it's the same content, not the original object, but nothing is lost.",
                short_backup(&backup)
            ),
            Some(backup),
        ),
        Ok(out) => WorkdirResult::err_with_backup(git_msg(&out), Some(backup)),
        Err(e) => WorkdirResult::err_with_backup(e, Some(backup)),
    }
}
