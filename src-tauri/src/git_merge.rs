//! Merge: drag-a-commit/branch-tip-onto-HEAD, with a real conflict path.
//!
//! Mirrors git_pick.rs's model exactly (read that module's doc comment first):
//! every mutation SNAPSHOTS first (Safety Manager), then shells out to the git
//! CLI — libgit2's merge can diverge from the porcelain, and the CLI owns the
//! in-progress state (MERGE_HEAD, conflict markers, `--continue`/`--abort`).
//! git2 is used only to open the repo, read HEAD's identity, and locate the
//! git dir for MERGE_HEAD.
//!
//! Semantics: `git merge <sha>` merges <sha> INTO the current branch (HEAD).
//! For the drag gesture the SOURCE (dragged) commit/branch-tip is <sha>; the
//! drop target is always (conceptually) HEAD, exactly like cherry-pick.
//!
//! State machine returned to the UI (`MergeResult.state`):
//!   "clean"    — the merge completed (a new merge commit, or a fast-forward)
//!                and HEAD moved; working tree clean.
//!   "conflict" — a real merge conflict; `conflicted_files` is non-empty and
//!                the repo is mid-merge (MERGE_HEAD present). The UI opens the
//!                resolver, then calls `merge_continue` or `merge_abort`.
//!   "empty"    — HEAD is already up to date with <sha> (nothing to merge); a
//!                benign no-op, nothing was mutated.
//!   "error"    — anything else (dirty-tree refusal, bad revision, …);
//!                `message` carries git's own stderr. No in-progress state is
//!                left behind.
//!
//! Failure model (like git_pick / git_write): commands return a plain
//! [`MergeResult`], never a Rust `Err`, so the JS promise always resolves.
//!
//! Why a dedicated `MergeResult` rather than reusing `PickResult`: the field
//! shape is identical today, but the project's convention (see `ResolveResult`
//! next to `PickResult` in conflict.rs/git_pick.rs) is one result type per
//! operation module — it keeps each module's public API self-describing in
//! the generated TS bindings (`MergeResult` reads as merge's own contract, not
//! a borrowed cherry-pick type), and leaves room for the two shapes to diverge
//! later (e.g. a merge-specific field) without a breaking rename.

use std::process::Command;

use git2::Repository;
use serde::Serialize;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/// Result of any merge step (initial / continue / abort). Serializes
/// camelCase: `conflictedFiles`, `backupRef`.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub ok: bool,
    /// "clean" | "conflict" | "empty" | "error"
    pub state: String,
    /// Repo-relative paths with unmerged entries — non-empty only when
    /// `state == "conflict"`.
    pub conflicted_files: Vec<String>,
    pub message: String,
    /// Pre-op safety snapshot ref (present when we snapshotted before mutating),
    /// so the UI can name the snapshot the user can Undo to.
    pub backup_ref: Option<String>,
}

impl MergeResult {
    fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            state: "error".into(),
            conflicted_files: Vec::new(),
            message: message.into(),
            backup_ref: None,
        }
    }
}

// ---------------------------------------------------------------------------
// git CLI runner (own copy so we can set the editor env — see `no_editor`)
// ---------------------------------------------------------------------------

/// One git CLI invocation's captured result.
struct Out {
    ok: bool,
    code: i32,
    stdout: String,
    stderr: String,
}

/// Run `git -C <path> <args…>`. When `no_editor` is set, force a no-op
/// commit-message editor (`true` exits 0 immediately) via `GIT_EDITOR`, so any
/// step that would otherwise open `$EDITOR` — the merge's auto-commit, or
/// `--continue` — proceeds non-interactively and keeps the prepared message
/// (otherwise a headless app would hang). Returns `Err` only if git can't spawn.
fn git(path: &str, args: &[&str], no_editor: bool) -> Result<Out, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path).args(args);
    if no_editor {
        cmd.env("GIT_EDITOR", "true")
            .env("GIT_SEQUENCE_EDITOR", "true");
    }
    let o = cmd
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Reject a revision that could be read as a flag or carries control chars.
/// `--end-of-options` at the CLI boundary is the real guard; this just yields a
/// clean message instead of git's "unknown revision".
fn validate_sha(sha: &str) -> Result<(), String> {
    if sha.is_empty() {
        return Err("No commit to merge.".into());
    }
    if sha.starts_with('-') {
        return Err(format!("Refusing a revision that looks like a flag: {sha:?}"));
    }
    if sha.chars().any(|c| c.is_control()) {
        return Err("Revision has a control character.".into());
    }
    Ok(())
}

