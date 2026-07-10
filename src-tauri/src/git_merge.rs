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
//!
//! Explicit strategy (backlog #7): [`merge_start`] takes an optional
//! `strategy` ("auto" | "no-ff" | "ff-only"; `None`/`""`/`"auto"` are all
//! today's exact default behavior — no extra flag), so every existing caller
//! that doesn't pass one keeps behaving identically. EMPIRICALLY VERIFIED on
//! git 2.53.0: `--no-ff` forces a real merge commit even when a fast-forward
//! is possible ("Merge made by the 'ort' strategy."); `--ff-only` fast-forwards
//! when possible and otherwise refuses cleanly (exit 128, "fatal: Not possible
//! to fast-forward, aborting.", nothing mutated, no `MERGE_HEAD`) — that
//! refusal falls straight into `classify()`'s existing generic "error" branch,
//! so `merge_continue`/`merge_abort` need no changes at all for either
//! strategy: `--ff-only` can never leave `MERGE_HEAD` behind, and `--no-ff`'s
//! conflicts are ordinary merge conflicts the existing continue/abort already
//! handle.
//!
//! Squash-merge (backlog #7): [`merge_squash`] stages `<sha>`'s entire diff
//! into the index via `git merge --squash` WITHOUT creating a commit or
//! moving any ref — the user finishes with a normal commit (via the existing
//! Workdir commit flow), using `.git/SQUASH_MSG`'s suggested message. This
//! mirrors workdir.rs's "STASH CONFLICT" mechanism (read that module's doc
//! comment first): `--squash` sets NO in-progress marker of its own — no
//! `MERGE_HEAD`, `RepositoryState` stays `Clean` even mid-conflict — so
//! there is nothing for a `MERGE_HEAD`-gated abort/continue to read back.
//! [`MergeSquashConflictState`] is this module's own sidecar (the squash
//! analogue of workdir.rs's `StashConflictState`), read/written by
//! [`merge_squash`]/[`merge_squash_abort`]/[`merge_squash_continue`], and
//! `conflict.rs::detect_op` learns of it via [`has_merge_squash_conflict`] to
//! tell a squash conflict apart from a stash conflict (both leave
//! `RepositoryState::Clean` with unmerged index entries).

use std::fs;
use std::process::Command;

