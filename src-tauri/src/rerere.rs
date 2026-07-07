//! Rerere (reuse recorded resolution) panel support — M5a.
//!
//! `git rerere` has NO libgit2 API at all: it is a CLI-only porcelain feature
//! (recorded state lives in plain files under `<git-common-dir>/rr-cache/` and
//! is only ever read/written by the `git` binary itself). So unlike the rest
//! of GitCat's read path, [`rerere_status`] shells out to the git CLI for the
//! *live* pieces (`git config`, `git rerere status`/`remaining`) even though it
//! never mutates anything — there is simply no other way to ask. git2 is used
//! only to open the repo (existence check) and to resolve the shared
//! "common dir" (`Repository::commondir()`), which matters for a linked
//! worktree — rr-cache is shared repo-wide, not per-worktree.
//!
//! [`rerere_set_enabled`] is the one WRITE here, and it is a plain config
//! write (`git config rerere.enabled true|false`, always repo-LOCAL, never
//! `--global`) — non-destructive metadata that touches no ref/history, so per
//! the safety-model convention (see safety.rs's doc comment on what needs a
//! snapshot) it does NOT snapshot first.
//!
//! ## What was empirically verified (throwaway repos, real `git`, see
//! `tests/rerere.rs`) vs. what the OLD static mockup implied:
//!
//!   * **Effective enabled-state has two sources, and git document this
//!     itself** (`git help rerere`): an explicit `rerere.enabled` config value
//!     (local or global — `git config --get` already resolves the usual
//!     precedence) wins outright; when UNSET, git instead defaults to enabled
//!     iff `<git-common-dir>/rr-cache` already exists (e.g. a previous rerere
//!     run created it). `RerereStatus` surfaces BOTH `configured` (the
//!     explicit value, if any) and `cacheDirPresent` so the toggle UI can
//!     explain an "on" state the user never explicitly asked for.
//!   * **A cache entry's hash id is content-addressed by the CONFLICT HUNK,
//!     not by file path.** Two totally different files that happen to produce
//!     byte-identical conflict markers land in the SAME `rr-cache/<id>/`
//!     directory. There is no general hash->path mapping once history moves on.
//!   * **A path is only ever nameable while the conflict is LIVE.** `git
//!     rerere status` lists every path rerere is tracking for the in-progress
//!     merge/cherry-pick/rebase/revert (resolved or not); `git rerere
//!     remaining` lists only the still-unmerged subset. A path in the former
//!     but not the latter has been auto-resolved (or hand-resolved + staged).
//!     This is the ONLY situation [`RererePath`] entries exist.
//!   * **`<git-common-dir>/rr-cache` can exist with ZERO recorded
//!     resolutions** — not a reliable "history exists" signal by itself.
//!   * **There is no native "reused N×" counter.** git does not track how
//!     many times a cache entry has been replayed anywhere. This struct
//!     reports `resolved: bool` instead of inventing a count.
//!   * **`postimage`-less entries are real** and mean "recorded but not (yet)
//!     hand-resolved" — only a `preimage` exists then; `resolved` is `false`.

use std::collections::HashSet;
use std::path::Path;

use git2::Repository;
use serde::Serialize;

use crate::git_write::WriteResult;
use crate::safety::{self, GitOut};

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// One historical resolution recorded under `<git-common-dir>/rr-cache/<id>/`.
/// `id` is the cache directory name — a hash of the conflict hunk's content,
/// NOT of the file it came from. `resolved` is true once a `postimage` file
/// exists; false while only a `preimage` exists (conflict seen, never
/// resolved — e.g. an aborted merge).
///
/// `path` is deliberately NOT a field here: once a conflict is no longer live,
/// git itself has no mapping from a cache id back to a file path. See
/// [`RererePath`] for the one case a path IS actually derivable.
#[derive(Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RerereEntry {
    pub id: String,
    pub resolved: bool,
}

/// A path rerere is tracking for the CURRENTLY in-progress conflict. Only
/// populated while a conflict is live.
#[derive(Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RererePath {
    pub path: String,
    pub resolved: bool,
}

/// Result of [`rerere_status`].
#[derive(Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RerereStatus {
    /// The EFFECTIVE state: what git will actually do on the next conflict.
    /// `configured.unwrap_or(cacheDirPresent)`.
    pub enabled: bool,
    /// The explicit `rerere.enabled` value git resolves (local/global,
    /// whichever wins), or `None` if never set anywhere.
    pub configured: Option<bool>,
    /// Whether `<git-common-dir>/rr-cache` exists — the fallback git itself
    /// uses when `configured` is `None`.
    pub cache_dir_present: bool,
    /// Historical rr-cache entries (hash + resolved-status only).
    pub entries: Vec<RerereEntry>,
    /// True while a merge/cherry-pick/rebase/revert conflict is in progress
    /// AND rerere is tracking at least one path for it.
    pub live_conflict: bool,
    /// Paths for the live conflict; always empty when `live_conflict` is false.
    pub live_paths: Vec<RererePath>,
}