/// Repo-relative unmerged (conflicted) paths, via the porcelain idiom
/// `git diff --name-only --diff-filter=U`. Empty when there are none (or on any
/// unexpected failure — the caller treats "no conflicts" conservatively).
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

/// True while a merge is in progress: git keeps MERGE_HEAD in the git dir
/// until the merge is committed/aborted. `repo.path()` is the git dir, so this
/// is correct for worktrees and non-standard layouts too.
fn in_progress(repo: &Repository) -> bool {
    repo.path().join("MERGE_HEAD").exists()
}

/// Current branch shorthand for friendlier messages ("into main"), else "HEAD".
fn head_name(repo: &Repository) -> String {
    match repo.head() {
        Ok(h) if h.is_branch() => h.shorthand().unwrap_or("HEAD").to_string(),
        _ => "HEAD".to_string(),
    }
}

/// Compact tail of a backup ref, e.g. ".../1720000000-42-3" -> "1720000000-42-3".
fn short_backup(r: &str) -> String {
    r.rsplit('/').next().unwrap_or(r).to_string()
}

/// Turn a finished `merge` / `--continue` run into a [`MergeResult`] by
/// inspecting the resulting REPO STATE (not by scraping git's prose, except
/// for the one benign "nothing happened" case git only reports via message
/// text: "Already up to date."). `label` is a display name for the merged-in
/// commit/branch; `backup` is the pre-op snapshot ref (None when we couldn't/
/// didn't snapshot).
fn classify(
    repo: &Repository,
    path: &str,
    out: &Out,
    backup: Option<String>,
    label: &str,
) -> MergeResult {
    let snap_note = backup
        .as_deref()
        .map(|b| format!(" (snapshot {})", short_backup(b)))
        .unwrap_or_default();

    if out.ok {
        // Verified on git 2.53.0: a no-op merge (HEAD already contains <sha>)
        // exits 0 and prints exactly "Already up to date." — nothing is
        // mutated (no commit, no ref move). Report it as a benign no-op
        // (parity with cherry-pick's "empty"), not "clean" (which implies a
        // real merge commit or fast-forward happened).
        let blob = format!("{} {}", out.stdout, out.stderr).to_lowercase();
        if blob.contains("already up to date") || blob.contains("already up-to-date") {
            return MergeResult {
                ok: false,
                state: "empty".into(),
                conflicted_files: Vec::new(),
                message: format!(
                    "{label} is already up to date with {} — nothing to merge.",
                    head_name(repo)
                ),
                backup_ref: backup,
            };
        }
        return MergeResult {
            ok: true,
            state: "clean".into(),
            conflicted_files: Vec::new(),
            message: format!("Merged {label} into {}{snap_note}.", head_name(repo)),
            backup_ref: backup,
        };
    }

    // A real conflict: the index has unmerged entries.
    let conflicts = unmerged_files(path);
    if !conflicts.is_empty() {
        let n = conflicts.len();
        return MergeResult {
            ok: false,
            state: "conflict".into(),
            conflicted_files: conflicts,
            message: format!(
                "Merge of {label} hit a conflict in {n} file{}. Resolve them, then Continue — or Abort.",
                if n == 1 { "" } else { "s" }
            ),
            backup_ref: backup,
        };
    }

    // No unmerged files. If MERGE_HEAD is still present, the merge itself
    // resolved cleanly but the concluding commit could not be created (hook
    // rejection, gpg-sign failure, …). We must NEVER auto-abort + mislabel
    // this as a clean result (it would silently discard the merge outcome),
    // and must NEVER return "error" while mid-merge (the UI's error path
    // doesn't open the resolver -> orphaned MERGE_HEAD with no Abort button).
    if in_progress(repo) {
        return MergeResult {
            ok: false,
            state: "conflict".into(),
            conflicted_files: Vec::new(),
            message: format!(
                "Merge of {label} could not finish: {}. Continue to retry, or Abort.",
                git_msg(out)
            ),
            backup_ref: backup,
        };
    }

    // Not mid-merge (dirty-tree refusal, bad revision, merge already in
    // progress refused by git itself, …): surface git verbatim. Never forced.
    MergeResult {
        ok: false,
        state: "error".into(),
        conflicted_files: Vec::new(),
        message: git_msg(out),
        backup_ref: backup,
    }
}

// ---------------------------------------------------------------------------
// Tauri commands (registered in lib.rs)
// ---------------------------------------------------------------------------

