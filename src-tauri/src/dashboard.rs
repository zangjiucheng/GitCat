//! Multi-repository dashboard (backlog #11): ONE minimal, cheap per-repo
//! status read — current branch + its OWN ahead/behind (not every branch,
//! unlike `git_write.rs`'s `list_refs`), a dirty/clean flag, and HEAD's tip
//! commit subject/time via a single `git2::Commit` lookup (NOT a revwalk —
//! see `commands.rs`'s `build_graph` doc comment for why a dashboard must
//! never trigger that per tracked repo). Read-only (git2), reusing the exact
//! `trust::open_repo` auto-trust path every other read command uses.
//!
//! Deliberately NOT a composition of `git_write::list_refs` (walks every local
//! branch + every remote + every tag just to read one branch's ahead/behind)
//! and `workdir::workdir_status` (has dirty/clean but no branch/ahead-behind/
//! last-commit at all) — that would be two IPC round-trips per tracked repo
//! and still miss "last commit"; this is one round-trip, and the only git2
//! calls it makes are a status read (no walk) and a single commit lookup (no
//! walk), so it stays cheap even against a repo with a huge history.

use git2::StatusOptions;
use serde::Serialize;

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DashboardRepoStatus {
    pub branch: Option<String>, // current branch shorthand; None if detached or unborn
    pub detached: bool,         // HEAD exists but isn't a branch
    pub ahead: Option<usize>,   // vs configured upstream; None if no upstream/detached/unborn
    pub behind: Option<usize>,
    pub dirty: bool,            // any staged/unstaged/untracked entry (excluding conflicts, counted separately)
    pub conflicted: usize,      // mid-merge/rebase unmerged count (mirrors WorkdirStatus.conflicted)
    pub head_sha: Option<String>, // short (7-char) sha of HEAD's tip; None on an empty/unborn repo
    pub last_subject: Option<String>, // HEAD tip's commit message first line
    pub last_commit_time: Option<i64>, // unix seconds (author time, matches git_read.rs's `an` field convention)
}

/// JS: `commands.dashboardRepoStatus(path)`.
///
/// BUG FIX: was a plain (non-async) `fn` — per `blocking.rs`'s own doc
/// comment, that runs INLINE on Tauri's main thread, freezing the whole app
/// (not just this row) for as long as the call takes. Sub-second for a
/// normal repo, but the Dashboard modal calls this for EVERY tracked repo
/// in parallel on open — a cold `wsl.exe` interop launch (`crate::wsl::
/// wsl_status`'s WSL-aware fast path, itself a fix for a much worse
/// libgit2 stall — see this module's own earlier doc comment) still takes
/// real seconds, and that "parallel" `Promise.allSettled` fan-out on the
/// frontend is cosmetic: every one of those IPC calls actually serializes
/// on the SAME blocked main thread here, so opening the modal with even a
/// couple of tracked WSL repos froze the entire window until all of them
/// finished. `async fn` + `run_blocking` moves the actual work onto Tauri's
/// blocking-task thread pool, matching `list_refs`'s own established
/// pattern — the frontend's parallel fan-out is now genuinely parallel.
#[tauri::command]
#[specta::specta]
pub async fn dashboard_repo_status(path: String) -> Result<DashboardRepoStatus, String> {
    crate::blocking::run_blocking(move || dashboard_repo_status_inner(&path).map_err(|e| e.message().to_string())).await
}

fn dashboard_repo_status_inner(path: &str) -> Result<DashboardRepoStatus, git2::Error> {
    let repo = crate::trust::open_repo(path)?; // same WSL/UNC auto-trust every other command uses

    let head_ref = repo.head().ok(); // None => unborn (no commits yet); Err discarded, not fatal
    let detached = head_ref.as_ref().is_some_and(|h| !h.is_branch());
    let branch = head_ref
        .as_ref()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand())
        .map(str::to_string);

    let (ahead, behind) = branch
        .as_deref()
        .and_then(|name| repo.find_branch(name, git2::BranchType::Local).ok())
        .and_then(|b| {
            let local_oid = b.get().target()?;
            let up = b.upstream().ok()?.get().peel_to_commit().ok()?;
            repo.graph_ahead_behind(local_oid, up.id()).ok()
        })
        .map(|(a, b)| (Some(a), Some(b)))
        .unwrap_or((None, None));

    let (head_sha, last_subject, last_commit_time) =
        match head_ref.as_ref().and_then(|h| h.peel_to_commit().ok()) {
            Some(c) => (
                Some(c.id().to_string().chars().take(7).collect()),
                Some(c.summary().unwrap_or("").to_string()),
                Some(c.author().when().seconds()),
            ),
            None => (None, None, None),
        };

    // BUG FIX: `Repository::statuses()` below — libgit2 walking the working
    // tree over the `\\wsl.localhost\` bridge — EMPIRICALLY MEASURED at
    // 185+ seconds, EVERY call, against a real repo containing just 4 Linux
    // symlinks (a fresh CPython clone); `crate::wsl::wsl_status` resolves
    // the identical query in under a second by running `git status` through
    // the distro's own git instead — see its own doc comment for why. `None`
    // for a non-WSL path (the overwhelmingly common case): git2 stays
    // exactly as before, completely untouched.
    let (dirty, conflicted) = match crate::wsl::wsl_status(path) {
        Some(Ok(entries)) => {
            let conflicted = entries.iter().filter(|e| matches!(e, crate::wsl::StatusEntry::Unmerged { .. })).count();
            (!entries.is_empty(), conflicted)
        }
        Some(Err(msg)) => return Err(git2::Error::from_str(&msg)),
        None => {
            let mut opts = StatusOptions::new();
            opts.include_untracked(true).recurse_untracked_dirs(true); // same cheap, non-walking read as workdir_status
            let statuses = repo.statuses(Some(&mut opts))?;
            let conflicted = statuses.iter().filter(|e| e.status().is_conflicted()).count();
            let dirty = statuses.iter().any(|e| !e.status().is_ignored());
            (dirty, conflicted)
        }
    };

    Ok(DashboardRepoStatus {
        branch,
        detached,
        ahead,
        behind,
        dirty,
        conflicted,
        head_sha,
        last_subject,
        last_commit_time,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bad_path_is_a_clean_error_not_a_panic() {
        let result = dashboard_repo_status_inner("/definitely/not/a/repo/anywhere");
        assert!(result.is_err());
    }
}
