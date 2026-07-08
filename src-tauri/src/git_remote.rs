//! Remote sync: fetch / pull / push.
//!
//! Same shell-out-to-git-CLI model as git_write.rs (git2 only to open the repo
//! / read HEAD's branch+upstream), but this module doesn't import from
//! git_write.rs — the project's convention (see git_merge.rs's own doc
//! comment) is one small self-contained result type + git-runner per
//! operation module, not a shared cross-module helper surface.
//!
//! Safety Manager snapshots are for protecting LOCAL HEAD/branch position, so
//! only `pull` (which moves the current branch) takes one first. `fetch` only
//! updates remote-tracking refs (`refs/remotes/...`) — never HEAD, a local
//! branch, or the working tree — and `push` doesn't touch local state at all,
//! so there is nothing local for Undo to protect in either case.
//!
//! `pull` is deliberately fast-forward-only (`git pull --ff-only`): a real
//! pull can enter a merge or rebase conflict state, and wiring THAT into the
//! existing Resolver flow is real, separate work. ff-only either succeeds
//! cleanly or fails cleanly with git's own message — it never leaves the
//! working tree mid-conflict.
//!
//! `push` never force-pushes; a rejected (non-fast-forward) push surfaces
//! git's own rejection message rather than silently forcing. A branch with no
//! configured upstream is published to "origin" (`--set-upstream`) — the
//! overwhelmingly common case for a repo with a single remote.

use std::process::Command;

use git2::{BranchType, Repository};
use serde::Serialize;

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteResult {
    pub ok: bool,
    pub message: String,
    /// Pre-op safety snapshot ref — only ever `Some` for `pull` (see module doc).
    pub backup_ref: Option<String>,
}

impl RemoteResult {
    fn ok(message: impl Into<String>, backup_ref: Option<String>) -> Self {
        Self { ok: true, message: message.into(), backup_ref }
    }
    fn err(message: impl Into<String>) -> Self {
        Self { ok: false, message: message.into(), backup_ref: None }
    }
}

struct GitOut {
    ok: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run_git(path: &str, args: &[&str]) -> Result<GitOut, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    Ok(GitOut {
        ok: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

fn git_error_message(out: &GitOut) -> String {
    if !out.stderr.is_empty() {
        out.stderr.clone()
    } else if !out.stdout.is_empty() {
        out.stdout.clone()
    } else {
        format!("git exited with status {:?}", out.code)
    }
}

fn short_backup(r: &str) -> String {
    r.rsplit('/').next().unwrap_or(r).to_string()
}

fn open_repo(path: &str) -> Result<Repository, RemoteResult> {
    Repository::open(path).map_err(|e| RemoteResult::err(format!("Cannot open repository: {}", e.message())))
}

fn take_snapshot(repo: &Repository) -> Result<String, String> {
    crate::safety::snapshot(repo)
}

/// Same flag-injection guard as git_write.rs's validate_branch_name, sized
/// for remote names ("origin", "upstream", ...) rather than branch names.
fn validate_remote_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Remote name is empty.".into());
    }
    if name.starts_with('-') {
        return Err(format!("Refusing a remote name that looks like a flag: {name:?}"));
    }
    if name.chars().any(|c| c.is_control() || c == ' ') {
        return Err(format!("Remote name has an illegal whitespace/control character: {name:?}"));
    }
    Ok(())
}

/// Update remote-tracking refs. `remote` fetches just that one remote;
/// omitted, it fetches every configured remote (`--all`). Always `--prune`s
/// stale remote-tracking branches that no longer exist on the remote.
/// JS call: `invoke("fetch", { path, remote? })`.
#[tauri::command]
#[specta::specta]
pub fn fetch(path: String, remote: Option<String>) -> RemoteResult {
    if let Some(r) = &remote {
        if let Err(e) = validate_remote_name(r) {
            return RemoteResult::err(e);
        }
    }
    // No git2 needed: nothing here is derived from repo state, and an invalid
    // path surfaces git's own "not a git repository" error just as clearly.
    let args: Vec<&str> = match &remote {
        Some(r) => vec!["fetch", "--prune", "--end-of-options", r.as_str()],
        None => vec!["fetch", "--all", "--prune"],
    };
    match run_git(&path, &args) {
        Ok(out) if out.ok => RemoteResult::ok(
            match &remote {
                Some(r) => format!("Fetched {r}."),
                None => "Fetched all remotes.".to_string(),
            },
            None,
        ),
        Ok(out) => RemoteResult::err(git_error_message(&out)),
        Err(e) => RemoteResult::err(e),
    }
}

/// Fast-forward the current branch to its upstream (`git pull --ff-only`).
/// Refuses (git's own message) rather than merging/rebasing on divergence —
/// see module doc for why.
/// JS call: `invoke("pull", { path })`.
#[tauri::command]
#[specta::specta]
pub fn pull(path: String) -> RemoteResult {
    let repo = match open_repo(&path) {
        Ok(r) => r,
        Err(w) => return w,
    };
    let backup = match take_snapshot(&repo) {
        Ok(b) => b,
        Err(e) => return RemoteResult::err(format!("Safety snapshot failed, aborting: {e}")),
    };
    match run_git(&path, &["pull", "--ff-only"]) {
        Ok(out) if out.ok => {
            let msg = if out.stdout.contains("Already up to date") {
                "Already up to date.".to_string()
            } else {
                format!("Pulled (snapshot {}).", short_backup(&backup))
            };
            RemoteResult::ok(msg, Some(backup))
        }
        // e.g. "fatal: Not possible to fast-forward, aborting."
        Ok(out) => RemoteResult::err(git_error_message(&out)),
        Err(e) => RemoteResult::err(e),
    }
}

/// Push the current branch. Publishes to "origin" with `--set-upstream` when
/// it has no configured upstream yet; otherwise a plain `git push`. Never
/// force-pushes — a non-fast-forward rejection surfaces git's own message.
/// JS call: `invoke("push", { path })`.
#[tauri::command]
#[specta::specta]
pub fn push(path: String) -> RemoteResult {
    let repo = match open_repo(&path) {
        Ok(r) => r,
        Err(w) => return w,
    };
    let branch = match repo.head().ok().filter(|h| h.is_branch()).and_then(|h| h.shorthand().map(|s| s.to_string())) {
        Some(b) => b,
        None => return RemoteResult::err("HEAD is not on a branch — nothing to push.".to_string()),
    };
    let has_upstream = repo.find_branch(&branch, BranchType::Local).ok().and_then(|b| b.upstream().ok()).is_some();

    let out = if has_upstream {
        run_git(&path, &["push"])
    } else {
        run_git(&path, &["push", "--set-upstream", "origin", "--end-of-options", &branch])
    };
    match out {
        Ok(out) if out.ok => RemoteResult::ok(
            if has_upstream { format!("Pushed {branch}.") } else { format!("Published {branch} to origin.") },
            None,
        ),
        // e.g. "! [rejected] ... (non-fast-forward)" or "fatal: 'origin' does not appear to be a git repository"
        Ok(out) => RemoteResult::err(git_error_message(&out)),
        Err(e) => RemoteResult::err(e),
    }
}
