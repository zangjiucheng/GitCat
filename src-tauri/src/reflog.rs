//! Reflog rescue (M4) — read HEAD's reflog and restore to any historical entry.
//!
//! Read/write split, as everywhere else: [`reflog`] is pure git2 (read-only).
//! [`reflog_restore`] is a MUTATION (moves HEAD / the current branch), so it
//! follows the exact safety invariants [`crate::safety::undo`] established:
//! fail-closed on a dirty tree, snapshot the CURRENT state first (so the
//! restore is itself undoable), then move via the git CLI (never libgit2) for
//! the actual ref/worktree mutation.
//!
//! Index convention (CRITICAL, verified empirically against `git reflog show
//! HEAD` on a throwaway repo — see `tests/reflog.rs`): git2's
//! `Reflog::get(i)` / `Reflog::iter()` already returns index 0 = the most
//! recently created entry, matching `HEAD@{0}` addressing. For the entry at
//! index i, `HEAD@{i}` resolves to that entry's **new** oid
//! (`entry.id_new()`), NOT its old oid — `old_oid` is where HEAD moved FROM
//! at that step (i.e. it equals the new_oid of entry i+1), so reading it
//! would off-by-one every mapping.
//!
//! Why `reflog_restore` duplicates the dirty-tree-guard + snapshot-then-move
//! logic from `safety::undo` instead of calling into it: `undo()`'s target is
//! always the newest *safety snapshot* (with an optional full local-branch
//! topology map recorded at snapshot time, so it can restore/rename/delete
//! branches — see M2c). A reflog entry has no such topology map; it only ever
//! records where HEAD (and, when attached, the current branch) pointed. So
//! the correct restore here is simply "reset the current branch/HEAD to this
//! historical sha" — precisely `git reset --hard <sha>`, with no branch-
//! topology reconciliation to perform. Reusing `undo()`'s topology-aware path
//! would either silently do nothing useful with an empty map (fine, but then
//! why call through it) or require threading a fake target through the
//! snapshot ref format it expects (awkward and fragile). Duplicating the
//! ~15-line guard clauses is safer than bending `undo()`'s shape to fit a
//! different kind of target. The core three invariants are kept byte-for-byte
//! equivalent to `undo()`: dirty-tree fail-closed, seal-current-state-first,
//! plain-struct failure (never a JS rejection).

use git2::Repository;
use serde::Serialize;

use crate::safety::{self, UndoResult};

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// One HEAD reflog entry, newest first (`index` == the `HEAD@{index}` you'd
/// pass to plain git). `kind` is a best-effort coarse category derived from
/// `message`'s leading word, purely for a nicer icon in the UI — not a
/// guarantee every git reflog message shape is recognized.
#[derive(Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    pub index: usize,
    pub sha: String,             // short (7-char) sha of entry.id_new()
    pub message: String,         // raw reflog message, e.g. "commit: Wire login form to API"
    pub kind: String,             // "commit" | "reset" | "checkout" | "rebase" | "cherry-pick" | "merge" | "branch" | "pull" | "other"
    pub committer_name: String,
    pub committer_email: String,
    pub ts: i64,                 // unix seconds
}

// ---------------------------------------------------------------------------
// Tauri commands (registered in lib.rs)
// ---------------------------------------------------------------------------

/// Read HEAD's reflog, newest first. Read-only (git2).
///
/// JS: `commands.reflog(path)` -> `Result<ReflogEntry[], string>`.
#[tauri::command]
#[specta::specta]
pub fn reflog(path: String) -> Result<Vec<ReflogEntry>, String> {
    let repo = open(&path)?;
    read_reflog(&repo)
}

