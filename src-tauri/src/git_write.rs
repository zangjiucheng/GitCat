//! Write side of GitCat: branch operations.
//!
//! Read/write split (see git_read.rs for the read half): every MUTATION here
//! shells out to the git CLI (`git -C <path> ...`) captured via std::process,
//! because libgit2 and the porcelain can diverge and the CLI is the source of
//! truth for mutations. git2 is used only for *reading* (listing refs, resolving
//! oids, current-branch checks) — never to mutate.
//!
//! SAFETY: every mutating command calls the Safety Manager snapshot FIRST (see
//! `take_snapshot`), so a pre-op backup ref exists before git touches anything.
//! If the snapshot fails we abort and do NOT mutate.
//!
//! Failure model: write commands return a plain [`WriteResult`] (never a Rust
//! `Err`), so the JS promise always resolves. A non-zero git exit maps to
//! `ok:false` with git's trimmed stderr — e.g. a checkout onto a dirty tree
//! surfaces git's "local changes would be overwritten" verbatim; `checkout`/
//! `create_branch` never force on their own. When that specific refusal is a
//! dirty-tree collision, `WriteResult.conflicting_files` is also populated
//! (parsed from git's own stable prose — see `checkout_collision_files`), so
//! the frontend can offer backlog #34's dirty-tree resolution chooser instead
//! of a plain toast; `checkout_discard` is the one command in this module
//! that DOES force (`git switch --force`), and only when the user explicitly
//! picks that chooser's most destructive option.

use std::process::Command;

use git2::{BranchType, Repository};
use serde::Serialize;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// Uniform result of a write command. `ok:false` carries git's stderr (trimmed)
/// or a validation/precondition message.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub ok: bool,
    pub message: String,
    /// Backup ref sealed before the mutation (present on success), so the UI can
    /// name the snapshot the user can Undo to. `None` when we never got to snapshot.
    pub backup_ref: Option<String>,
    /// Repo-relative paths that made `checkout`/`create_branch(checkout:true)`
    /// refuse SPECIFICALLY because the dirty working tree/index would be
    /// overwritten by the switch — see `checkout_collision_files`. Kept
    /// semantically distinct from `WorkdirResult::conflicted_files` (which
    /// means "unresolved merge/rebase/stash index conflict"; this means "path
    /// currently in the way of a checkout, never attempted at all"). Empty on
    /// success AND on every other kind of refusal (bad ref, name collision,
    /// detached HEAD edge case, …), so the frontend can tell "show the
    /// dirty-tree resolution chooser" apart from "just show the plain error
    /// toast" without doing any prose-matching of its own.
    pub conflicting_files: Vec<String>,
}

impl WriteResult {
    fn ok(message: impl Into<String>, backup_ref: Option<String>) -> Self {
        Self { ok: true, message: message.into(), backup_ref, conflicting_files: Vec::new() }
    }
    fn err(message: impl Into<String>) -> Self {
        Self { ok: false, message: message.into(), backup_ref: None, conflicting_files: Vec::new() }
    }
    /// `backup_ref` stays `None` like every other failure in this module
    /// (convention: an atomic git command either fully succeeds or fully
    /// no-ops, so a refused one has nothing new for Undo to point at).
    fn dirty_collision(message: impl Into<String>, files: Vec<String>) -> Self {
        Self { ok: false, message: message.into(), backup_ref: None, conflicting_files: files }
    }
}

/// A local branch row for the data-driven sidebar. `ahead`/`behind` are relative
/// to the branch's configured upstream, or `None` when it has no upstream.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranch {
    pub name: String,
    pub sha: String,
    pub ahead: Option<usize>,
    pub behind: Option<usize>,
}

/// A remote-tracking branch or a tag: just a name and the commit it resolves to.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SimpleRef {
    pub name: String,
    pub sha: String,
}

/// Everything the sidebar needs. `head` is the current branch shorthand, or
/// `None` when HEAD is detached or unborn.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RefList {
    pub head: Option<String>,
    pub locals: Vec<LocalBranch>,
    pub remotes: Vec<SimpleRef>,
    pub tags: Vec<SimpleRef>,
}

// ---------------------------------------------------------------------------
// Safety Manager bridge
// ---------------------------------------------------------------------------

