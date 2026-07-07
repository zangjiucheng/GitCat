//! Rebase: replay the current branch's commits onto a target, with a real
//! conflict-per-commit path.
//!
//! Mirrors git_merge.rs's / git_pick.rs's model exactly (read git_merge.rs's
//! doc comment first): every mutation SNAPSHOTS first (Safety Manager), then
//! shells out to the git CLI — libgit2 has no rebase porcelain of its own that
//! tracks CLI-compatible sequencer state, and the CLI owns the in-progress
//! state (the `rebase-merge`/`rebase-apply` directory, conflict markers,
//! `--continue`/`--skip`/`--abort`). git2 is used only to open the repo, read
//! HEAD's identity, and locate the git dir for that sequencer state.
//!
//! SCOPE: linear rebase only — `rebase_start(path, onto)` runs a plain
//! `git rebase <onto>` (no `-i`, no todo-list editing/reordering). That is an
//! explicitly excluded, much larger follow-up milestone.
//!
//! Semantics: `git rebase <onto>` replays every commit reachable from HEAD but
//! not from `<onto>` on top of `<onto>`, then fast-forwards the current branch.
//! Rebase is the ONE op (of cherry-pick/merge/rebase) where a mid-sequence
//! SKIP is meaningful — it drops the commit currently being replayed entirely,
//! distinct from Abort (undo everything) and Continue (keep going after a
//! resolved conflict).
//!
//! State machine returned to the UI (`RebaseResult.state`):
//!   "clean"    — the rebase completed (all commits replayed, or there was
//!                nothing to replay and the branch was already up to date is
//!                reported as "empty" instead — see below); the branch tip
//!                moved (or, for a genuine no-op, stayed put) and the working
//!                tree is clean.
//!   "conflict" — a real conflict while replaying a commit; `conflicted_files`
//!                is non-empty and the repo is mid-rebase (a `rebase-merge` or
//!                `rebase-apply` directory is present). The UI opens the
//!                resolver, then calls `rebase_continue`, `rebase_skip`, or
//!                `rebase_abort`. EMPIRICALLY VERIFIED (see tests/rebase.rs)
//!                that continuing past one conflict straight into a SECOND
//!                conflicting commit re-reports "conflict" (not falsely
//!                "clean") — `git rebase --continue`/`--skip` exit non-zero
//!                and leave the sequencer's unmerged files populated exactly
//!                like the first conflict, so the SAME state-inspection logic
//!                (not message-scraping) that classifies the first conflict
//!                also classifies every subsequent one in the sequence.
//!   "empty"    — HEAD is already based on (up to date with) `<onto>` — git
//!                itself reports "…up to date." and mutates nothing.
//!   "error"    — anything else (dirty-tree refusal, bad revision, …);
//!                `message` carries git's own stderr. No in-progress state is
//!                left behind.
//!
//! Failure model (like git_merge / git_pick): commands return a plain
//! [`RebaseResult`], never a Rust `Err`, so the JS promise always resolves.
//!
//! Why a dedicated `RebaseResult` rather than reusing `PickResult`/
//! `MergeResult`: the field shape is identical today (same convention
//! discussion as git_merge.rs's `MergeResult` vs `PickResult`) — one result
//! type per operation module keeps each module's public API self-describing
//! in the generated TS bindings, and leaves room for a rebase-specific field
//! (e.g. sequence progress) later without a breaking rename.

use std::process::Command;

use git2::Repository;
use serde::Serialize;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/// Result of any rebase step (start / continue / skip / abort). Serializes
/// camelCase: `conflictedFiles`, `backupRef`.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseResult {
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

