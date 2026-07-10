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
//! That "real, separate work" now exists, layered ON TOP of this module
//! rather than inside `pull` itself: `current_upstream` (below) plus the
//! existing `fetch`, orchestrated from the frontend with git_merge.rs's
//! `merge_start` / git_rebase.rs's `rebase_start` — see resolver.svelte.ts's
//! `pullMerge`/`pullRebase`. `pull` itself is UNCHANGED: still the one-click
//! ff-only operation wired to the topbar's Pull button; the strategy-
//! choosing entry points live only in the Tools menu / ⌘K (menu.rs /
//! cmdk.svelte.ts), never touching `pull`'s signature or callers.
//!
//! `push` never force-pushes; a rejected (non-fast-forward) push surfaces
//! git's own rejection message rather than silently forcing. A branch with no
//! configured upstream is published to "origin" (`--set-upstream`) — the
//! overwhelmingly common case for a repo with a single remote.
//!
//! `push_tag` lives HERE rather than in `git_tag.rs` (which owns
//! create/delete): pushing a tag needs zero tag-lifecycle machinery — no
//! snapshot, no `pin_deleted_tag`-style safety net, nothing local changes at
//! all (identical to plain `push`'s own rationale above) — while it needs
//! EVERY ONE of this module's existing remote-sync conventions: `RemoteResult`,
//! `run_git`/`git_error_message`, and above all "never force, surface git's
//! own rejection" (a tag MOVE requires `--force` in real git; there is no
//! separate force-push-a-moved-tag flag here, exactly mirroring `push`'s own
//! choice never to add one). Adding a fourth `{ok, message, backup_ref}`
//! result type in `git_tag.rs` just to relocate this one command would
//! duplicate a type this module already owns for exactly this shape of
//! operation — so it stays here instead, alongside `fetch`/`pull`/`push`.

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
    crate::trust::open_repo(path).map_err(|e| RemoteResult::err(format!("Cannot open repository: {}", e.message())))
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

/// Own copy of `git_tag.rs`'s `validate_tag_name` (same per-module-copy
/// convention as `validate_remote_name` above, which is itself already a copy
/// of `git_write.rs`'s `validate_branch_name`) — `push_tag`'s `name` is raw
/// user input (unlike plain `push`'s branch, which comes from `repo.head()`
/// and is never independently validated), so it needs the identical
/// flag-injection/name-validity guard `create_tag`/`delete_tag` apply. See
/// `git_tag.rs`'s doc comment for the empirically-verified rules this
/// encodes (identical to branch names except `name == "@"`, which `git tag`
/// itself refuses with a confusing error).
fn validate_tag_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Tag name is empty.".into());
    }
    if name.starts_with('-') {
        return Err(format!("Refusing a tag name that looks like a flag: {name:?}"));
    }
    for ch in name.chars() {
        if ch.is_control() || ch == ' ' || ch == '\u{7f}' {
            return Err(format!("Tag name has an illegal whitespace/control character: {name:?}"));
        }
        if matches!(ch, '~' | '^' | ':' | '?' | '*' | '[' | '\\') {
            return Err(format!("Tag name has an illegal character '{ch}': {name:?}"));
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
        return Err(format!("Not a valid tag name: {name:?}"));
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

/// The current branch's configured upstream, as a shorthand remote-tracking
/// name (e.g. "origin/main") — exactly what a pull-with-merge/rebase-strategy
/// flow needs to hand to `merge_start`/`rebase_start` (see git_merge.rs /
/// git_rebase.rs). `None` when HEAD isn't on a branch, or that branch has no
/// upstream configured — the frontend surfaces that as "this branch has no
/// upstream to pull from" and stops before calling anything else (fetch
/// included). Pure read (git2 only): no mutation, no snapshot — nothing here
/// can leave the repo in a different state.
/// JS call: `invoke("current_upstream", { path })`.
#[tauri::command]
#[specta::specta]
pub fn current_upstream(path: String) -> Result<Option<String>, String> {
    let repo = crate::trust::open_repo(&path).map_err(|e| format!("Cannot open repository: {}", e.message()))?;
    let branch_name = match repo.head().ok().filter(|h| h.is_branch()).and_then(|h| h.shorthand().map(|s| s.to_string())) {
        Some(b) => b,
        None => return Ok(None),
    };
    // Same has-upstream lookup `push` already does below; here we also keep
    // the shorthand name instead of just a bool.
    let upstream_name = repo
        .find_branch(&branch_name, BranchType::Local)
        .ok()
        .and_then(|b| b.upstream().ok())
        .and_then(|up| up.name().ok().flatten().map(|s| s.to_string()));
    Ok(upstream_name)
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

/// Push a single tag (`git push <remote> refs/tags/<name>:refs/tags/<name>`).
/// `remote` defaults to "origin" when omitted (mirrors `push`'s own
/// default-remote choice above — tags have no upstream-tracking concept to
/// consult, so there's no analogous "does it already have one?" check to
/// make). Never force-pushes: a tag MOVE (the same name already exists on
/// the remote at a different commit) requires `--force` in real git, and
/// exactly like plain `push` above, this surfaces that rejection verbatim
/// rather than silently forcing — there is no separate
/// force-push-a-moved-tag flag. See this module's doc comment for why
/// `push_tag` lives here rather than in `git_tag.rs`.
///
/// The source side of the refspec MUST be fully qualified as
/// `refs/tags/<name>`, never a bare `<name>`: given a bare source, git
/// resolves it by scanning ref namespaces itself (`refs/tags/<name>`,
/// `refs/heads/<name>`, ...) rather than assuming tags — and GitCat lets a
/// branch and a tag share a name (`create_branch`/`create_tag` never check
/// the other namespace). Empirically confirmed: with a branch `X` but no
/// tag `X`, a bare `git push origin X` silently pushes/creates a *branch*
/// `refs/heads/X` on the remote and reports success ("new branch X -> X"),
/// even though this function claims to push a tag. Qualifying the source as
/// `refs/tags/<name>` makes git refuse with "src refspec ... does not match
/// any" whenever no such tag exists locally, instead of silently falling
/// back to a same-named branch. The destination is spelled out too
/// (`:refs/tags/<name>`) so the remote-side ref this creates/updates is
/// never left for git to infer either.
/// JS call: `invoke("push_tag", { path, remote?, name })`.
#[tauri::command]
#[specta::specta]
pub fn push_tag(path: String, remote: Option<String>, name: String) -> RemoteResult {
    let remote = remote.unwrap_or_else(|| "origin".to_string());
    if let Err(e) = validate_remote_name(&remote) {
        return RemoteResult::err(e);
    }
    if let Err(e) = validate_tag_name(&name) {
        return RemoteResult::err(e);
    }
    // No git2, no snapshot: pushing a tag doesn't touch local state at all —
    // same rationale as plain `push` (see module doc comment).
    let refspec = format!("refs/tags/{name}:refs/tags/{name}");
    match run_git(&path, &["push", "--end-of-options", &remote, &refspec]) {
        Ok(out) if out.ok => RemoteResult::ok(format!("Pushed tag {name} to {remote}."), None),
        // e.g. "! [rejected] <name> -> <name> (already exists)" — never forced.
        // Or, if `name` is a branch with no same-named local tag: "error: src
        // refspec refs/tags/<name> does not match any" — never a branch push.
        Ok(out) => RemoteResult::err(git_error_message(&out)),
        Err(e) => RemoteResult::err(e),
    }
}
