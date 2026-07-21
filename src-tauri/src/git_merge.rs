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
//!   "octopus-conflict-unsupported" — `merge_start_multi`'s octopus mode
//!                only: a conflict git's octopus strategy can't resolve
//!                across more than two heads; the merge was aborted and
//!                nothing was mutated (see `merge_octopus`'s own doc).
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

use crate::procutil::NoConsoleWindowExt;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/// Result of any merge step (initial / continue / abort). Serializes
/// camelCase: `conflictedFiles`, `backupRef`.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub ok: bool,
    /// "clean" | "conflict" | "empty" | "error" | "octopus-conflict-unsupported"
    /// (the last one is `merge_start_multi`'s octopus mode only — see this
    /// module's own doc comment)
    pub state: String,
    /// Repo-relative paths with unmerged entries — non-empty only when
    /// `state == "conflict"`.
    pub conflicted_files: Vec<String>,
    pub message: String,
    /// Pre-op safety snapshot ref (present when we snapshotted before mutating),
    /// so the UI can name the snapshot the user can Undo to.
    pub backup_ref: Option<String>,
    /// True SPECIFICALLY when `state == "error"` because git refused the
    /// merge outright — the dirty working tree OR staged index would be
    /// overwritten — rather than some other refusal (bad revision, a merge
    /// already in progress, `--ff-only` refusing a non-fast-forward, …). See
    /// git_pick.rs's `blocked_by_local_changes` (identical detection, same
    /// empirical basis — merge and cherry-pick share the exact same
    /// unpack-trees safety check and message wording) for the full doc
    /// comment; mirrors git_write.rs's `WriteResult.conflicting_files`.
    pub blocked_by_local_changes: bool,
}

impl MergeResult {
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

/// Identical detection to git_pick.rs's own `blocked_by_local_changes` —
/// see that function's doc comment for the full empirical basis (git 2.x):
/// merge and cherry-pick share the exact same unpack-trees safety check and
/// message wording for this refusal, both unstaged-tree and staged-index
/// variants. Duplicated per module (not shared) per this codebase's own
/// convention for small helpers — see e.g. dashboard.svelte.ts's
/// repoBasename() doc comment.
///
/// EMPIRICALLY VERIFIED (git 2.53.0) `merge_octopus`'s own dirty-tree
/// refusal uses DIFFERENT wording from a plain two-ref merge's: instead of
/// "Your local changes ... would be overwritten by merge", an octopus merge
/// (>1 non-HEAD ref) refuses with "error: Entry '<path>' not uptodate.
/// Cannot merge." — same underlying safety check, different message, so
/// this needed its own second pattern rather than being caught by the first.
fn blocked_by_local_changes(stderr: &str) -> bool {
    let blob = stderr.to_lowercase();
    blob.contains("would be overwritten by") || blob.contains("not uptodate. cannot merge")
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
    cmd.no_console_window();
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
                blocked_by_local_changes: false,
            };
        }
        return MergeResult {
            ok: true,
            state: "clean".into(),
            conflicted_files: Vec::new(),
            message: format!("Merged {label} into {}{snap_note}.", head_name(repo)),
            backup_ref: backup,
            blocked_by_local_changes: false,
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
            blocked_by_local_changes: false,
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
            blocked_by_local_changes: false,
        };
    }

    // Not mid-merge (dirty-tree refusal, bad revision, merge already in
    // progress refused by git itself, …): surface git verbatim. Never forced.
    MergeResult {
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
///
/// Opens the repo with git2 and, via `merge_one`, shells out to `git merge`
/// itself — a real merge of arbitrary size (tree diffing, working-tree
/// checkout, possibly a conflict). As a plain sync fn that ran inline on
/// Tauri's main thread, freezing the whole window for as long as the merge
/// took. `async fn` + `run_blocking` moves it to Tauri's blocking-task pool.
#[tauri::command]
#[specta::specta]
pub async fn merge_start(path: String, sha: String, strategy: Option<String>) -> MergeResult {
    crate::blocking::run_blocking(move || {
        if let Err(e) = validate_sha(&sha) {
            return MergeResult::error(e);
        }
        let extra_flag = match parse_strategy(strategy.as_deref()) {
            Ok(f) => f,
            Err(e) => return MergeResult::error(e),
        };
        let repo = match crate::trust::open_repo(&path) {
            Ok(r) => r,
            Err(e) => return MergeResult::error(format!("Cannot open repository: {}", e.message())),
        };

        // Refuse to stack a new merge on top of an unfinished one.
        if in_progress(&repo) {
            return MergeResult::error("A merge is already in progress — resolve or abort it first.");
        }

        merge_one(&repo, &path, &sha, extra_flag)
    })
    .await
}

/// `strategy` -> the extra CLI flag it maps to (or `None` for today's exact
/// default behavior) — shared by `merge_start` and `merge_start_multi`'s
/// sequential mode (see that command's own doc comment: the flag is captured
/// once per queue and reused for every step). Rejects an unknown value up
/// front with a clean message, mirroring `resolve_conflict_file`'s `side`
/// validation.
fn parse_strategy(strategy: Option<&str>) -> Result<Option<&'static str>, String> {
    match strategy {
        None | Some("") | Some("auto") => Ok(None),
        Some("no-ff") => Ok(Some("--no-ff")),
        Some("ff-only") => Ok(Some("--ff-only")),
        Some(other) => Err(format!(
            "Unknown merge strategy {other:?} (expected \"auto\", \"no-ff\", or \"ff-only\")."
        )),
    }
}