// ---------------------------------------------------------------------------
// Command: rerere_status (READ-ONLY — see module doc for why this shells out)
// ---------------------------------------------------------------------------

/// JS: `invoke("rerere_status", { path })`.
#[tauri::command]
#[specta::specta]
pub fn rerere_status(path: String) -> Result<RerereStatus, String> {
    let repo = Repository::open(&path).map_err(|e| format!("cannot open repository: {}", e.message()))?;
    // `commondir()`, not `path()`: in a linked worktree `path()` is the
    // worktree-private gitdir, but rr-cache is shared repo-wide.
    let common_dir = repo.commondir().to_path_buf();

    let configured = read_configured(&path);
    let cache_dir_present = common_dir.join("rr-cache").is_dir();
    let enabled = configured.unwrap_or(cache_dir_present);

    let entries = read_cache_entries(&common_dir);
    let (live_conflict, live_paths) = read_live_paths(&path);

    Ok(RerereStatus { enabled, configured, cache_dir_present, entries, live_conflict, live_paths })
}

/// The explicit `rerere.enabled` value git resolves (`--type=bool` normalizes
/// "yes"/"on"/"1"/… to canonical "true"/"false"), or `None` if unset anywhere
/// — `git config --get` exits non-zero with no stdout in that case, which we
/// do not treat as an error.
fn read_configured(path: &str) -> Option<bool> {
    let out = safety::run_git(path, &["config", "--type=bool", "--get", "rerere.enabled"]).ok()?;
    if !out.ok {
        return None; // unset (exit 1) — not a real error
    }
    match out.stdout.trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// Walk `<common_dir>/rr-cache/*` directly (there is no git plumbing command
/// that lists cache entries). Best-effort: a missing/unreadable directory
/// just yields no entries rather than an error.
fn read_cache_entries(common_dir: &Path) -> Vec<RerereEntry> {
    let cache_dir = common_dir.join("rr-cache");
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&cache_dir) else {
        return out;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let Some(id) = p.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        out.push(RerereEntry { id: id.to_string(), resolved: p.join("postimage").is_file() });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// `git rerere status` (all tracked paths for the live conflict) vs. `git
/// rerere remaining` (still-unmerged subset) — both print nothing (exit 0)
/// when nothing is in progress.
fn read_live_paths(path: &str) -> (bool, Vec<RererePath>) {
    let status_paths = run_lines(path, &["rerere", "status"]);
    let remaining: HashSet<String> = run_lines(path, &["rerere", "remaining"]).into_iter().collect();
    let live_conflict = !status_paths.is_empty();
    let live_paths = status_paths
        .into_iter()
        .map(|p| {
            let resolved = !remaining.contains(&p);
            RererePath { path: p, resolved }
        })
        .collect();
    (live_conflict, live_paths)
}

/// Run a git command, returning its stdout as trimmed non-empty lines. A
/// spawn failure or non-zero exit yields an empty list rather than an error —
/// this backs a read-only status display, never a mutation.
fn run_lines(path: &str, args: &[&str]) -> Vec<String> {
    match safety::run_git(path, args) {
        Ok(out) if out.ok => out.stdout.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect(),
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Command: rerere_set_enabled (WRITE — config only, no snapshot; see module doc)
// ---------------------------------------------------------------------------

/// Toggle `rerere.enabled` for THIS repository only (never `--global`). JS:
/// `invoke("rerere_set_enabled", { path, enabled })`.
#[tauri::command]
#[specta::specta]
pub fn rerere_set_enabled(path: String, enabled: bool) -> WriteResult {
    if let Err(e) = Repository::open(&path) {
        return WriteResult { ok: false, message: format!("Cannot open repository: {}", e.message()), backup_ref: None };
    }
    let value = if enabled { "true" } else { "false" };
    match safety::run_git(&path, &["config", "rerere.enabled", value]) {
        Ok(out) if out.ok => WriteResult {
            ok: true,
            message: format!("rerere {} for this repository.", if enabled { "enabled" } else { "disabled" }),
            backup_ref: None,
        },
        Ok(out) => WriteResult { ok: false, message: err_msg(&out), backup_ref: None },
        Err(e) => WriteResult { ok: false, message: e, backup_ref: None },
    }
}

/// Best human message from a failed git run (prefer stderr).
fn err_msg(o: &GitOut) -> String {
    if !o.stderr.is_empty() {
        o.stderr.clone()
    } else if !o.stdout.is_empty() {
        o.stdout.clone()
    } else {
        format!("git exited with status {}", o.code)
    }
}
