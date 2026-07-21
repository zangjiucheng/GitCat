//! Revert: undo a single commit's changes with a new commit on HEAD, with a
//! real conflict path.
//!
//! Mirrors git_merge.rs's / git_pick.rs's model exactly (read git_merge.rs's
//! doc comment first): every mutation SNAPSHOTS first (Safety Manager), then
//! shells out to the git CLI — libgit2 has no revert porcelain of its own that
//! tracks CLI-compatible sequencer state, and the CLI owns the in-progress
//! state (REVERT_HEAD, conflict markers, `--continue`/`--abort`). git2 is used
//! only to open the repo, read HEAD's identity, and locate the git dir for
//! REVERT_HEAD.
//!
//! Semantics: `git revert <sha>` applies <sha>'s INVERSE patch onto the
//! CURRENT branch (HEAD) as a new commit. Unlike cherry-pick/merge, revert has
//! no meaningful "target" — the drag-drop destination the UI shows is purely
//! visual, and (exactly like cherry-pick/merge already do) the mutation always
//! lands on HEAD; only the single SOURCE commit being reverted (<sha>) matters.
//!
//! State machine returned to the UI (`RevertResult.state`):
//!   "clean"    — the revert committed onto HEAD; working tree clean.
//!   "conflict" — a real conflict; `conflicted_files` is non-empty and the repo
//!                is mid-revert (REVERT_HEAD present). The UI opens the
//!                resolver, then calls `revert_continue` or `revert_abort`.
//!   "empty"    — <sha>'s changes are not present in the current tree (nothing
//!                to undo); a benign no-op, nothing was mutated.
//!   "error"    — anything else (dirty-tree refusal, bad revision, …);
//!                `message` carries git's own stderr. No in-progress state is
//!                left behind.
//!
//! Failure model (like git_merge / git_pick): commands return a plain
//! [`RevertResult`], never a Rust `Err`, so the JS promise always resolves.
//!
//! Why a dedicated `RevertResult` rather than reusing `PickResult`/
//! `MergeResult`: the field shape is identical today (same convention
//! discussion as git_merge.rs's `MergeResult` vs `PickResult`) — one result
//! type per operation module keeps each module's public API self-describing
//! in the generated TS bindings, and leaves room for a revert-specific field
//! later without a breaking rename.
//!
//! EMPIRICALLY VERIFIED (git 2.53.0, see tests/git_revert.rs) — revert's
//! "empty" case looks structurally different from cherry-pick's and needed its
//! own investigation rather than a blind copy of either classify():
//!   * Cherry-pick's empty case happens WHILE the sequencer is still open
//!     (CHERRY_PICK_HEAD present, exit 0) and git says so via "now empty" /
//!     "nothing to commit" — we tidy it with an explicit `--abort`.
//!   * Revert's empty case instead exits NON-zero (1) with NO sequencer state
//!     left behind at all (no REVERT_HEAD — there is nothing to abort) and
//!     prints the plain `git commit` porcelain message "nothing to commit,
//!     working tree clean" (revert applies the inverse patch, finds it a
//!     no-op, and its internal `commit` step refuses exactly like a manual
//!     `git commit` with nothing staged would). `classify` below special-cases
//!     this ONE benign message on the non-progress, non-conflict, non-ok path.
//!
//! Flag scope: only `-s`/`--signoff` is exposed (mirrors cherry-pick's `-x`
//! `record_origin` toggle — a single optional bool that only annotates the
//! commit message trailer, never changes the completion semantics). We
//! deliberately do NOT expose `--no-commit`/`-n` ("stage only, don't commit"):
//! empirically, a successful `git revert -n <sha>` (no conflict) still leaves
//! REVERT_HEAD behind on disk (verified — unlike a normal revert, whose
//! success always clears it), which would make `classify`'s `out.ok => clean`
//! rule falsely report "clean" for a commit that was never actually made. That
//! doesn't fit this module's four-state (clean/empty/conflict/error) contract,
//! so it's left out rather than bolted on as a fifth pseudo-state.
//! `-m/--mainline` (revert of a merge commit) is likewise out of scope, for the
//! same reason cherry-pick doesn't support it either.

use std::process::Command;

use git2::Repository;
use serde::Serialize;