/// One `git merge` attempt against an already-opened, already-`in_progress`-
/// checked repo: snapshot, run `git merge --no-edit --no-autostash
/// [extra_flag] --end-of-options <sha>`, classify the result. Shared by
/// `merge_start` (single-branch) and `merge_start_multi`/`merge_queue_continue`
/// (sequential mode's per-step merges) — extracted so the sequential queue's
/// steps run through the EXACT SAME snapshot/args/classify path a plain
/// single merge does, rather than a second, drifting copy of it.
///
/// --no-autostash is explicit, not incidental: with an ambient
/// `merge.autoStash=true` in the user's global gitconfig, a dirty tree
/// that collides with the merge doesn't refuse up front — git silently
/// stashes it, merges, and re-applies the stash. If THAT reapply itself
/// conflicts, git still exits 0 (MERGE_HEAD gone), so `classify()` below
/// (which checks unmerged_files unconditionally, not gated on
/// in_progress) reports a normal "conflict" and opens the Resolver — but
/// `merge_continue`/`merge_abort` both gate on `in_progress()` first and
/// find the merge already concluded: continue/abort then either error
/// ("no merge in progress") or, worse, `abort` falsely reports "clean",
/// silently leaving real conflict markers in the working tree with the
/// user's original edit stranded in `stash@{0}`. Passing --no-autostash
/// makes the dirty-tree case refuse up front instead, matching this
/// module's own "never leave the tree in a misleading state" contract —
/// independent of what the user's global gitconfig happens to set.
fn merge_one(repo: &Repository, path: &str, sha: &str, extra_flag: Option<&str>) -> MergeResult {
    // Snapshot FIRST — never mutate without a pre-op backup. If it fails, abort.
    let backup = match crate::safety::snapshot(repo) {
        Ok(b) => b,
        Err(e) => return MergeResult::error(format!("Safety snapshot failed, aborting: {e}")),
    };

    let mut args: Vec<&str> = vec!["merge", "--no-edit", "--no-autostash"];
    if let Some(f) = extra_flag {
        args.push(f);
    }
    args.push("--end-of-options");
    args.push(sha);

    let out = match git(path, &args, true) {
        Ok(o) => o,
        Err(e) => {
            return MergeResult {
                ok: false,
                state: "error".into(),
                conflicted_files: Vec::new(),
                message: e,
                backup_ref: Some(backup),
                blocked_by_local_changes: false,
            }
        }
    };

    classify(repo, path, &out, Some(backup), sha)
}

/// Continue an in-progress merge after the user resolved the conflict (files
/// were `git add`ed by the resolver). Runs `git merge --continue` with
/// `GIT_EDITOR=true` so it commits the resolution non-interactively.
///
/// Re-classifies the outcome: `clean` on success, `conflict` again if
/// conflicts remain unresolved.
///
/// JS: `invoke("merge_continue", { path })`.
///
/// Opens the repo with git2, shells out to `git rev-parse` to name the
/// in-progress merge, then to `git merge --continue` itself — which finishes
/// the merge and may run hooks, all real subprocess work whose cost scales
/// with the repo/commit. As a plain sync fn this ran inline on Tauri's main
/// thread, freezing the whole window; `async fn` + `run_blocking` fixes that.
#[tauri::command]
#[specta::specta]
pub async fn merge_continue(path: String) -> MergeResult {
    crate::blocking::run_blocking(move || {
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
                    blocked_by_local_changes: false,
                }
            }
        };

        classify(&repo, &path, &out, backup, &label)
    })
    .await
}