impl RebaseResult {
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
/// commit-message editor (`true` exits 0 immediately) via `GIT_EDITOR`
/// AND `GIT_SEQUENCE_EDITOR` — the latter matters even for a NON-interactive
/// rebase because `--continue`/`--skip` can still shell out to it when
/// finishing up. Neither should ever block a headless app. Returns `Err` only
/// if git can't spawn.
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
fn validate_rev(rev: &str) -> Result<(), String> {
    if rev.is_empty() {
        return Err("No target to rebase onto.".into());
    }
    if rev.starts_with('-') {
        return Err(format!("Refusing a revision that looks like a flag: {rev:?}"));
    }
    if rev.chars().any(|c| c.is_control()) {
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

/// True while a rebase is in progress: the sequencer keeps a `rebase-merge`
/// (the modern, default backend — verified on git 2.53.0 for a plain
/// non-interactive `git rebase <upstream>`) or `rebase-apply` (the older
/// patch-based backend, kept for completeness) directory in the git dir until
/// the rebase finishes/aborts. `repo.path()` is the git dir, so this is
/// correct for worktrees and non-standard layouts too.
fn in_progress(repo: &Repository) -> bool {
    repo.path().join("rebase-merge").exists() || repo.path().join("rebase-apply").exists()
}

/// Current branch shorthand for friendlier messages, else "HEAD". During a
/// rebase HEAD is detached (replaying commits one at a time), so this is only
/// meaningful before starting / after finishing.
fn head_name(repo: &Repository) -> String {
    match repo.head() {
        Ok(h) if h.is_branch() => h.shorthand().unwrap_or("HEAD").to_string(),
        _ => "HEAD".to_string(),
    }
}

/// A short, human label for the commit the sequencer is currently stopped on
/// (read from `rebase-merge/stopped-sha` while in progress), for `continue`/
/// `skip` messages. Falls back to "the commit" — best-effort, never blocks.
fn stopped_label(repo: &Repository, path: &str) -> String {
    let full = repo.path().join("rebase-merge").join("stopped-sha");
    let sha = std::fs::read_to_string(full).ok().map(|s| s.trim().to_string());
    match sha.filter(|s| !s.is_empty()) {
        Some(sha) => git(path, &["rev-parse", "--short", &sha], false)
            .ok()
            .filter(|o| o.ok)
            .map(|o| o.stdout)
            .filter(|s| !s.is_empty())
            .unwrap_or(sha),
        None => "the commit".to_string(),
    }
}

/// Compact tail of a backup ref, e.g. ".../1720000000-42-3" -> "1720000000-42-3".
fn short_backup(r: &str) -> String {
    r.rsplit('/').next().unwrap_or(r).to_string()
}

/// Turn a finished `rebase` / `--continue` / `--skip` run into a
/// [`RebaseResult`] by inspecting the resulting REPO STATE (not by scraping
/// git's prose, except for the one benign "nothing happened" case git only
/// reports via message text: "up to date"). `label` is a display name for the
/// rebase target (`onto`); `backup` is the pre-op snapshot ref (`None` when we
/// couldn't/didn't snapshot).
fn classify(
    repo: &Repository,
    path: &str,
    out: &Out,
    backup: Option<String>,
    label: &str,
) -> RebaseResult {
    let snap_note = backup
        .as_deref()
        .map(|b| format!(" (snapshot {})", short_backup(b)))
        .unwrap_or_default();

    if out.ok {
        // Verified on git 2.53.0: a no-op rebase (HEAD already based on
        // <onto>) exits 0 and prints "Current branch <name> is up to date."
        // — nothing is mutated. Report it as a benign no-op (parity with
        // merge's "empty"), not "clean".
        let blob = format!("{} {}", out.stdout, out.stderr).to_lowercase();
        if blob.contains("up to date") || blob.contains("up-to-date") {
            return RebaseResult {
                ok: false,
                state: "empty".into(),
                conflicted_files: Vec::new(),
                message: format!(
                    "{} is already up to date with {label} — nothing to rebase.",
                    head_name(repo)
                ),
                backup_ref: backup,
            };
        }
        return RebaseResult {
            ok: true,
            state: "clean".into(),
            conflicted_files: Vec::new(),
            message: format!("Rebased {} onto {label}{snap_note}.", head_name(repo)),
            backup_ref: backup,
        };
    }

    // A real conflict: the index has unmerged entries. This is the SAME check
    // whether we just landed on the FIRST conflicting commit or continued/
    // skipped straight into a SECOND (or Nth) one — empirically verified (see
    // tests/rebase.rs) that every stop in the sequence looks identical here.
    let conflicts = unmerged_files(path);
    if !conflicts.is_empty() {
        let n = conflicts.len();
        return RebaseResult {
            ok: false,
            state: "conflict".into(),
            conflicted_files: conflicts,
            message: format!(
                "Rebase onto {label} hit a conflict in {n} file{}. Resolve them, then Continue \
                 — or Skip this commit, or Abort.",
                if n == 1 { "" } else { "s" }
            ),
            backup_ref: backup,
        };
    }

    // No unmerged files. If the sequencer is still active, the replay itself
    // resolved cleanly but the concluding commit could not be created (hook
    // rejection, gpg-sign failure, …). We must NEVER auto-abort + mislabel
    // this as clean (it would silently discard progress), and must NEVER
    // return "error" while mid-rebase (the UI's error path doesn't open the
    // resolver -> orphaned sequencer state with no Abort/Skip button).
    if in_progress(repo) {
        return RebaseResult {
            ok: false,
            state: "conflict".into(),
            conflicted_files: Vec::new(),
            message: format!(
                "Rebase onto {label} could not finish: {}. Continue to retry, Skip this commit, \
                 or Abort.",
                git_msg(out)
            ),
            backup_ref: backup,
        };
    }

    // Not mid-rebase (dirty-tree refusal, bad revision, rebase already in
    // progress refused by git itself, …): surface git verbatim. Never forced.
    RebaseResult {
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

/// Rebase the current branch onto `onto`. Snapshots FIRST, then runs
/// `git rebase --end-of-options <onto>` (linear only — no `-i`; a
/// `GIT_SEQUENCE_EDITOR=true`/`GIT_EDITOR=true` non-interactive editor is set
/// so nothing can block a headless app).
///
/// A dirty working tree makes git refuse the rebase — that surfaces as
/// `state:"error"` with git's own message; we never force. On a conflict this
/// resolves to `state:"conflict"` (repo left mid-rebase for the resolver), NOT
/// a failure.
///
/// JS: `invoke("rebase_start", { path, onto })`.
#[tauri::command]
#[specta::specta]
pub fn rebase_start(path: String, onto: String) -> RebaseResult {
    if let Err(e) = validate_rev(&onto) {
        return RebaseResult::error(e);
    }
    let repo = match Repository::open(&path) {
        Ok(r) => r,
        Err(e) => return RebaseResult::error(format!("Cannot open repository: {}", e.message())),
    };

    // Refuse to stack a new rebase on top of an unfinished one.
    if in_progress(&repo) {
        return RebaseResult::error("A rebase is already in progress — resolve or abort it first.");
    }

    // Snapshot FIRST — never mutate without a pre-op backup. If it fails, abort.
    let backup = match crate::safety::snapshot(&repo) {
        Ok(b) => b,
        Err(e) => return RebaseResult::error(format!("Safety snapshot failed, aborting: {e}")),
    };

    // git rebase --end-of-options <onto>
    let args: Vec<&str> = vec!["rebase", "--end-of-options", &onto];

    let out = match git(&path, &args, true) {
        Ok(o) => o,
        Err(e) => {
            return RebaseResult {
                ok: false,
                state: "error".into(),
                conflicted_files: Vec::new(),
                message: e,
                backup_ref: Some(backup),
            }
        }
    };

    classify(&repo, &path, &out, Some(backup), &onto)
}

/// Continue an in-progress rebase after the user resolved the conflict (files
/// were `git add`ed by the resolver). Runs `git rebase --continue` with
/// `GIT_EDITOR=true`/`GIT_SEQUENCE_EDITOR=true` so it commits the resolution
/// non-interactively.
///
/// Re-classifies the outcome: `clean` once the whole sequence finishes,
/// `conflict` again if THIS commit is still unresolved, or — critically —
/// `conflict` again if resolving this commit landed on the NEXT conflicting
/// commit in the sequence (empirically verified, see tests/rebase.rs).
///
/// JS: `invoke("rebase_continue", { path })`.
#[tauri::command]
#[specta::specta]
pub fn rebase_continue(path: String) -> RebaseResult {
    let repo = match Repository::open(&path) {
        Ok(r) => r,
        Err(e) => return RebaseResult::error(format!("Cannot open repository: {}", e.message())),
    };
    if !in_progress(&repo) {
        return RebaseResult::error("No rebase in progress to continue.");
    }

    // Name the target (for messages) while the sequencer's `onto` file exists.
    let label = onto_label(&repo, &path);

    // Snapshot the pre-commit state. Best-effort: continue must remain
    // possible even if it can't run.
    let backup = crate::safety::snapshot(&repo).ok();

    let out = match git(&path, &["rebase", "--continue"], true) {
        Ok(o) => o,
        Err(e) => {
            return RebaseResult {
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

/// Skip the commit the rebase is currently stopped on — DROPS it from the
/// resulting history entirely (distinct from Abort/Continue; this is the one
/// op where mid-sequence skip is meaningful). Runs `git rebase --skip` with
/// the same non-interactive editor guards.
///
/// Re-classifies the outcome exactly like `rebase_continue`: `clean` once the
/// sequence finishes, or `conflict` again if skipping landed on the next
/// conflicting commit (empirically verified, see tests/rebase.rs).
///
/// JS: `invoke("rebase_skip", { path })`.
#[tauri::command]
#[specta::specta]
pub fn rebase_skip(path: String) -> RebaseResult {
    let repo = match Repository::open(&path) {
        Ok(r) => r,
        Err(e) => return RebaseResult::error(format!("Cannot open repository: {}", e.message())),
    };
    if !in_progress(&repo) {
        return RebaseResult::error("No rebase in progress to skip a commit from.");
    }

    let dropped = stopped_label(&repo, &path);
    let label = onto_label(&repo, &path);

    // Best-effort snapshot before dropping a commit's changes — mirrors
    // rebase_continue (never blocks Skip if it fails).
    let backup = crate::safety::snapshot(&repo).ok();

    let out = match git(&path, &["rebase", "--skip"], true) {
        Ok(o) => o,
        Err(e) => {
            return RebaseResult {
                ok: false,
                state: "error".into(),
                conflicted_files: Vec::new(),
                message: e,
                backup_ref: backup,
            }
        }
    };

    let mut result = classify(&repo, &path, &out, backup, &label);
    if result.state == "clean" {
        result.message = format!("Skipped {dropped} — {}", result.message);
    }
    result
}

/// Abort an in-progress rebase: `git rebase --abort` restores the pre-rebase
/// state. This is the escape hatch — it must ALWAYS be able to run, so it
/// deliberately does NOT take a snapshot (a snapshot failure must never block
/// the user's way out). Idempotent: "nothing in progress" is a benign success.
///
/// JS: `invoke("rebase_abort", { path })`.
#[tauri::command]
#[specta::specta]
pub fn rebase_abort(path: String) -> RebaseResult {
    let repo = match Repository::open(&path) {
        Ok(r) => r,
        Err(e) => return RebaseResult::error(format!("Cannot open repository: {}", e.message())),
    };
    if !in_progress(&repo) {
        return RebaseResult {
            ok: true,
            state: "clean".into(),
            conflicted_files: Vec::new(),
            message: "No rebase in progress.".into(),
            backup_ref: None,
        };
    }
    match git(&path, &["rebase", "--abort"], false) {
        Ok(o) if o.ok => RebaseResult {
            ok: true,
            state: "clean".into(),
            conflicted_files: Vec::new(),
            message: "Rebase aborted — back to the pre-rebase state.".into(),
            backup_ref: None,
        },
        Ok(o) => RebaseResult::error(git_msg(&o)),
        Err(e) => RebaseResult::error(e),
    }
}

/// A short, human label for the rebase target (read from
/// `rebase-merge/onto` while in progress; falls back to "the upstream").
/// Best-effort, never blocks.
fn onto_label(repo: &Repository, path: &str) -> String {
    let full = repo.path().join("rebase-merge").join("onto");
    let sha = std::fs::read_to_string(full).ok().map(|s| s.trim().to_string());
    match sha.filter(|s| !s.is_empty()) {
        Some(sha) => git(path, &["rev-parse", "--short", &sha], false)
            .ok()
            .filter(|o| o.ok)
            .map(|o| o.stdout)
            .filter(|s| !s.is_empty())
            .unwrap_or(sha),
        None => "the upstream".to_string(),
    }
}