use crate::procutil::NoConsoleWindowExt;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/// Result of any revert step (initial / continue / abort). Serializes
/// camelCase: `conflictedFiles`, `backupRef`.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RevertResult {
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
    /// True SPECIFICALLY when `state == "error"` because git refused the
    /// revert outright — the dirty working tree OR staged index would be
    /// overwritten — rather than some other refusal. See git_pick.rs's
    /// `blocked_by_local_changes` for the full doc comment (identical
    /// detection basis); mirrors git_write.rs's
    /// `WriteResult.conflicting_files`.
    pub blocked_by_local_changes: bool,
}

impl RevertResult {
    fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            state: "error".into(),
            conflicted_files: Vec::new(),
            message: message.into(),
            backup_ref: None,
            blocked_by_local_changes: false,
        }
    }
}

/// Identical detection to git_pick.rs's own `blocked_by_local_changes` — see
/// that function's doc comment for the full empirical basis (git 2.x):
/// revert shares the exact same unpack-trees safety check and message
/// wording as cherry-pick/merge for this refusal (verified: the staged-index
/// variant reads "your local changes would be overwritten by revert.",
/// naming revert specifically; the unstaged-tree variant reads "…by merge:"
/// like all three). Duplicated per module per this codebase's own
/// convention for small helpers.
fn blocked_by_local_changes(stderr: &str) -> bool {
    stderr.to_lowercase().contains("would be overwritten by")
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

/// Run `git -C <path> <args…>` with `LC_ALL=C`/`LANGUAGE=""` (mirrors
/// git_bisect.rs's `git()` exactly) so git's own prose is stable English
/// regardless of the host's locale — `classify` below depends on it: the
/// benign "empty revert" case is detected by matching the substring "nothing
/// to commit" in git's output (the ONE documented benign prose-scrape this
/// module does), which a non-English locale would translate (e.g. French's
/// "rien à valider, la copie de travail est propre"), silently breaking that
/// match and misreporting a benign empty revert as `state:"error"`. When
/// `no_editor` is set, force a no-op commit-message editor (`true` exits 0
/// immediately) via `GIT_EDITOR`, so any step that would otherwise open
/// `$EDITOR` — the revert's auto-commit, or `--continue` — proceeds
/// non-interactively and keeps the prepared message (otherwise a headless app
/// would hang). Returns `Err` only if git can't spawn.
fn git(path: &str, args: &[&str], no_editor: bool) -> Result<Out, String> {
    let mut cmd = Command::new("git");
    cmd.no_console_window();
    cmd.arg("-C")
        .arg(path)
        .args(args)
        .env("LC_ALL", "C")
        .env("LANGUAGE", "");
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
        return Err("No commit to revert.".into());
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

/// True while a revert is in progress: git keeps REVERT_HEAD in the git dir
/// until the revert is committed/aborted. `repo.path()` is the git dir, so this
/// is correct for worktrees and non-standard layouts too.
fn in_progress(repo: &Repository) -> bool {
    repo.path().join("REVERT_HEAD").exists()
}

/// Current branch shorthand for friendlier messages ("on main"), else "HEAD".
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

/// Turn a finished `revert` / `--continue` run into a [`RevertResult`] by
/// inspecting the resulting REPO STATE (not by scraping git's prose, except
/// for the one benign "nothing happened" case git only reports via message
/// text: "nothing to commit" — see the module doc comment for why revert's
/// empty case needed its own investigation). `label` is a display name for the
/// reverted commit; `backup` is the pre-op snapshot ref (None when we
/// couldn't/didn't snapshot).
fn classify(
    repo: &Repository,
    path: &str,
    out: &Out,
    backup: Option<String>,
    label: &str,
) -> RevertResult {
    let snap_note = backup
        .as_deref()
        .map(|b| format!(" (snapshot {})", short_backup(b)))
        .unwrap_or_default();

    if out.ok {
        return RevertResult {
            ok: true,
            state: "clean".into(),
            conflicted_files: Vec::new(),
            message: format!("Reverted {label} on {}{snap_note}.", head_name(repo)),
            backup_ref: backup,
            blocked_by_local_changes: false,
        };
    }

    // A real conflict: the index has unmerged entries.
    let conflicts = unmerged_files(path);
    if !conflicts.is_empty() {
        let n = conflicts.len();
        return RevertResult {
            ok: false,
            state: "conflict".into(),
            conflicted_files: conflicts,
            message: format!(
                "Revert of {label} hit a conflict in {n} file{}. Resolve them, then Continue — or Abort.",
                if n == 1 { "" } else { "s" }
            ),
            backup_ref: backup,
            blocked_by_local_changes: false,
        };
    }

    // No unmerged files. If REVERT_HEAD is still present, the revert itself
    // resolved cleanly but the concluding commit could not be created (hook
    // rejection, gpg-sign failure, …). We must NEVER auto-abort + mislabel
    // this as a clean result (it would silently discard the revert outcome),
    // and must NEVER return "error" while mid-revert (the UI's error path
    // doesn't open the resolver -> orphaned REVERT_HEAD with no Abort button).
    if in_progress(repo) {
        return RevertResult {
            ok: false,
            state: "conflict".into(),
            conflicted_files: Vec::new(),
            message: format!(
                "Revert of {label} could not finish: {}. Continue to retry, or Abort.",
                git_msg(out)
            ),
            backup_ref: backup,
            blocked_by_local_changes: false,
        };
    }

    // Not mid-revert. Distinguish the ONE benign no-op git reports only via
    // message text: <sha>'s changes are already absent from the tree, so the
    // inverse patch is empty — git's internal `commit` step (which revert
    // relies on) exits non-zero and prints "nothing to commit, working tree
    // clean" (verified on git 2.53.0). Unlike cherry-pick's empty case, there
    // is no sequencer state to tidy here (no REVERT_HEAD was left behind).
    let blob = format!("{} {}", out.stdout, out.stderr).to_lowercase();
    if blob.contains("nothing to commit") {
        return RevertResult {
            ok: false,
            state: "empty".into(),
            conflicted_files: Vec::new(),
            message: format!(
                "{label}'s changes aren't present in {} — nothing to revert.",
                head_name(repo)
            ),
            backup_ref: backup,
            blocked_by_local_changes: false,
        };
    }

    // Anything else (dirty-tree refusal, bad revision, revert of a merge
    // commit without `-m`, …): surface git verbatim. Never forced.
    RevertResult {
        ok: false,
        state: "error".into(),
        conflicted_files: Vec::new(),
        message: git_msg(out),
        blocked_by_local_changes: blocked_by_local_changes(&out.stderr),
        backup_ref: backup,
    }
}

// ---------------------------------------------------------------------------
// Tauri commands (registered in lib.rs)
// ---------------------------------------------------------------------------

/// Revert `sha` onto the current branch (HEAD). Snapshots FIRST, then runs
/// `git revert [-s] --no-edit --end-of-options <sha>`. `signoff` (the `-s`
/// toggle) appends a "Signed-off-by" trailer to the revert commit's message.
///
/// A dirty working tree makes git refuse the revert — that surfaces as
/// `state:"error"` with git's own message; we never force. On a conflict this
/// resolves to `state:"conflict"` (repo left mid-revert for the resolver), NOT
/// a failure.
///
/// JS: `invoke("revert_start", { path, sha, signoff? })`.
///
/// BUG FIX: was a plain (non-async) `fn` — it opens the repo and reads state
/// via git2 AND shells out to `git revert`, waiting on that subprocess to
/// exit, all inline on Tauri's main thread. A revert can take real time
/// (large trees, a merge-heavy inverse patch) and it also snapshots first
/// (its own git2 walk), so the whole app window froze for the entire
/// operation, not just this command. `async fn` + `run_blocking` moves the
/// whole body onto Tauri's blocking-task thread pool, matching
/// `workdir_status`'s established fix.
#[tauri::command]
#[specta::specta]
pub async fn revert_start(path: String, sha: String, signoff: Option<bool>) -> RevertResult {
    crate::blocking::run_blocking(move || {
        if let Err(e) = validate_sha(&sha) {
            return RevertResult::error(e);
        }
        let repo = match Repository::open(&path) {
            Ok(r) => r,
            Err(e) => return RevertResult::error(format!("Cannot open repository: {}", e.message())),
        };

        // Refuse to stack a new revert on top of an unfinished one.
        if in_progress(&repo) {
            return RevertResult::error("A revert is already in progress — resolve or abort it first.");
        }

        // Snapshot FIRST — never mutate without a pre-op backup. If it fails, abort.
        let backup = match crate::safety::snapshot(&repo) {
            Ok(b) => b,
            Err(e) => return RevertResult::error(format!("Safety snapshot failed, aborting: {e}")),
        };

        // git revert [-s] --no-edit --end-of-options <sha>
        let mut args: Vec<&str> = vec!["revert"];
        if signoff.unwrap_or(false) {
            args.push("-s");
        }
        args.push("--no-edit");
        args.push("--end-of-options");
        args.push(&sha);

        let out = match git(&path, &args, true) {
            Ok(o) => o,
            Err(e) => {
                return RevertResult {
                    ok: false,
                    state: "error".into(),
                    conflicted_files: Vec::new(),
                    message: e,
                    backup_ref: Some(backup),
                    blocked_by_local_changes: false,
                }
            }
        };

        classify(&repo, &path, &out, Some(backup), &sha)
    })
    .await
}

/// Continue an in-progress revert after the user resolved the conflict (files
/// were `git add`ed by the resolver). Runs `git revert --continue` with
/// `GIT_EDITOR=true` so it commits the resolution non-interactively.
///
/// Re-classifies the outcome: `clean` on success, `conflict` again if
/// conflicts remain unresolved.
///
/// JS: `invoke("revert_continue", { path })`.
///
/// BUG FIX: was a plain (non-async) `fn` — same class of stall as
/// `revert_start`: it opens the repo via git2, reads `REVERT_HEAD`, takes
/// another pre-commit snapshot, and shells out to `git revert --continue`,
/// blocking on that subprocess inline on Tauri's main thread. Since this is
/// the very command the conflict resolver calls after every resolve, it
/// froze the whole window right when the user was in the middle of
/// unblocking a conflict. `async fn` + `run_blocking` moves the wait onto
/// Tauri's blocking-task thread pool.
#[tauri::command]
#[specta::specta]
pub async fn revert_continue(path: String) -> RevertResult {
    crate::blocking::run_blocking(move || {
        let repo = match Repository::open(&path) {
            Ok(r) => r,
            Err(e) => return RevertResult::error(format!("Cannot open repository: {}", e.message())),
        };
        if !in_progress(&repo) {
            return RevertResult::error("No revert in progress to continue.");
        }

        // Name the commit being reverted (for messages) while REVERT_HEAD exists.
        let label = git(&path, &["rev-parse", "--short", "REVERT_HEAD"], false)
            .ok()
            .filter(|o| o.ok)
            .map(|o| o.stdout)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "the commit".to_string());

        // Snapshot the pre-commit state (HEAD is still the pre-revert commit during
        // a conflict). Best-effort: continue must remain possible even if it can't
        // run.
        let backup = crate::safety::snapshot(&repo).ok();

        let out = match git(&path, &["revert", "--continue"], true) {
            Ok(o) => o,
            Err(e) => {
                return RevertResult {
                    ok: false,
                    state: "error".into(),
                    conflicted_files: Vec::new(),
                    message: e,
                    backup_ref: backup,
                    blocked_by_local_changes: false,
                }
            }
        };

        classify(&repo, &path, &out, backup, &label)
    })
    .await
}

/// Abort an in-progress revert: `git revert --abort` restores the pre-revert
/// state. This is the escape hatch — it must ALWAYS be able to run, so it
/// deliberately does NOT take a snapshot (a snapshot failure must never block
/// the user's way out). Idempotent: "nothing in progress" is a benign success.
///
/// JS: `invoke("revert_abort", { path })`.
///
/// BUG FIX: was a plain (non-async) `fn` — it opens the repo via git2 and
/// shells out to `git revert --abort`, blocking on that subprocess inline on
/// Tauri's main thread for as long as git takes to restore the pre-revert
/// state. Being the escape hatch that must always be reachable even under a
/// bad conflict, it's especially bad for this one to also freeze the window
/// while it runs. `async fn` + `run_blocking` moves the wait onto Tauri's
/// blocking-task thread pool.
#[tauri::command]
#[specta::specta]
pub async fn revert_abort(path: String) -> RevertResult {
    crate::blocking::run_blocking(move || {
        let repo = match Repository::open(&path) {
            Ok(r) => r,
            Err(e) => return RevertResult::error(format!("Cannot open repository: {}", e.message())),
        };
        if !in_progress(&repo) {
            return RevertResult {
                ok: true,
                state: "clean".into(),
                conflicted_files: Vec::new(),
                message: "No revert in progress.".into(),
                backup_ref: None,
                blocked_by_local_changes: false,
            };
        }
        match git(&path, &["revert", "--abort"], false) {
            Ok(o) if o.ok => RevertResult {
                ok: true,
                state: "clean".into(),
                conflicted_files: Vec::new(),
                message: "Revert aborted — back to the pre-revert state.".into(),
                backup_ref: None,
                blocked_by_local_changes: false,
            },
            Ok(o) => RevertResult::error(git_msg(&o)),
            Err(e) => RevertResult::error(e),
        }
    })
    .await
}