/// Merge `sha` into the current branch (HEAD). Snapshots FIRST, then runs
/// `git merge --no-edit --end-of-options <sha>`.
///
/// A dirty working tree makes git refuse the merge — that surfaces as
/// `state:"error"` with git's own message; we never force. On a conflict this
/// resolves to `state:"conflict"` (repo left mid-merge for the resolver), NOT
/// a failure.
///
/// JS: `invoke("merge_start", { path, sha })`.
#[tauri::command]
#[specta::specta]
pub fn merge_start(path: String, sha: String) -> MergeResult {
    if let Err(e) = validate_sha(&sha) {
        return MergeResult::error(e);
    }
    let repo = match Repository::open(&path) {
        Ok(r) => r,
        Err(e) => return MergeResult::error(format!("Cannot open repository: {}", e.message())),
    };

    // Refuse to stack a new merge on top of an unfinished one.
    if in_progress(&repo) {
        return MergeResult::error("A merge is already in progress — resolve or abort it first.");
    }

    // Snapshot FIRST — never mutate without a pre-op backup. If it fails, abort.
    let backup = match crate::safety::snapshot(&repo) {
        Ok(b) => b,
        Err(e) => return MergeResult::error(format!("Safety snapshot failed, aborting: {e}")),
    };

    // git merge --no-edit --end-of-options <sha>
    let args: Vec<&str> = vec!["merge", "--no-edit", "--end-of-options", &sha];

    let out = match git(&path, &args, true) {
        Ok(o) => o,
        Err(e) => {
            return MergeResult {
                ok: false,
                state: "error".into(),
                conflicted_files: Vec::new(),
                message: e,
                backup_ref: Some(backup),
            }
        }
    };

    classify(&repo, &path, &out, Some(backup), &sha)
}

/// Continue an in-progress merge after the user resolved the conflict (files
/// were `git add`ed by the resolver). Runs `git merge --continue` with
/// `GIT_EDITOR=true` so it commits the resolution non-interactively.
///
/// Re-classifies the outcome: `clean` on success, `conflict` again if
/// conflicts remain unresolved.
///
/// JS: `invoke("merge_continue", { path })`.
#[tauri::command]
#[specta::specta]
pub fn merge_continue(path: String) -> MergeResult {
    let repo = match Repository::open(&path) {
        Ok(r) => r,
        Err(e) => return MergeResult::error(format!("Cannot open repository: {}", e.message())),
    };
    if !in_progress(&repo) {
        return MergeResult::error("No merge in progress to continue.");
    }

    // Name the commit being merged in (for messages) while MERGE_HEAD exists.
    let label = git(&path, &["rev-parse", "--short", "MERGE_HEAD"], false)
        .ok()
        .filter(|o| o.ok)
        .map(|o| o.stdout)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "the commit".to_string());

    // Snapshot the pre-commit state (HEAD is still the pre-merge commit during
    // a conflict). Best-effort: continue must remain possible even if it can't
    // run.
    let backup = crate::safety::snapshot(&repo).ok();

    let out = match git(&path, &["merge", "--continue"], true) {
        Ok(o) => o,
        Err(e) => {
            return MergeResult {
                ok: false,
                state: "error".into(),
                conflicted_files: Vec::new(),
                message: e,
                backup_ref: backup,
            }
        }
    };

    classify(&repo, &path, &out, backup, &label)
}

/// Abort an in-progress merge: `git merge --abort` restores the pre-merge
/// state. This is the escape hatch — it must ALWAYS be able to run, so it
/// deliberately does NOT take a snapshot (a snapshot failure must never block
/// the user's way out). Idempotent: "nothing in progress" is a benign success.
///
/// JS: `invoke("merge_abort", { path })`.
#[tauri::command]
#[specta::specta]
pub fn merge_abort(path: String) -> MergeResult {
    let repo = match Repository::open(&path) {
        Ok(r) => r,
        Err(e) => return MergeResult::error(format!("Cannot open repository: {}", e.message())),
    };
    if !in_progress(&repo) {
        return MergeResult {
            ok: true,
            state: "clean".into(),
            conflicted_files: Vec::new(),
            message: "No merge in progress.".into(),
            backup_ref: None,
        };
    }
    match git(&path, &["merge", "--abort"], false) {
        Ok(o) if o.ok => MergeResult {
            ok: true,
            state: "clean".into(),
            conflicted_files: Vec::new(),
            message: "Merge aborted — back to the pre-merge state.".into(),
            backup_ref: None,
        },
        Ok(o) => MergeResult::error(git_msg(&o)),
        Err(e) => MergeResult::error(e),
    }
}