/// Abort an in-progress merge: `git merge --abort` restores the pre-merge
/// state. This is the escape hatch — it must ALWAYS be able to run, so it
/// deliberately does NOT take a snapshot (a snapshot failure must never block
/// the user's way out). Idempotent: "nothing in progress" is a benign success.
///
/// JS: `invoke("merge_abort", { path })`.
///
/// Opens the repo with git2 and, via `merge_abort_impl`, shells out to
/// `git merge --abort`, which checks out the pre-merge tree — a real
/// checkout whose cost scales with the working tree's size. Run inline on
/// Tauri's main thread as a plain sync fn this froze the whole window for
/// the duration; `async fn` + `run_blocking` moves it off that thread.
#[tauri::command]
#[specta::specta]
pub async fn merge_abort(path: String) -> MergeResult {
    crate::blocking::run_blocking(move || {
        let repo = match crate::trust::open_repo(&path) {
            Ok(r) => r,
            Err(e) => return MergeResult::error(format!("Cannot open repository: {}", e.message())),
        };
        merge_abort_impl(&repo, &path)
    })
    .await
}

/// Shared body of [`merge_abort`], taking an already-open repo handle —
/// lets [`merge_queue_abort`] reuse it without a second `Repository::open` +
/// a second `in_progress` check against a repo it already has open.
fn merge_abort_impl(repo: &Repository, path: &str) -> MergeResult {
    if !in_progress(repo) {
        return MergeResult {
            ok: true,
            state: "clean".into(),
            conflicted_files: Vec::new(),
            message: "No merge in progress.".into(),
            backup_ref: None,
            blocked_by_local_changes: false,
        };
    }
    match git(path, &["merge", "--abort"], false) {
        Ok(o) if o.ok => MergeResult {
            ok: true,
            state: "clean".into(),
            conflicted_files: Vec::new(),
            message: "Merge aborted — back to the pre-merge state.".into(),
            backup_ref: None,
            blocked_by_local_changes: false,
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
///
/// Opens the repo with git2, then shells out to `git merge --squash` — a
/// real merge computation (tree diffing, index staging, possibly a
/// conflict) whose cost scales with the diff being squashed in. As a plain
/// sync fn this ran inline on Tauri's main thread, freezing the whole
/// window for as long as the squash took; `async fn` + `run_blocking` moves
/// it to Tauri's blocking-task pool.
#[tauri::command]
#[specta::specta]
pub async fn merge_squash(path: String, sha: String) -> MergeSquashResult {
    crate::blocking::run_blocking(move || {
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
    })
    .await
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
///
/// Opens the repo with git2 and shells out to `git rev-parse` then
/// `git reset --hard` — the latter a real working-tree checkout whose cost
/// scales with the tree's size. As a plain sync fn this ran inline on
/// Tauri's main thread, freezing the whole window; `async fn` +
/// `run_blocking` moves it to Tauri's blocking-task pool.
#[tauri::command]
#[specta::specta]
pub async fn merge_squash_abort(path: String) -> MergeSquashResult {
    crate::blocking::run_blocking(move || {
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
    })
    .await
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
///
/// Opens the repo with git2 and shells out to `git diff --name-only
/// --diff-filter=U` (via `unmerged_files`) to check whether every conflict
/// is really resolved — a status read whose cost scales with the size of
/// the diff/index being checked. As a plain sync fn this ran inline on
/// Tauri's main thread; `async fn` + `run_blocking` moves it off it.
#[tauri::command]
#[specta::specta]
pub async fn merge_squash_continue(path: String) -> MergeSquashResult {
    crate::blocking::run_blocking(move || {
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
    })
    .await
}

// ---------------------------------------------------------------------------
// Multi-branch merge: octopus (one commit, ANY conflict aborts the whole
// thing outright) or sequential (a queue of ordinary pairwise merges, one per
// call, each individually resolvable exactly like `merge_start`'s own
// conflicts). See `merge_start_multi`'s own doc comment for the full design
// and the empirical trail behind octopus's conflict handling.
// ---------------------------------------------------------------------------

/// `<git-dir>/gitgui/merge-queue.json` — same sidecar convention as
/// `MergeSquashConflictState` above / git_rebase.rs's `rebase-todo/` (repo-
/// scoped, inspectable, cleaned up the same way — see that module's own
/// comment for why NOT `std::env::temp_dir()`).
///
/// `current` is the sha presently being merged — written BEFORE that merge
/// runs (see `merge_start_multi`/`merge_queue_continue`), so a crash
/// mid-attempt still leaves the queue recoverable, the same "snapshot/persist
/// before every mutating step" discipline this module's doc comment
/// describes, applied to the sidecar itself. `remaining` is every sha not yet
/// attempted; `done` is every sha already merged cleanly. `strategy` is
/// captured ONCE at queue start and reused for every step, so a later
/// `merge_queue_continue` call never has to be passed it again.
///
/// `head_before_current` is HEAD's sha at the moment `current` was set —
/// ADVERSARIALLY-FOUND FIX: `merge_queue_continue`'s only way to tell "the
/// previous step is finished" is that the repo looks clean (no MERGE_HEAD, no
/// unmerged files). But that's ALSO true when `current`'s merge was aborted
/// via the ordinary Resolver "Abort merge" button (not `merge_queue_abort`,
/// the only thing that clears this sidecar) or when it errored outright
/// (e.g. an `--ff-only` refusal, which never mutates anything) — in both
/// cases `current` was never actually merged, yet the old code unconditionally
/// promoted it into `done` and moved on, silently reporting a branch as
/// merged when it wasn't. Comparing HEAD now against `head_before_current`
/// tells the two cases apart: HEAD only moves on a genuine merge commit or
/// fast-forward, never on an abort or a no-op error.
#[derive(Serialize, Deserialize)]
struct MergeQueueState {
    current: Option<String>,
    head_before_current: Option<String>,
    remaining: Vec<String>,
    done: Vec<String>,
    strategy: Option<String>,
}

/// HEAD's current commit sha, or `None` for an unborn/detached-with-no-target
/// HEAD (a multi-branch merge queue can't meaningfully be mid-flight in that
/// state anyway — merging always requires a base commit to merge onto).
fn head_sha(repo: &Repository) -> Option<String> {
    repo.head().ok()?.target().map(|oid| oid.to_string())
}

fn merge_queue_state_path(repo: &Repository) -> std::path::PathBuf {
    repo.path().join("gitgui").join("merge-queue.json")
}

/// Best-effort write: losing this sidecar mid-queue would only degrade
/// `merge_queue_continue`/`merge_queue_status`'s recovery UX (the in-flight
/// merge itself, if any, is still resolvable/abortable by hand) — mirrors
/// `write_merge_squash_conflict_state`'s own reasoning above.
fn write_merge_queue_state(repo: &Repository, st: &MergeQueueState) {
    let p = merge_queue_state_path(repo);
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string(st) {
        let _ = fs::write(p, s);
    }
}

fn read_merge_queue_state(repo: &Repository) -> Option<MergeQueueState> {
    let data = fs::read_to_string(merge_queue_state_path(repo)).ok()?;
    serde_json::from_str(&data).ok()
}

fn clear_merge_queue_state(repo: &Repository) {
    let _ = fs::remove_file(merge_queue_state_path(repo));
}

/// Result of `merge_queue_status` — a plain read, mirrors git_bisect.rs's own
/// `BisectStatus`: always returns a value (`in_progress:false` + empty vecs
/// when no queue is active), never `Option`/`null`, so the frontend can call
/// this unconditionally both on repo-open (recovery, mirroring
/// `bisectCtrl.probeOnOpen`) and after every queue step (to decide whether to
/// keep going or the queue is already finished).
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeQueueStatus {
    pub in_progress: bool,
    pub current: Option<String>,
    pub remaining: Vec<String>,
    pub done: Vec<String>,
}

const IDLE_QUEUE_STATUS: MergeQueueStatus = MergeQueueStatus {
    in_progress: false,
    current: None,
    remaining: Vec::new(),
    done: Vec::new(),
};

/// Reject an unknown mode up front with a clean message — `"octopus"` |
/// `"sequential"` only.
fn validate_mode(mode: &str) -> Result<(), String> {
    if mode == "octopus" || mode == "sequential" {
        Ok(())
    } else {
        Err(format!(
            "Unknown merge mode {mode:?} (expected \"octopus\" or \"sequential\")."
        ))
    }
}

/// Start a multi-branch merge — every sha in `shas` merges INTO the current
/// branch (HEAD), same "source(s) onto HEAD" semantics as `merge_start`.
/// `mode` picks:
///
/// - `"octopus"`: ONE real `git merge` invocation naming every sha (git picks
///   the octopus strategy automatically for >1 non-HEAD ref) — a single merge
///   commit with every sha as a parent, exactly like running the equivalent
///   `git merge` by hand. EMPIRICALLY VERIFIED (git 2.53.0) this can conflict
///   in two genuinely different ways depending on internal per-branch trial
///   order that a caller has no reliable way to predict up front: if the LAST
///   sha in the list is the one whose merge conflicts, git leaves an ordinary
///   resolvable conflict (MERGE_HEAD naming every sha, normal unmerged index
///   entries — indistinguishable from a plain two-way merge conflict once
///   left in that state); if instead ANY EARLIER sha's merge conflicts, git
///   refuses the WHOLE octopus merge outright ("Should not be doing an
///   octopus.", exit 2, nothing mutated at all, no MERGE_HEAD, tree
///   untouched). Exposing that split to users would be needlessly confusing —
///   which case you land in depends on internal trial order, not anything the
///   user chose — so BOTH are treated identically here: any octopus failure
///   runs `git merge --abort` (a harmless no-op in the exit-2 case, where
///   there was never anything to abort) and reports one honest
///   `state:"octopus-conflict-unsupported"` — git's octopus strategy can't
///   resolve a conflict across more than two heads in a way this app can
///   safely surface; retry as Sequential instead.
/// - `"sequential"`: a queue of ordinary pairwise merges, one call at a time.
///   THIS call merges ONLY `shas[0]` (an ordinary `merge_start`-shaped call —
///   snapshot included, via the shared `merge_one`) and persists a
///   [`MergeQueueState`] sidecar recording the rest BEFORE attempting it, so a
///   conflict on this very first step is still resolvable exactly like any
///   other merge conflict, and a crash mid-attempt leaves the queue
///   recoverable. [`merge_queue_continue`] advances through `shas[1..]`, one
///   sha at a time.
///
/// Both modes refuse up front (no mutation) if fewer than two shas are given
/// — "multi-branch merge" always means at least two — or if a real merge or
/// another sequential queue is already in progress.
///
/// `strategy` (same three values `merge_start` takes) applies to every
/// sequential step (captured once in the sidecar, reused by every
/// `merge_queue_continue` call); ignored for octopus — git has no fast-
/// forward/no-ff concept across more than one non-HEAD ref, the result is
/// always a real merge commit once there's more than one.
///
/// JS: `invoke("merge_start_multi", { path, shas, mode, strategy })`.
///
/// Opens the repo with git2 and, via `merge_octopus`/`merge_one`, shells out
/// to a real `git merge` (possibly across many branches at once, in octopus
/// mode) — tree diffing and a working-tree checkout whose cost scales with
/// the repo. As a plain sync fn this ran inline on Tauri's main thread,
/// freezing the whole window; `async fn` + `run_blocking` fixes that.
#[tauri::command]
#[specta::specta]
pub async fn merge_start_multi(path: String, shas: Vec<String>, mode: String, strategy: Option<String>) -> MergeResult {
    crate::blocking::run_blocking(move || {
        if let Err(e) = validate_mode(&mode) {
            return MergeResult::error(e);
        }
        if shas.len() < 2 {
            return MergeResult::error("Pick at least two branches to merge.");
        }
        for sha in &shas {
            if let Err(e) = validate_sha(sha) {
                return MergeResult::error(e);
            }
        }
        let repo = match crate::trust::open_repo(&path) {
            Ok(r) => r,
            Err(e) => return MergeResult::error(format!("Cannot open repository: {}", e.message())),
        };
        if in_progress(&repo) {
            return MergeResult::error("A merge is already in progress — resolve or abort it first.");
        }
        if read_merge_queue_state(&repo).is_some() {
            return MergeResult::error(
                "A sequential merge queue is already in progress — continue or abort it first.",
            );
        }

        if mode == "octopus" {
            return merge_octopus(&repo, &path, &shas);
        }

        // sequential — validate the strategy before writing anything.
        let extra_flag = match parse_strategy(strategy.as_deref()) {
            Ok(f) => f,
            Err(e) => return MergeResult::error(e),
        };
        write_merge_queue_state(
            &repo,
            &MergeQueueState {
                current: Some(shas[0].clone()),
                head_before_current: head_sha(&repo),
                remaining: shas[1..].to_vec(),
                done: Vec::new(),
                strategy,
            },
        );
        let result = merge_one(&repo, &path, &shas[0], extra_flag);
        settle_queue_step(&repo, &shas[0], &result);
        result
    })
    .await
}

/// One octopus attempt — see `merge_start_multi`'s own doc comment for the
/// full empirical trail on why any failure (either shape git can produce) is
/// treated identically here.
fn merge_octopus(repo: &Repository, path: &str, shas: &[String]) -> MergeResult {
    let backup = match crate::safety::snapshot(repo) {
        Ok(b) => b,
        Err(e) => return MergeResult::error(format!("Safety snapshot failed, aborting: {e}")),
    };
    let mut args: Vec<&str> = vec!["merge", "--no-edit", "--no-autostash", "--end-of-options"];
    for sha in shas {
        args.push(sha);
    }
    let out = match git(path, &args, true) {
        Ok(o) => o,
        Err(e) => {
            return MergeResult {
                ok: false,
                state: "error".into(),
                conflicted_files: Vec::new(),
                message: e,
                backup_ref: Some(backup),
                blocked_by_local_changes: false,
            }
        }
    };
    if !out.ok {
        let label = shas.join(", ");
        // ADVERSARIALLY-FOUND FIX: an ordinary pre-flight refusal (a dirty
        // working tree or staged-index collision — the SAME detection
        // git_pick.rs's own `blocked_by_local_changes` uses) never even
        // attempts a merge, so it isn't the octopus-strategy limitation this
        // function otherwise handles — Sequential mode would refuse
        // identically on its very first step for the same reason, so "try
        // Sequential instead" would be actively misleading advice. Route it
        // through the ordinary classify() error path instead, which already
        // sets `blocked_by_local_changes` correctly (mirrors `merge_start`'s
        // own identical dirty-tree case).
        if blocked_by_local_changes(&out.stderr) {
            return classify(repo, path, &out, Some(backup), &label);
        }
        // EMPIRICALLY VERIFIED: `git merge --abort` succeeds when there's a
        // real MERGE_HEAD to undo (the "conflict on the last sha" shape), and
        // is simply never needed when the exit-2 refusal already left nothing
        // mutated (the "conflict on an earlier sha" shape) — only attempt it
        // when something is actually in progress.
        if in_progress(repo) {
            let _ = git(path, &["merge", "--abort"], false);
            // ADVERSARIALLY-FOUND FIX: the abort's own exit code was
            // previously discarded, so a failed abort (hook rejection, lock
            // contention, permissions) used to still report "merge aborted,
            // nothing changed" while real conflict markers were sitting in
            // the tree, with no `state:"conflict"` to ever open the Resolver
            // over them. Re-check the repo directly (this module's own
            // "verify by inspecting state, never trust stdout alone"
            // discipline — see `classify`) rather than trusting the abort's
            // exit code: if it's STILL in progress, the abort didn't take —
            // fall back to the ordinary conflict path so the Resolver can
            // still open and let the user fix it by hand.
            if in_progress(repo) {
                return classify(repo, path, &out, Some(backup), &label);
            }
        }
        return MergeResult {
            ok: false,
            state: "octopus-conflict-unsupported".into(),
            conflicted_files: Vec::new(),
            message: format!(
                "Octopus merge of {label} hit a conflict git can't resolve across more than two \
                 branches at once — merge aborted, nothing changed. Try Sequential instead."
            ),
            backup_ref: Some(backup),
            blocked_by_local_changes: false,
        };
    }
    classify(repo, path, &out, Some(backup), &shas.join(", "))
}

/// After a sequential step's merge attempt, fold the outcome into the queue
/// sidecar: a conflict/error leaves it untouched (`current` is still the sha
/// that needs resolving/retrying); a clean/empty result moves `sha` from
/// `current` into `done`, and deletes the sidecar entirely once nothing is
/// left in `remaining` — the whole queue is finished.
fn settle_queue_step(repo: &Repository, sha: &str, result: &MergeResult) {
    if result.state != "clean" && result.state != "empty" {
        return;
    }
    let Some(mut st) = read_merge_queue_state(repo) else {
        return;
    };
    st.done.push(sha.to_string());
    st.current = None;
    if st.remaining.is_empty() {
        clear_merge_queue_state(repo);
    } else {
        write_merge_queue_state(repo, &st);
    }
}

/// Advance a sequential merge queue by one step: verify the current step is
/// genuinely finished (no in-progress merge, no unmerged files — the queue
/// analogue of `rebase_continue`'s own precondition-then-advance shape, just
/// phrased for "the LAST step must already be done" rather than "a step IS in
/// progress"), pop the next sha off `remaining`, persist that BEFORE
/// attempting it (the same crash-recoverable ordering `merge_start_multi`
/// uses for the first step), and merge it with the SAME strategy the queue
/// started with.
///
/// If `current` is still set at this point, its own step is what needs
/// settling before advancing. A clean repo at this point is ambiguous on its
/// own — ADVERSARIALLY-FOUND BUG this fixes: it's equally true whether the
/// user genuinely resolved `current`'s conflict via the ordinary
/// `resolve_conflict_file`/`resolve_conflict_hunks` + `merge_continue`
/// commands (which know nothing about this sidecar), OR `current`'s merge was
/// aborted via the plain Resolver "Abort merge" button (not
/// `merge_queue_abort`, the only thing that clears this sidecar), OR it
/// errored outright (e.g. an `--ff-only` refusal) and never mutated anything
/// at all — the old code promoted `current` into `done` unconditionally in
/// EVERY one of these cases, silently reporting an unmerged branch as merged.
/// Comparing HEAD now against `head_before_current` (see that field's own doc
/// comment) tells them apart: only a genuine merge conclusion moves HEAD. If
/// HEAD hasn't moved, `current` is RETRIED instead — the honest behavior for
/// "the previous attempt never actually happened".
///
/// JS: `invoke("merge_queue_continue", { path })`.
///
/// Opens the repo with git2, checks unmerged state via `git diff
/// --name-only --diff-filter=U`, and — to advance the queue — shells out to
/// a real `git merge` via `merge_one`, whose cost scales with the branch
/// being merged. As a plain sync fn this ran inline on Tauri's main thread,
/// freezing the whole window; `async fn` + `run_blocking` fixes that.
#[tauri::command]
#[specta::specta]
pub async fn merge_queue_continue(path: String) -> MergeResult {
    crate::blocking::run_blocking(move || {
        let repo = match crate::trust::open_repo(&path) {
            Ok(r) => r,
            Err(e) => return MergeResult::error(format!("Cannot open repository: {}", e.message())),
        };
        let Some(mut st) = read_merge_queue_state(&repo) else {
            return MergeResult::error("No sequential merge queue in progress.");
        };
        if in_progress(&repo) || !unmerged_files(&path).is_empty() {
            return MergeResult::error("Finish resolving the current merge first.");
        }
        if let Some(cur) = st.current.clone() {
            if head_sha(&repo) == st.head_before_current {
                // HEAD hasn't moved since `current` was set — it was never
                // actually merged (aborted out of band, or errored outright).
                // Retry it rather than silently marking it done and skipping on.
                let extra_flag = match parse_strategy(st.strategy.as_deref()) {
                    Ok(f) => f,
                    Err(e) => return MergeResult::error(e),
                };
                let result = merge_one(&repo, &path, &cur, extra_flag);
                settle_queue_step(&repo, &cur, &result);
                return result;
            }
            st.current = None;
            st.done.push(cur);
        }
        if st.remaining.is_empty() {
            // Nothing left to advance to. This IS the success path when the sha
            // just promoted above was the queue's LAST one, resolved via a
            // conflict (a clean/empty step instead reaches here with `current`
            // already `None` and `remaining` already empty — `settle_queue_step`
            // clears the sidecar the moment that happens, so this call wouldn't
            // even find one — see the `else` above). Report it as the ordinary
            // "clean" a caller already knows how to route (close + reload +
            // cheer), same as any other finished merge.
            clear_merge_queue_state(&repo);
            return MergeResult {
                ok: true,
                state: "clean".into(),
                conflicted_files: Vec::new(),
                message: "Sequential merge queue complete.".into(),
                backup_ref: None,
                blocked_by_local_changes: false,
            };
        }
        let next = st.remaining.remove(0);
        st.current = Some(next.clone());
        st.head_before_current = head_sha(&repo);
        write_merge_queue_state(&repo, &st);

        let extra_flag = match parse_strategy(st.strategy.as_deref()) {
            Ok(f) => f,
            Err(e) => return MergeResult::error(e),
        };
        let result = merge_one(&repo, &path, &next, extra_flag);
        settle_queue_step(&repo, &next, &result);
        result
    })
    .await
}

/// Cancel a sequential merge queue: best-effort abort any conflict on the
/// CURRENT step (reuses `merge_abort` verbatim — idempotent, a safe no-op if
/// nothing is actually mid-merge; if it's genuinely in progress and abort
/// itself fails, surface that error and leave the sidecar alone rather than
/// silently claiming "cancelled" while conflict markers are still sitting in
/// the tree), then delete the sidecar. Branches already merged cleanly
/// (`done`) are NOT rolled back — mirrors `rebase_abort`/`merge_abort`'s own
/// scope (undo only the live in-progress op, never history already
/// committed); a user who wants the whole sequence undone has the pre-queue
/// Safety Manager snapshot for that (see this module's doc comment: merges
/// rely on the snapshot as their only safety net, by design).
///
/// JS: `invoke("merge_queue_abort", { path })`.
///
/// Opens the repo with git2 and, when the current step is still mid-merge,
/// shells out via `merge_abort_impl` to `git merge --abort` — a real
/// working-tree checkout whose cost scales with the tree's size. As a plain
/// sync fn this ran inline on Tauri's main thread, freezing the whole
/// window; `async fn` + `run_blocking` moves it to Tauri's blocking pool.
#[tauri::command]
#[specta::specta]
pub async fn merge_queue_abort(path: String) -> MergeResult {
    crate::blocking::run_blocking(move || {
        let repo = match crate::trust::open_repo(&path) {
            Ok(r) => r,
            Err(e) => return MergeResult::error(format!("Cannot open repository: {}", e.message())),
        };
        if read_merge_queue_state(&repo).is_none() {
            return MergeResult {
                ok: true,
                state: "clean".into(),
                conflicted_files: Vec::new(),
                message: "No sequential merge queue in progress.".into(),
                backup_ref: None,
                blocked_by_local_changes: false,
            };
        }
        if in_progress(&repo) {
            let r = merge_abort_impl(&repo, &path);
            if r.state != "clean" {
                return r;
            }
        }
        clear_merge_queue_state(&repo);
        MergeResult {
            ok: true,
            state: "clean".into(),
            conflicted_files: Vec::new(),
            message: "Sequential merge queue cancelled — branches already merged are kept.".into(),
            backup_ref: None,
            blocked_by_local_changes: false,
        }
    })
    .await
}

/// Read-only queue status. See [`MergeQueueStatus`]'s own doc comment for the
/// two uses (reopen-recovery + the frontend's own "keep going or stop?"
/// check).
///
/// JS: `invoke("merge_queue_status", { path })`.
///
/// Opens the repo with git2 (mirrors `bisect_status`'s own precedent: a
/// repo-open, even for a small sidecar read, still goes through git2 and is
/// polled repeatedly — after every queue step and on repo-open recovery).
/// `async fn` + `run_blocking` keeps that off Tauri's main thread, matching
/// every other command in this module rather than being the one exception.
#[tauri::command]
#[specta::specta]
pub async fn merge_queue_status(path: String) -> MergeQueueStatus {
    crate::blocking::run_blocking(move || {
        let repo = match crate::trust::open_repo(&path) {
            Ok(r) => r,
            Err(_) => return IDLE_QUEUE_STATUS,
        };
        match read_merge_queue_state(&repo) {
            Some(st) => MergeQueueStatus {
                in_progress: true,
                current: st.current,
                remaining: st.remaining,
                done: st.done,
            },
            None => IDLE_QUEUE_STATUS,
        }
    })
    .await
}
