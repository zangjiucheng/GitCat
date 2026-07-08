//! Cherry-pick: drag-a-commit-onto-HEAD, with a real conflict path.
//!
//! Mirrors git_write.rs's model: every mutation SNAPSHOTS first (Safety
//! Manager), then shells out to the git CLI — libgit2's cherry-pick can diverge
//! from the porcelain, and the CLI owns the sequencer state (CHERRY_PICK_HEAD,
//! the conflict markers, `--continue`/`--abort`). git2 is used only to open the
//! repo, read HEAD's identity, and locate the git dir for CHERRY_PICK_HEAD.
//!
//! Semantics: `git cherry-pick <sha>` applies <sha>'s patch onto the CURRENT
//! branch (HEAD). For the drag gesture the SOURCE (dragged) commit is <sha>.
//!
//! State machine returned to the UI (`PickResult.state`):
//!   "clean"    — the pick committed onto HEAD; working tree clean.
//!   "conflict" — a real merge conflict; `conflicted_files` is non-empty and the
//!                repo is mid-cherry-pick. The UI opens the resolver, then calls
//!                `cherry_pick_continue` or `cherry_pick_abort`.
//!   "empty"    — the commit's changes are already present (nothing to apply); we
//!                tidy the sequencer (`--abort`) and report it as a benign no-op.
//!   "error"    — anything else (dirty-tree refusal, bad revision, …); `message`
//!                carries git's own stderr. No sequencer state is left behind.
//!
//! Failure model (like git_write): commands return a plain [`PickResult`], never
//! a Rust `Err`, so the JS promise always resolves.

use std::process::Command;

use git2::Repository;
use serde::Serialize;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/// Result of any cherry-pick step (initial / continue / abort). Serializes
/// camelCase: `conflictedFiles`, `backupRef`.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PickResult {
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