/// Restore HEAD (and the current branch, if attached) to the commit recorded
/// at `HEAD@{index}`. A plain-struct result (like `safety::undo`) — failure is
/// `ok:false` + a message, never a JS rejection, so the UI can always show why.
///
/// Invariants (identical to `safety::undo`):
///  1. Refuses on a dirty working tree (a `reset --hard` would silently
///     discard uncommitted work) — never forced.
///  2. Snapshots the CURRENT state FIRST, so this restore is itself undoable
///     via the normal global Undo afterward.
///  3. Re-validates `index` against a FRESH reflog read (the reflog can
///     change between the list render and the restore click — a stale index
///     must never silently land on the wrong commit).
///
/// JS: `commands.reflogRestore(path, index)` -> `UndoResult`.
#[tauri::command]
#[specta::specta]
pub fn reflog_restore(path: String, index: usize) -> UndoResult {
    let repo = match open(&path) {
        Ok(r) => r,
        Err(e) => return fail(e),
    };

    let workdir = match repo.workdir().and_then(|p| p.to_str()) {
        Some(w) => w.to_string(),
        None => return fail("Restore needs a working tree (bare repo not supported)".into()),
    };

    // (1) Dirty-tree fail-closed guard — same as undo(): never force.
    let dirty = match safety::run_git(&workdir, &["status", "--porcelain"]) {
        Ok(o) => o,
        Err(e) => return fail(format!("Cannot verify the working tree is clean, refusing restore: {e}")),
    };
    if !dirty.ok {
        return fail(format!("Cannot verify the working tree is clean, refusing restore: {}", dirty.stderr));
    }
    if !dirty.stdout.is_empty() {
        return fail("Working tree has uncommitted changes — commit or stash before restoring.".into());
    }

    // (3) Re-validate against a FRESH reflog read — never trust a stale index.
    let log = match repo.reflog("HEAD") {
        Ok(l) => l,
        Err(e) => return fail(format!("Cannot read HEAD reflog: {}", e.message())),
    };
    let len = log.len();
    let entry = match log.get(index) {
        Some(e) => e,
        None => {
            return fail(format!(
                "HEAD@{{{index}}} no longer exists — the reflog now has {len} entr{}. Refusing to restore a stale selection.",
                if len == 1 { "y" } else { "ies" }
            ))
        }
    };
    let target_oid = entry.id_new();
    let target_sha = target_oid.to_string();
    drop(entry);
    drop(log);

    // (2) Undo-is-undoable: seal the CURRENT state before moving anything. If
    // this fails, abort — never reset --hard with no backup of the current
    // state.
    let sealed = match safety::snapshot(&repo) {
        Ok(r) => r,
        Err(e) => return fail(format!("Restore aborted — could not snapshot current state first: {e}")),
    };

    // The actual mutation: move HEAD/current branch to the historical sha.
    // Exactly `git reset --hard <sha>` — there is no branch-topology map to
    // reconcile here (see module doc), just "HEAD used to point here".
    let reset = match safety::run_git(&workdir, &["reset", "--hard", &target_sha]) {
        Ok(o) => o,
        Err(e) => {
            return UndoResult {
                ok: false,
                message: format!("Restore failed: {e}"),
                restored_to: None,
                sealed: Some(sealed),
            }
        }
    };
    if !reset.ok {
        return UndoResult {
            ok: false,
            message: format!("Restore failed: {}", reset.stderr),
            restored_to: None,
            sealed: Some(sealed),
        };
    }

    UndoResult {
        ok: true,
        message: format!("Restored to HEAD@{{{index}}} ({}).", short(&target_sha)),
        restored_to: Some(short(&target_sha)),
        sealed: Some(sealed),
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn open(path: &str) -> Result<Repository, String> {
    Repository::open(path).map_err(|e| format!("cannot open repository: {}", e.message()))
}

fn fail(message: String) -> UndoResult {
    UndoResult { ok: false, message, restored_to: None, sealed: None }
}

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// Read HEAD's reflog newest-first. `index` == `HEAD@{index}` addressing;
/// entry i's sha is `entry.id_new()` (see module doc for why NOT `id_old()`).
fn read_reflog(repo: &Repository) -> Result<Vec<ReflogEntry>, String> {
    let log = repo
        .reflog("HEAD")
        .map_err(|e| format!("cannot read HEAD reflog: {}", e.message()))?;
    let mut out = Vec::with_capacity(log.len());
    for (i, entry) in log.iter().enumerate() {
        let sha = entry.id_new().to_string();
        let message = entry.message().unwrap_or("").to_string();
        let committer = entry.committer();
        out.push(ReflogEntry {
            index: i,
            sha: short(&sha),
            kind: classify(&message).to_string(),
            message,
            committer_name: committer.name().unwrap_or("").to_string(),
            committer_email: committer.email().unwrap_or("").to_string(),
            ts: committer.when().seconds(),
        });
    }
    Ok(out)
}

/// Best-effort coarse category from the reflog message's leading word(s), for
/// a nicer icon in the UI. Not exhaustive — unrecognized shapes fall back to
/// "other" rather than guessing.
fn classify(message: &str) -> &'static str {
    let head = message.split(':').next().unwrap_or("").trim();
    if head.starts_with("commit") {
        if head.contains("merge") {
            "merge"
        } else {
            "commit"
        }
    } else if head == "reset" {
        "reset"
    } else if head == "checkout" {
        "checkout"
    } else if head.starts_with("rebase") {
        "rebase"
    } else if head.starts_with("cherry-pick") {
        "cherry-pick"
    } else if head.starts_with("merge") {
        "merge"
    } else if head == "branch" {
        "branch"
    } else if head == "pull" {
        "pull"
    } else if head == "clone" {
        "clone"
    } else {
        "other"
    }
}