use git2::Repository;
use serde::{Deserialize, Serialize};

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
/// `strategy` picks the ff/no-ff behavior: `None`/`Some("")`/`Some("auto")`
/// (today's exact default — no extra flag, fast-forward when possible, a real
/// merge commit otherwise), `Some("no-ff")` (`--no-ff`: always create a real
/// merge commit, even when a fast-forward is possible), or `Some("ff-only")`
/// (`--ff-only`: refuse — cleanly, `state:"error"`, nothing mutated — unless a
/// fast-forward is possible). Any other value is rejected up front (mirrors
/// `resolve_conflict_file`'s `side` validation) rather than silently falling
/// back to "auto". Every EXISTING caller (the drag-onto-HEAD gesture, the
/// commit-menu's "Merge" action, and `pullWithStrategy`'s merge path) omits
/// this parameter and must keep behaving exactly as before — see this
/// module's doc comment.
///
/// A dirty working tree makes git refuse the merge — that surfaces as
/// `state:"error"` with git's own message; we never force. On a conflict this
/// resolves to `state:"conflict"` (repo left mid-merge for the resolver), NOT
/// a failure.
///
/// JS: `invoke("merge_start", { path, sha, strategy })`.
#[tauri::command]
#[specta::specta]
pub fn merge_start(path: String, sha: String, strategy: Option<String>) -> MergeResult {
    if let Err(e) = validate_sha(&sha) {
        return MergeResult::error(e);
    }
    let extra_flag: Option<&str> = match strategy.as_deref() {
        None | Some("") | Some("auto") => None,
        Some("no-ff") => Some("--no-ff"),
        Some("ff-only") => Some("--ff-only"),
        Some(other) => {
            return MergeResult::error(format!(
                "Unknown merge strategy {other:?} (expected \"auto\", \"no-ff\", or \"ff-only\")."
            ))
        }
    };
    let repo = match crate::trust::open_repo(&path) {
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

    // git merge --no-edit --no-autostash [--no-ff|--ff-only] --end-of-options <sha>
    //
    // --no-autostash is explicit, not incidental: with an ambient
    // `merge.autoStash=true` in the user's global gitconfig, a dirty tree
    // that collides with the merge doesn't refuse up front — git silently
    // stashes it, merges, and re-applies the stash. If THAT reapply itself
    // conflicts, git still exits 0 (MERGE_HEAD gone), so `classify()` below
    // (which checks unmerged_files unconditionally, not gated on
    // in_progress) reports a normal "conflict" and opens the Resolver — but
    // `merge_continue`/`merge_abort` both gate on `in_progress()` first and
    // find the merge already concluded: continue/abort then either error
    // ("no merge in progress") or, worse, `abort` falsely reports "clean",
    // silently leaving real conflict markers in the working tree with the
    // user's original edit stranded in `stash@{0}`. Passing --no-autostash
    // makes the dirty-tree case refuse up front instead, matching this
    // module's own "never leave the tree in a misleading state" contract —
    // independent of what the user's global gitconfig happens to set.
    let mut args: Vec<&str> = vec!["merge", "--no-edit", "--no-autostash"];
    if let Some(f) = extra_flag {
        args.push(f);
    }
    args.push("--end-of-options");
    args.push(&sha);

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
    let repo = match crate::trust::open_repo(&path) {
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
    let repo = match crate::trust::open_repo(&path) {
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

// ---------------------------------------------------------------------------
// Squash-merge (backlog #7): stage <sha>'s diff into the index without
// committing, plus its own conflict Abort/Continue — see this module's doc
// comment for why a dedicated sidecar/result type exists (no MERGE_HEAD).
// ---------------------------------------------------------------------------

/// Result of `merge_squash` / `merge_squash_abort` / `merge_squash_continue` —
/// ONE shared type across all three (mirrors `MergeResult`'s own start/
/// continue/abort sharing), since none of the three needs to match any
/// pre-existing toast-consumer shape the way stash's `apply_or_pop` had to
/// preserve `WorkdirResult` for.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeSquashResult {
    pub ok: bool,
    /// "staged" (merge_squash/merge_squash_continue success) | "conflict" |
    /// "empty" (merge_squash only) | "clean" (merge_squash_abort only) |
    /// "error".
    ///
    /// Deliberately NEVER "clean" from a successful squash itself: `--squash`
    /// commits nothing and moves no ref (EMPIRICALLY VERIFIED — see module
    /// doc), so unlike every other op's "clean" (= fully done), the user still
    /// owes a real commit. "staged" is that honest, distinct state; the
    /// frontend hands off to the Workdir commit UI on it instead of
    /// closing+cheering the way "clean" does everywhere else.
    pub state: String,
    pub conflicted_files: Vec<String>,
    pub message: String,
    pub backup_ref: Option<String>,
    /// `.git/SQUASH_MSG`'s content — populated only when state == "staged".
    pub suggested_message: Option<String>,
}

impl MergeSquashResult {
    fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            state: "error".into(),
            conflicted_files: Vec::new(),
            message: message.into(),
            backup_ref: None,
            suggested_message: None,
        }
    }
}

/// `<git-dir>/gitgui/merge-squash-conflict.json` — the squash-merge analogue
/// of workdir.rs's `StashConflictState`: `--squash` sets no in-progress
/// marker of its own (no `MERGE_HEAD`; `RepositoryState` stays `Clean` even
/// mid-conflict — see module doc), so there is nothing for a
/// `MERGE_HEAD`-gated abort/continue to read back. This sidecar IS that
/// marker. Only `backup_ref` is strictly needed (unlike `StashConflictState`,
/// squash has no "pop vs apply" branch, no stash index/identity to
/// re-verify, and no separate label to recover — `merge_squash_continue`
/// re-reads `.git/SQUASH_MSG` fresh rather than caching it, since it's
/// empirically confirmed to survive untouched through conflict resolution,
/// only deleted by a REAL `git commit`).
#[derive(Serialize, Deserialize)]
struct MergeSquashConflictState {
    backup_ref: String,
}

fn merge_squash_conflict_state_path(repo: &Repository) -> std::path::PathBuf {
    repo.path().join("gitgui").join("merge-squash-conflict.json")
}

/// Best-effort write: losing this sidecar would only degrade Abort/Continue's
/// UX (the conflict itself is still resolvable by hand), never lose data.
fn write_merge_squash_conflict_state(repo: &Repository, st: &MergeSquashConflictState) {
    let p = merge_squash_conflict_state_path(repo);
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string(st) {
        let _ = fs::write(p, s);
    }
}

fn read_merge_squash_conflict_state(repo: &Repository) -> Option<MergeSquashConflictState> {
    let data = fs::read_to_string(merge_squash_conflict_state_path(repo)).ok()?;
    serde_json::from_str(&data).ok()
}

/// `pub(crate)`: also called from `workdir::apply_or_pop` to clear a stale
/// leftover of THIS sidecar before it starts (see that function's own
/// comment, and `conflict.rs::detect_op`'s doc comment on the misattribution
/// bug this closes).
pub(crate) fn clear_merge_squash_conflict_state(repo: &Repository) {
    let _ = fs::remove_file(merge_squash_conflict_state_path(repo));
}

/// Whether a squash-merge conflict is currently outstanding — the ONE thing
/// `conflict.rs::detect_op` needs from this module to tell a squash conflict
/// apart from a stash conflict. `pub(crate)`, not `pub`: an internal
/// cross-module signal, not part of this module's own command surface.
pub(crate) fn has_merge_squash_conflict(repo: &Repository) -> bool {
    merge_squash_conflict_state_path(repo).exists()
}

/// `.git/SQUASH_MSG`'s content, trimmed; `None` if absent/empty. Read fresh
/// every time (never cached in the sidecar) — EMPIRICALLY VERIFIED it
/// survives untouched through conflict resolution and is deleted only by a
/// REAL `git commit` (workdir::commit never touches it itself), so a fresh
/// read at `merge_squash`'s own success AND at `merge_squash_continue`'s
/// later success both always report today's actual content.
fn read_squash_msg(repo: &Repository) -> Option<String> {
    fs::read_to_string(repo.path().join("SQUASH_MSG"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Broader than this file's own `in_progress` (`MERGE_HEAD`-only): a
/// `--squash` attempt must refuse on top of ANY unfinished sequencer op, not
/// just a merge — mirrors workdir.rs's `apply_or_pop` guard exactly (see its
/// own comment) and matters doubly here: it's also what keeps "both a stash
/// AND a squash sidecar exist" out of reach under normal use (see
/// `conflict.rs::detect_op`'s doc comment).
fn other_op_in_progress(repo: &Repository) -> bool {
    !matches!(repo.state(), git2::RepositoryState::Clean)
}

/// Squash `sha`'s entire diff into the index WITHOUT creating a commit.
/// Snapshots FIRST. Refuses up front if another sequencer op is in progress
/// OR the index already has unmerged entries from ANY source (stash, a
/// previous unresolved squash, …) — see `other_op_in_progress`'s doc comment.
///
/// JS: `invoke("merge_squash", { path, sha })`.
#[tauri::command]
#[specta::specta]
pub fn merge_squash(path: String, sha: String) -> MergeSquashResult {
    if let Err(e) = validate_sha(&sha) {
        return MergeSquashResult::error(e);
    }
    let repo = match crate::trust::open_repo(&path) {
        Ok(r) => r,
        Err(e) => {
            return MergeSquashResult::error(format!("Cannot open repository: {}", e.message()))
        }
    };
    if other_op_in_progress(&repo) {
        return MergeSquashResult::error(
            "Another operation (merge/rebase/cherry-pick/revert) is already in progress — resolve or abort it first.",
        );
    }
    if !unmerged_files(&path).is_empty() {
        return MergeSquashResult::error(
            "There are unresolved conflicts already — resolve or abort them first.",
        );
    }
    // At this point unmerged_files() is empty, which proves any PRIOR
    // conflict — of either kind — is genuinely concluded (a live one would
    // still have unmerged entries). Clear any sidecar left behind by a
    // conflict that was resolved out-of-band (e.g. via a plain `git commit`
    // from a terminal) instead of through this app's own Abort/Continue —
    // an adversarially-found bug: a stale sidecar surviving here would later
    // make `conflict.rs::detect_op` misattribute a FUTURE, unrelated
    // conflict to the wrong op, and that op's abort/continue would then act
    // on a backup_ref/identity that has nothing to do with the real
    // conflict (in the squash-vs-stash case, hard-resetting HEAD to a stale,
    // unrelated snapshot). Clearing both sidecars here (not just this
    // module's own) closes the gap symmetrically with `apply_or_pop`'s
    // identical cleanup below.
    clear_merge_squash_conflict_state(&repo);
    crate::workdir::clear_stash_conflict_state(&repo);

    let backup = match crate::safety::snapshot(&repo) {
        Ok(b) => b,
        Err(e) => return MergeSquashResult::error(format!("Safety snapshot failed, aborting: {e}")),
    };

    // git merge --squash --no-autostash --end-of-options <sha>
    //
    // --no-autostash for the identical reason merge_start passes it (see that
    // command's own comment): without it, an ambient `merge.autoStash=true`
    // could silently stash a dirty tree, squash-merge, then reapply the
    // stash — and if THAT reapply conflicts, this module has no sequencer
    // marker to notice at all (squash already has none of its own), which
    // would strand the user's original edit in `stash@{0}` with no trace.
    // --no-autostash makes the dirty-tree case refuse up front instead.
    let args: Vec<&str> = vec!["merge", "--squash", "--no-autostash", "--end-of-options", &sha];
    let out = match git(&path, &args, true) {
        Ok(o) => o,
        Err(e) => {
            return MergeSquashResult {
                ok: false,
                state: "error".into(),
                conflicted_files: Vec::new(),
                message: e,
                backup_ref: Some(backup),
                suggested_message: None,
            }
        }
    };

    classify_squash(&repo, &path, &out, backup, &sha)
}

/// Turn a finished `git merge --squash` run into a [`MergeSquashResult`] —
/// the squash analogue of `classify()` above. `label` is a display name for
/// the squashed-from commit/branch; `backup` is the pre-op snapshot ref.
fn classify_squash(repo: &Repository, path: &str, out: &Out, backup: String, label: &str) -> MergeSquashResult {
    if out.ok {
        // Verified: a no-op squash (HEAD already contains <sha>'s content, no
        // common-ancestor diff left to squash) exits 0 and prints "Already up
        // to date. (nothing to squash)" — nothing is staged, SQUASH_MSG is
        // NOT written. Report it as a benign no-op, not "staged".
        let blob = format!("{} {}", out.stdout, out.stderr).to_lowercase();
        if blob.contains("already up to date") || blob.contains("already up-to-date") {
            return MergeSquashResult {
                ok: false,
                state: "empty".into(),
                conflicted_files: Vec::new(),
                message: format!(
                    "{label} is already up to date with {} — nothing to squash.",
                    head_name(repo)
                ),
                backup_ref: Some(backup),
                suggested_message: None,
            };
        }
        return MergeSquashResult {
            ok: true,
            state: "staged".into(),
            conflicted_files: Vec::new(),
            message: format!(
                "Squashed {label} into the index (snapshot {}) — write a commit message to finish.",
                short_backup(&backup)
            ),
            backup_ref: Some(backup),
            suggested_message: read_squash_msg(repo),
        };
    }

    // A real conflict: the index has unmerged entries (no MERGE_HEAD is ever
    // set by --squash — see module doc — so this is the ONLY signal).
    let conflicts = unmerged_files(path);
    if !conflicts.is_empty() {
        write_merge_squash_conflict_state(repo, &MergeSquashConflictState { backup_ref: backup.clone() });
        let n = conflicts.len();
        return MergeSquashResult {
            ok: false,
            state: "conflict".into(),
            conflicted_files: conflicts,
            message: format!(
                "Squashing {label} hit a conflict in {n} file{}. Resolve them, then Continue — or Abort.",
                if n == 1 { "" } else { "s" }
            ),
            backup_ref: Some(backup),
            suggested_message: None,
        };
    }

    // Not a conflict (dirty-tree refusal, bad revision, …): surface git
    // verbatim. Never forced.
    MergeSquashResult {
        ok: false,
        state: "error".into(),
        conflicted_files: Vec::new(),
        message: git_msg(out),
        backup_ref: Some(backup),
        suggested_message: None,
    }
}

/// Abort a squash-merge conflict left by `merge_squash` — mirrors
/// `workdir::stash_conflict_abort`'s exact mechanism (`git reset --hard` to
/// the sealed backup ref, then clear the sidecar); `--squash` has no native
/// `--abort` of its own.
///
/// JS: `invoke("merge_squash_abort", { path })`.
#[tauri::command]
#[specta::specta]
pub fn merge_squash_abort(path: String) -> MergeSquashResult {
    let repo = match crate::trust::open_repo(&path) {
        Ok(r) => r,
        Err(e) => {
            return MergeSquashResult::error(format!("Cannot open repository: {}", e.message()))
        }
    };
    let Some(state) = read_merge_squash_conflict_state(&repo) else {
        return MergeSquashResult::error("No squash-merge conflict in progress to abort.");
    };

    let target_sha = match git(&path, &["rev-parse", &state.backup_ref], false) {
        Ok(o) if o.ok && !o.stdout.is_empty() => o.stdout.trim().to_string(),
        Ok(o) => {
            return MergeSquashResult::error(format!(
                "Could not resolve the pre-conflict snapshot {}: {}",
                state.backup_ref,
                git_msg(&o)
            ))
        }
        Err(e) => return MergeSquashResult::error(e),
    };

    match git(&path, &["reset", "--hard", &target_sha], false) {
        Ok(out) if out.ok => {
            clear_merge_squash_conflict_state(&repo);
            MergeSquashResult {
                ok: true,
                state: "clean".into(),
                conflicted_files: Vec::new(),
                message: format!(
                    "Squash-merge conflict aborted — working tree restored to the pre-squash state (snapshot {}).",
                    short_backup(&state.backup_ref)
                ),
                backup_ref: None,
                suggested_message: None,
            }
        }
        Ok(out) => MergeSquashResult::error(git_msg(&out)),
        Err(e) => MergeSquashResult::error(e),
    }
}

/// Finish a squash-merge conflict after every file is resolved+staged (via
/// `resolve_conflict_file`, allowlisted for "merge-squash" — see
/// conflict.rs). Success is STILL "staged", never "clean" — see
/// [`MergeSquashResult`]'s doc. No git subprocess is run here at all (unlike
/// merge/rebase's own `--continue`): once the index has zero unmerged
/// entries, squash's own job is already done — the only thing left is the
/// commit itself, which is the EXISTING Workdir commit flow's job (mirrors
/// `stash_conflict_continue`'s "apply" case, which likewise runs no git
/// mutation).
///
/// JS: `invoke("merge_squash_continue", { path })`.
#[tauri::command]
#[specta::specta]
pub fn merge_squash_continue(path: String) -> MergeSquashResult {
    let repo = match crate::trust::open_repo(&path) {
        Ok(r) => r,
        Err(e) => {
            return MergeSquashResult::error(format!("Cannot open repository: {}", e.message()))
        }
    };
    if read_merge_squash_conflict_state(&repo).is_none() {
        return MergeSquashResult::error("No squash-merge conflict in progress to continue.");
    }

    let remaining = unmerged_files(&path);
    if !remaining.is_empty() {
        let n = remaining.len();
        return MergeSquashResult {
            ok: false,
            state: "conflict".into(),
            conflicted_files: remaining,
            message: format!(
                "Still conflicted in {n} file{}. Resolve them, then Continue — or Abort.",
                if n == 1 { "" } else { "s" }
            ),
            backup_ref: None,
            suggested_message: None,
        };
    }

    clear_merge_squash_conflict_state(&repo);
    MergeSquashResult {
        ok: true,
        state: "staged".into(),
        conflicted_files: Vec::new(),
        message: "Squash-merge conflict resolved — write a commit message to finish.".into(),
        backup_ref: None,
        suggested_message: read_squash_msg(&repo),
    }
}