impl PickResult {
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
/// step that would otherwise open `$EDITOR` — cherry-pick's commit, or
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
        return Err("No commit to cherry-pick.".into());
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

/// True while a cherry-pick is in progress: the sequencer keeps CHERRY_PICK_HEAD
/// in the git dir until the pick is committed/aborted. `repo.path()` is the git
/// dir, so this is correct for worktrees and non-standard layouts too.
fn in_progress(repo: &Repository) -> bool {
    repo.path().join("CHERRY_PICK_HEAD").exists()
}

/// Current branch shorthand for friendlier messages ("onto main"), else "HEAD".
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

/// Turn a finished `cherry-pick` / `--continue` run into a [`PickResult`] by
/// inspecting the resulting REPO STATE (not by scraping git's prose). `label` is
/// a display name for the applied commit; `backup` is the pre-op snapshot ref
/// (None when we couldn't/ didn't snapshot).
fn classify(
    repo: &Repository,
    path: &str,
    out: &Out,
    backup: Option<String>,
    label: &str,
) -> PickResult {
    let snap_note = backup
        .as_deref()
        .map(|b| format!(" (snapshot {})", short_backup(b)))
        .unwrap_or_default();

    if out.ok {
        return PickResult {
            ok: true,
            state: "clean".into(),
            conflicted_files: Vec::new(),
            message: format!("Cherry-picked {label} onto {}{snap_note}.", head_name(repo)),
            backup_ref: backup,
        };
    }

    // A real conflict: the index has unmerged entries.
    let conflicts = unmerged_files(path);
    if !conflicts.is_empty() {
        let n = conflicts.len();
        return PickResult {
            ok: false,
            state: "conflict".into(),
            conflicted_files: conflicts,
            message: format!(
                "Cherry-pick of {label} hit a conflict in {n} file{}. Resolve them, then Continue — or Abort.",
                if n == 1 { "" } else { "s" }
            ),
            backup_ref: backup,
        };
    }

    // No unmerged files. If the sequencer is still active, distinguish an
    // already-applied / empty patch (git SAYS so) from a commit that could not be
    // created for another reason (rejecting pre-commit/commit-msg hook, gpg-sign
    // failure, or a rerere auto-resolution awaiting Continue). Verified on git
    // 2.53.0: the empty case prints "now empty" AND "nothing to commit".
    // We must NEVER auto-abort + mislabel the non-empty case as "empty" (it would
    // silently discard the user's work), and must NEVER return "error" while
    // mid-pick (the UI's error path doesn't open the resolver -> orphaned
    // CHERRY_PICK_HEAD with no Abort button).
    if in_progress(repo) {
        let blob = format!("{} {}", out.stdout, out.stderr).to_lowercase();
        let is_empty = blob.contains("now empty")
            || blob.contains("nothing to commit")
            || blob.contains("previous cherry-pick is now empty");
        if is_empty {
            // Redundant pick: tidy the sequencer, report a benign no-op.
            let _ = git(path, &["cherry-pick", "--abort"], false);
            return PickResult {
                ok: false,
                state: "empty".into(),
                conflicted_files: Vec::new(),
                message: format!("{label} is already applied — nothing to cherry-pick."),
                backup_ref: backup,
            };
        }
        // In progress, nothing unmerged, not empty (hook/sign rejection or a
        // rerere auto-resolve). Keep the repo mid-pick and route to the resolver
        // so its Abort/Continue stay reachable. Do NOT auto-abort.
        return PickResult {
            ok: false,
            state: "conflict".into(),
            conflicted_files: Vec::new(),
            message: format!(
                "Cherry-pick of {label} could not finish: {}. Continue to retry, or Abort.",
                git_msg(out)
            ),
            backup_ref: backup,
        };
    }

    // Not mid-pick (dirty-tree refusal, bad revision, merge without -m, …):
    // surface git verbatim. Never forced.
    PickResult {
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

/// Cherry-pick `sha` onto the current branch (HEAD). Snapshots FIRST, then runs
/// `git cherry-pick [-x] --no-edit --end-of-options <sha>`. `record_origin`
/// (the `-x` toggle) appends "(cherry picked from commit …)" to the message.
///
/// A dirty working tree makes git refuse the pick — that surfaces as
/// `state:"error"` with git's own message; we never force. On a conflict this
/// resolves to `state:"conflict"` (repo left mid-pick for the resolver), NOT a
/// failure.
///
/// JS: `invoke("cherry_pick", { path, sha, recordOrigin? })`.
#[tauri::command]
#[specta::specta]
pub fn cherry_pick(path: String, sha: String, record_origin: Option<bool>) -> PickResult {
    if let Err(e) = validate_sha(&sha) {
        return PickResult::error(e);
    }
    let repo = match crate::trust::open_repo(&path) {
        Ok(r) => r,
        Err(e) => return PickResult::error(format!("Cannot open repository: {}", e.message())),
    };

    // Refuse to stack a new pick on top of an unfinished one.
    if in_progress(&repo) {
        return PickResult::error(
            "A cherry-pick is already in progress — resolve or abort it first.",
        );
    }

    // Snapshot FIRST — never mutate without a pre-op backup. If it fails, abort.
    let backup = match crate::safety::snapshot(&repo) {
        Ok(b) => b,
        Err(e) => return PickResult::error(format!("Safety snapshot failed, aborting: {e}")),
    };

    // git cherry-pick [-x] --no-edit --end-of-options <sha>
    let mut args: Vec<&str> = vec!["cherry-pick"];
    if record_origin.unwrap_or(false) {
        args.push("-x");
    }
    args.push("--no-edit");
    args.push("--end-of-options");
    args.push(&sha);

    let out = match git(&path, &args, true) {
        Ok(o) => o,
        Err(e) => {
            return PickResult {
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

/// Continue an in-progress cherry-pick after the user resolved the conflict
/// (files were `git add`ed by the resolver). Runs `git cherry-pick --continue`
/// with `GIT_EDITOR=true` so it commits the resolution non-interactively.
///
/// Re-classifies the outcome: `clean` on success, `conflict` again if conflicts
/// remain unresolved, or `empty` if the resolution left no net change.
///
/// JS: `invoke("cherry_pick_continue", { path })`.
#[tauri::command]
#[specta::specta]
pub fn cherry_pick_continue(path: String) -> PickResult {
    let repo = match crate::trust::open_repo(&path) {
        Ok(r) => r,
        Err(e) => return PickResult::error(format!("Cannot open repository: {}", e.message())),
    };
    if !in_progress(&repo) {
        return PickResult::error("No cherry-pick in progress to continue.");
    }

    // Name the commit being applied (for messages) while CHERRY_PICK_HEAD exists.
    let label = git(&path, &["rev-parse", "--short", "CHERRY_PICK_HEAD"], false)
        .ok()
        .filter(|o| o.ok)
        .map(|o| o.stdout)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "the commit".to_string());

    // Snapshot the pre-commit state (HEAD is still the pre-pick commit during a
    // conflict). Best-effort: continue must remain possible even if it can't run.
    let backup = crate::safety::snapshot(&repo).ok();

    let out = match git(&path, &["cherry-pick", "--continue"], true) {
        Ok(o) => o,
        Err(e) => {
            return PickResult {
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

/// Abort an in-progress cherry-pick: `git cherry-pick --abort` restores the
/// pre-pick state. This is the escape hatch — it must ALWAYS be able to run, so
/// it deliberately does NOT take a snapshot (a snapshot failure must never block
/// the user's way out). Idempotent: "nothing in progress" is a benign success.
///
/// JS: `invoke("cherry_pick_abort", { path })`.
#[tauri::command]
#[specta::specta]
pub fn cherry_pick_abort(path: String) -> PickResult {
    let repo = match crate::trust::open_repo(&path) {
        Ok(r) => r,
        Err(e) => return PickResult::error(format!("Cannot open repository: {}", e.message())),
    };
    if !in_progress(&repo) {
        return PickResult {
            ok: true,
            state: "clean".into(),
            conflicted_files: Vec::new(),
            message: "No cherry-pick in progress.".into(),
            backup_ref: None,
        };
    }
    match git(&path, &["cherry-pick", "--abort"], false) {
        Ok(o) if o.ok => PickResult {
            ok: true,
            state: "clean".into(),
            conflicted_files: Vec::new(),
            message: "Cherry-pick aborted — back to the pre-pick state.".into(),
            backup_ref: None,
        },
        Ok(o) => PickResult::error(git_msg(&o)),
        Err(e) => PickResult::error(e),
    }
}