/// Single call site for the Safety Manager snapshot, so the exact signature of
/// the sibling `safety` module is easy to adapt. This assumes safety.rs exposes
/// `snapshot(repo: &Repository) -> Result<String, String>` returning the backup
/// ref name (e.g. "refs/gitgui/backup/<ts>"). If it instead takes a path, change
/// only this line to `crate::safety::snapshot(&repo.path().to_string_lossy())`.
fn take_snapshot(repo: &Repository) -> Result<String, String> {
    crate::safety::snapshot(repo)
}

// ---------------------------------------------------------------------------
// git CLI runner
// ---------------------------------------------------------------------------

struct GitOut {
    ok: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Run `git -C <path> <args...>` in the repo workdir, capturing stdout/stderr/exit.
/// Returns `Err` only when the process could not be spawned at all.
///
/// `LC_ALL=C`/`LANGUAGE=""` (mirrors `git_bisect.rs`/`git_revert.rs`'s own
/// exact precedent): needed so `checkout_collision_files`'s stderr
/// substring-classification below is reliable regardless of the OS locale —
/// a side effect is that `create_branch`/`delete_branch`/`rename_branch`'s
/// forwarded stderr also becomes locale-stable, a deliberate strengthening.
fn run_git(path: &str, args: &[&str]) -> Result<GitOut, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("LC_ALL", "C")
        .env("LANGUAGE", "")
        .env("GIT_PAGER", "cat")
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    Ok(GitOut {
        ok: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

/// Best available human message from a *failed* git run (prefer stderr).
fn git_error_message(out: &GitOut) -> String {
    if !out.stderr.is_empty() {
        out.stderr.clone()
    } else if !out.stdout.is_empty() {
        out.stdout.clone()
    } else {
        format!("git exited with status {:?}", out.code)
    }
}

/// Extract the paths that made a `git switch`/`git switch -c` refuse because
/// the dirty working tree/index would be overwritten. Empty when `stderr`
/// doesn't match that shape at all (some OTHER refusal — bad ref, name
/// collision, detached-HEAD edge case, …).
///
/// EMPIRICALLY VERIFIED (git 2.x, `LC_ALL=C`): git prints one-or-more
/// repeated blocks on this refusal, each a header line ending in the
/// identical literal phrase "would be overwritten by checkout:" followed by
/// one-or-more TAB-indented path lines, e.g.:
/// ```text
/// error: Your local changes to the following files would be overwritten by checkout:
/// \ta.txt
/// \tc.txt
/// Please commit your changes or stash them before you switch branches.
/// error: The following untracked working tree files would be overwritten by checkout:
/// \td.txt
/// Please move or remove them before you switch branches.
/// Aborting
/// ```
/// Both possible headers (tracked-changes vs. untracked-collision) end in
/// that same suffix, so one substring check catches every block, and since we
/// only need the UNION of colliding paths (not which block a path came from),
/// collecting every tab-indented line across the whole stderr is sufficient.
/// `create_branch`'s `checkout:true` path funnels through the identical
/// unpack-trees safety check and produces byte-identical wording, so this is
/// shared by both.
fn checkout_collision_files(stderr: &str) -> Vec<String> {
    if !stderr.contains("would be overwritten by checkout") {
        return Vec::new();
    }
    stderr
        .lines()
        .filter_map(|l| l.strip_prefix('\t'))
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Shared failure classifier for `checkout` and `create_branch`'s
/// `checkout:true` path: both run `git switch` (or `git switch -c`) and can
/// hit the identical dirty-tree collision check, so both need the identical
/// re-classification of a non-zero exit into either a plain error or a
/// `dirty_collision` (with the colliding file list attached).
fn classify_switch_failure(out: &GitOut) -> WriteResult {
    let files = checkout_collision_files(&out.stderr);
    if files.is_empty() {
        WriteResult::err(git_error_message(out))
    } else {
        WriteResult::dirty_collision(git_error_message(out), files)
    }
}

// ---------------------------------------------------------------------------
// Validation (flag/injection guard)
// ---------------------------------------------------------------------------

/// Reject anything that could be read as a flag or is not a legal branch name.
/// This is defense-in-depth: every mutation also passes `--end-of-options` so a
/// leading `-` can never be parsed as an option, but we still refuse it here so
/// the user gets a clear message instead of git's "not a valid branch name".
fn validate_branch_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Branch name is empty.".into());
    }
    if name.starts_with('-') {
        return Err(format!("Refusing a branch name that looks like a flag: {name:?}"));
    }
    for ch in name.chars() {
        if ch.is_control() || ch == ' ' || ch == '\u{7f}' {
            return Err(format!("Branch name has an illegal whitespace/control character: {name:?}"));
        }
        if matches!(ch, '~' | '^' | ':' | '?' | '*' | '[' | '\\') {
            return Err(format!("Branch name has an illegal character '{ch}': {name:?}"));
        }
    }
    if name.contains("..")
        || name.contains("@{")
        || name.contains("//")
        || name.starts_with('/')
        || name.ends_with('/')
        || name.ends_with('.')
        || name.ends_with(".lock")
        || name == "@"
    {
        return Err(format!("Not a valid branch name: {name:?}"));
    }
    Ok(())
}

/// Lighter guard for a start-point / commit-ish (may legitimately contain `~^:@{`
/// as in `main~2` or `HEAD@{1}`); we only need to stop flag injection and control
/// chars — `--end-of-options` handles the rest at the CLI boundary.
fn validate_revision(rev: &str) -> Result<(), String> {
    if rev.is_empty() {
        return Err("Start point is empty.".into());
    }
    if rev.starts_with('-') {
        return Err(format!("Refusing a start point that looks like a flag: {rev:?}"));
    }
    if rev.chars().any(|c| c.is_control()) {
        return Err("Start point has a control character.".into());
    }
    Ok(())
}

/// Trailing tail of a backup ref for a compact message, e.g.
/// "refs/gitgui/backup/1720000000-3" -> "1720000000-3".
fn short_backup(r: &str) -> String {
    r.rsplit('/').next().unwrap_or(r).to_string()
}

/// Open the repo, mapping a failure into a `WriteResult` error. Used by every
/// mutating command before it snapshots.
fn open_repo(path: &str) -> Result<Repository, WriteResult> {
    crate::trust::open_repo(path)
        .map_err(|e| WriteResult::err(format!("Cannot open repository: {}", e.message())))
}

// ---------------------------------------------------------------------------
// Read: list refs (git2)  — feeds the data-driven sidebar
// ---------------------------------------------------------------------------

/// Tauri command: list local branches (+ ahead/behind vs upstream), remote
/// branches, and tags, plus the current branch shorthand. Read-only (git2).
#[tauri::command]
#[specta::specta]
pub fn list_refs(path: String) -> Result<RefList, String> {
    list_refs_inner(&path).map_err(|e| e.message().to_string())
}

fn list_refs_inner(path: &str) -> Result<RefList, git2::Error> {
    let repo = crate::trust::open_repo(path)?;

    // Current branch shorthand; None when detached (HEAD is not a branch) or unborn.
    let head = match repo.head() {
        Ok(h) if h.is_branch() => h.shorthand().map(|s| s.to_string()),
        _ => None,
    };

    let mut locals: Vec<LocalBranch> = Vec::new();
    let mut remotes: Vec<SimpleRef> = Vec::new();
    let mut tags: Vec<SimpleRef> = Vec::new();

    for entry in repo.branches(None)? {
        let (branch, btype) = entry?;
        let name = match branch.name()? {
            Some(n) => n.to_string(),
            None => continue, // non-UTF8 branch name -> skip
        };
        let oid = match branch.get().peel_to_commit() {
            Ok(c) => c.id(),
            Err(_) => continue,
        };
        let sha = oid.to_string();
        match btype {
            BranchType::Local => {
                // ahead/behind against the configured upstream, if any.
                let (ahead, behind) = branch
                    .upstream()
                    .ok()
                    .and_then(|up| up.get().peel_to_commit().ok())
                    .and_then(|uc| repo.graph_ahead_behind(oid, uc.id()).ok())
                    .map(|(a, b)| (Some(a), Some(b)))
                    .unwrap_or((None, None));
                locals.push(LocalBranch { name, sha, ahead, behind });
            }
            BranchType::Remote => {
                if name.ends_with("/HEAD") {
                    continue; // drop the origin/HEAD symref
                }
                remotes.push(SimpleRef { name, sha });
            }
        }
    }

    // Tags (lightweight + annotated), peeled to the commit they ultimately hit.
    repo.tag_foreach(|oid, name_bytes| {
        let full = String::from_utf8_lossy(name_bytes);
        if let Some(short) = full.strip_prefix("refs/tags/") {
            let sha = repo
                .find_object(oid, None)
                .ok()
                .and_then(|o| o.peel_to_commit().ok())
                .map(|c| c.id().to_string())
                .unwrap_or_else(|| oid.to_string());
            tags.push(SimpleRef { name: short.to_string(), sha });
        }
        true // keep iterating
    })?;

    locals.sort_by(|a, b| a.name.cmp(&b.name));
    remotes.sort_by(|a, b| a.name.cmp(&b.name));
    tags.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(RefList { head, locals, remotes, tags })
}

// ---------------------------------------------------------------------------
// Writes: branch operations (each snapshots FIRST, then shells out to git)
// ---------------------------------------------------------------------------

/// Create a branch; when `checkout` is true, also switch to it (`git switch -c`).
/// `start_point` is an optional commit-ish; defaults to HEAD when omitted.
/// JS call: `invoke("create_branch", { path, name, startPoint?, checkout? })`.
#[tauri::command]
#[specta::specta]
pub fn create_branch(
    path: String,
    name: String,
    start_point: Option<String>,
    checkout: Option<bool>,
) -> WriteResult {
    if let Err(e) = validate_branch_name(&name) {
        return WriteResult::err(e);
    }
    if let Some(sp) = &start_point {
        if let Err(e) = validate_revision(sp) {
            return WriteResult::err(e);
        }
    }
    let repo = match open_repo(&path) {
        Ok(r) => r,
        Err(w) => return w,
    };
    let switch = checkout.unwrap_or(false);
    // Snapshot FIRST — never mutate without a backup — but ONLY when this
    // will actually move HEAD/the current branch (`switch`): a plain
    // `git branch <name> <start_point>` (switch:false) never touches HEAD,
    // the current branch, the index, or the working tree at all — it only
    // ever adds a new ref elsewhere, exactly like `force_push`/
    // `remove_remote`'s own "nothing local changes, so nothing needs
    // protecting" reasoning. An adversarial review of the fsck-based
    // dangling-recovery feature (which always calls this with
    // `checkout:false`) found the unconditional snapshot made recovery
    // impossible in a repo with an unborn HEAD (no commit yet on the current
    // branch — `safety::snapshot` has nothing to snapshot there) even though
    // the underlying `git branch` call is completely safe regardless of
    // HEAD's state. Skipping the snapshot for the non-switching case closes
    // that gap for every caller, not just this one.
    let backup = if switch {
        match take_snapshot(&repo) {
            Ok(b) => Some(b),
            Err(e) => return WriteResult::err(format!("Safety snapshot failed, aborting: {e}")),
        }
    } else {
        None
    };
    // -c takes <name> as its value; --end-of-options AFTER it still guards <start>.
    let mut args: Vec<&str> = if switch {
        vec!["switch", "-c", &name, "--end-of-options"]
    } else {
        vec!["branch", "--end-of-options", &name]
    };
    if let Some(sp) = &start_point {
        args.push(sp.as_str());
    }
    match run_git(&path, &args) {
        Ok(out) if out.ok => {
            let verb = if switch { "Created & switched to" } else { "Created branch" };
            let message = match &backup {
                Some(b) => format!("{verb} {name} (snapshot {}).", short_backup(b)),
                None => format!("{verb} {name}."),
            };
            WriteResult::ok(message, backup)
        }
        // When `switch` is true this can hit the same dirty-tree collision
        // `checkout` can (byte-identical wording, verified); when `switch` is
        // false this is a plain `git branch` and can never match the
        // substring, so classifying unconditionally is safe and simpler than
        // branching on `switch` here too.
        Ok(out) => classify_switch_failure(&out),
        Err(e) => WriteResult::err(e),
    }
}

/// Switch HEAD to an existing branch. Uses `git switch` (never touches
/// pathspecs, so no branch/path ambiguity). A dirty tree that would be
/// clobbered is surfaced as `ok:false` with git's message — we never force.
/// JS call: `invoke("checkout", { path, name })`.
#[tauri::command]
#[specta::specta]
pub fn checkout(path: String, name: String) -> WriteResult {
    if let Err(e) = validate_branch_name(&name) {
        return WriteResult::err(e);
    }
    let repo = match open_repo(&path) {
        Ok(r) => r,
        Err(w) => return w,
    };
    let backup = match take_snapshot(&repo) {
        Ok(b) => b,
        Err(e) => return WriteResult::err(format!("Safety snapshot failed, aborting: {e}")),
    };

    // git switch --end-of-options <name>
    match run_git(&path, &["switch", "--end-of-options", &name]) {
        Ok(out) if out.ok => WriteResult::ok(
            format!("Switched to {name} (snapshot {}).", short_backup(&backup)),
            Some(backup),
        ),
        // dirty-tree: "Your local changes ... would be overwritten by checkout"
        // (or the untracked-collision sibling) -> classify so the frontend
        // can offer the dirty-tree resolution chooser instead of a plain
        // toast; every OTHER refusal still comes back as a plain error.
        Ok(out) => classify_switch_failure(&out),
        Err(e) => WriteResult::err(e),
    }
}

/// Force-switch to `name` (optionally creating it from `start_point`,
/// mirroring `create_branch`'s own shape — needed for the sidebar's
/// `checkoutRemote`'s "new local branch tracking a remote" path), discarding
/// every local modification/untracked file in the way. This is the "Force
/// switch, discarding my changes" mode of backlog #34's dirty-tree
/// resolution chooser — the frontend must only ever call this AFTER a plain
/// `checkout`/`create_branch` attempt came back with `conflicting_files`
/// non-empty, and after showing the user that exact colliding-file list (this
/// command does not repeat it — see below).
///
/// `git switch --force` (`-f`) is the flag used, NOT `--discard-changes`:
/// EMPIRICALLY VERIFIED (see design notes) that `--discard-changes` discards
/// dirty *tracked* files fine but refuses OUTRIGHT the instant ANY untracked
/// file collides ("error: Untracked working tree file '<path>' would be
/// overwritten by merge.", exit 128, nothing touched) — so it cannot back
/// this mode's promise for the (very common) untracked-collision shape.
///
/// BLAST RADIUS — CORRECTED after an adversarial review found the first
/// draft of this comment wrong: `--force` discards every collision shape
/// (modified-tracked, staged, deleted+recreated, untracked), but for
/// TRACKED/staged content it is NOT scoped to the colliding paths alone —
/// empirically re-verified TWICE (isolated repro + a combined-dirty-shapes
/// repro) that it reverts EVERY uncommitted tracked/staged change anywhere
/// in the working tree to the target commit, including files that had
/// nothing to do with the original checkout refusal (a freshly `git add`-ed
/// file with no prior history is deleted outright). `--discard-changes` has
/// the identical scope, so this is a real property of `git switch`'s force
/// semantics, not a wrong-flag pick — there is no `git switch` mode that
/// discards only the colliding paths. Only UNTRACKED files are scoped (a
/// non-colliding untracked file survives untouched, verified) — tracked
/// content is not. This means the frontend's confirmation copy MUST warn
/// about the user's ENTIRE current uncommitted tracked/staged state, never
/// just the originally-colliding file list this command doesn't repeat.
/// `--force` does all of this completely SILENTLY (exit 0,
/// `Switched to branch 'x'`, no listing of what was clobbered).
///
/// Genuinely irreversible: this discards UNCOMMITTED content with no ref the
/// Safety Manager could ever pin it under (mirrors `discard_file`'s own
/// reasoning) — and, unlike the "stash, switch, (re)leave stashed" modes
/// (both stash-backed and fully recoverable), this deliberately writes no
/// backup of its own for the discarded content either: giving it one would
/// blur the three-tier distinction between "recoverable" and "genuinely
/// final" this feature is built around (mirrors Force Push's "override"
/// variant's own no-net-cast philosophy).
///
/// Still snapshots HEAD first, like every command in this module — NOT to
/// protect the discarded content (it can't), but for the same reason plain
/// `checkout` does: so Undo can put HEAD back on the PREVIOUS branch.
/// JS: `invoke("checkout_discard", { path, name, startPoint })`.
#[tauri::command]
#[specta::specta]
pub fn checkout_discard(path: String, name: String, start_point: Option<String>) -> WriteResult {
    if let Err(e) = validate_branch_name(&name) {
        return WriteResult::err(e);
    }
    if let Some(sp) = &start_point {
        if let Err(e) = validate_revision(sp) {
            return WriteResult::err(e);
        }
    }
    let repo = match open_repo(&path) {
        Ok(r) => r,
        Err(w) => return w,
    };
    let backup = match take_snapshot(&repo) {
        Ok(b) => b,
        Err(e) => return WriteResult::err(format!("Safety snapshot failed, aborting: {e}")),
    };

    // -c takes <name> as its value; --end-of-options AFTER it still guards <start>.
    let mut args: Vec<&str> = if start_point.is_some() {
        vec!["switch", "--force", "-c", &name, "--end-of-options"]
    } else {
        vec!["switch", "--force", "--end-of-options", &name]
    };
    if let Some(sp) = &start_point {
        args.push(sp.as_str());
    }

    match run_git(&path, &args) {
        Ok(out) if out.ok => WriteResult::ok(
            format!(
                "Force-switched to {name}, discarding local changes (snapshot {}).",
                short_backup(&backup)
            ),
            Some(backup),
        ),
        Ok(out) => WriteResult::err(git_error_message(&out)),
        Err(e) => WriteResult::err(e),
    }
}

/// Delete a branch. Refuses the current branch. `force=false` uses `git branch
/// -d` (refuses an unmerged branch -> surfaced as `ok:false`); `force=true` uses
/// `-D`. The deleted tip sha is included in the success message since M2a Undo
/// restores HEAD only (full-repo ref restore comes later).
/// JS call: `invoke("delete_branch", { path, name, force })`.
#[tauri::command]
#[specta::specta]
pub fn delete_branch(path: String, name: String, force: bool) -> WriteResult {
    if let Err(e) = validate_branch_name(&name) {
        return WriteResult::err(e);
    }
    let repo = match open_repo(&path) {
        Ok(r) => r,
        Err(w) => return w,
    };

    // Refuse to delete the checked-out branch (friendlier than git's worktree error).
    if let Ok(head) = repo.head() {
        if head.is_branch() && head.shorthand() == Some(name.as_str()) {
            return WriteResult::err(format!(
                "Cannot delete {name}: it is the current branch. Switch away first."
            ));
        }
    }

    // Capture the tip before deletion so the message can tell the user how to recreate it.
    let tip = repo
        .find_branch(&name, BranchType::Local)
        .ok()
        .and_then(|b| b.get().peel_to_commit().ok())
        .map(|c| c.id().to_string());
    let tip7 = tip.as_deref().map(|s| &s[..7.min(s.len())]);

    let backup = match take_snapshot(&repo) {
        Ok(b) => b,
        Err(e) => return WriteResult::err(format!("Safety snapshot failed, aborting: {e}")),
    };
    // Keep the deleted branch's commits reachable & recoverable (best-effort;
    // pinned under refs/gitgui/deleted/* so it is never an undo target).
    if let Some(oid) = tip.as_deref().and_then(|s| git2::Oid::from_str(s).ok()) {
        let _ = crate::safety::pin_deleted_tip(&repo, oid, &name);
    }

    let flag = if force { "-D" } else { "-d" };
    match run_git(&path, &["branch", flag, "--end-of-options", &name]) {
        Ok(out) if out.ok => {
            let msg = match tip7 {
                Some(t) => format!("Deleted branch {name} (was {t}). Recreate it with New branch → {t}."),
                None => format!("Deleted branch {name}."),
            };
            WriteResult::ok(msg, Some(backup))
        }
        // -d on an unmerged branch: "the branch '<name>' is not fully merged"
        Ok(out) => WriteResult::err(git_error_message(&out)),
        Err(e) => WriteResult::err(e),
    }
}

/// Rename a branch. Uses `git branch -m` (NOT `-M`), so it refuses to clobber an
/// existing target. Works on the current branch (git updates the HEAD symref).
/// JS call: `invoke("rename_branch", { path, from, to })`.
#[tauri::command]
#[specta::specta]
pub fn rename_branch(path: String, from: String, to: String) -> WriteResult {
    if let Err(e) = validate_branch_name(&from) {
        return WriteResult::err(e);
    }
    if let Err(e) = validate_branch_name(&to) {
        return WriteResult::err(e);
    }
    let repo = match open_repo(&path) {
        Ok(r) => r,
        Err(w) => return w,
    };
    let backup = match take_snapshot(&repo) {
        Ok(b) => b,
        Err(e) => return WriteResult::err(format!("Safety snapshot failed, aborting: {e}")),
    };

    // git branch -m --end-of-options <from> <to>
    match run_git(&path, &["branch", "-m", "--end-of-options", &from, &to]) {
        Ok(out) if out.ok => WriteResult::ok(
            format!("Renamed {from} → {to} (snapshot {}).", short_backup(&backup)),
            Some(backup),
        ),
        // e.g. "a branch named '<to>' already exists"
        Ok(out) => WriteResult::err(git_error_message(&out)),
        Err(e) => WriteResult::err(e),
    }
}
