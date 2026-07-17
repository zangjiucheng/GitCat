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
//! `force_push` is this module's ONE deliberate, sanctioned exception to the
//! "never force" rule above — added so a branch that's been rebased/amended
//! AFTER already being pushed (a routine result of this app's own
//! rebase/amend features) has an escape hatch at all; plain `push` itself is
//! completely unchanged and still never forces anything. Even here, forcing
//! is never silent: `lease:true` (`--force-with-lease`) still refuses —
//! surfacing git's own rejection verbatim, exactly like plain `push`'s
//! non-fast-forward refusal above — whenever the remote has moved since this
//! repo last knew about it; only `lease:false` (a raw `--force`)
//! unconditionally overwrites, and the frontend requires that to be a
//! SEPARATE, independently-armed confirmation rather than a checkbox on the
//! same flow (see forcepush.svelte.ts). Like `push`, it only ever targets the
//! CURRENT branch and only ever runs when that branch already has a
//! configured upstream — there's nothing to force over otherwise.
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

/// Own copy of `git_write.rs`'s `validate_branch_name` (same per-module-copy
/// convention as `validate_remote_name`/`validate_tag_name` — see their own
/// comments) — `reset_branch_to_upstream`'s `branch` is raw user input
/// (unlike `pull`/`push`/`force_push`'s branch, which comes from
/// `repo.head()` and is never independently validated), so it needs the
/// identical flag-injection/name-validity guard `create_branch`/
/// `delete_branch` apply.
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

/// Hard-reset a LOCAL branch to exactly match its configured upstream
/// (remote-tracking branch), discarding any local commits/changes on that
/// branch — the "this branch is a mess, just make it match origin" escape
/// hatch `pull`'s fast-forward-only refusal deliberately doesn't offer (see
/// module doc: `pull` refuses rather than forces on divergence).
///
/// Unlike `pull`/`push`/`force_push` above (all current-branch-only),
/// `branch` is explicit and works whether it's the CURRENTLY checked-out
/// branch or not:
/// - Current branch: `git reset --hard <upstream>` — moves HEAD, the index,
///   AND the working tree (uncommitted changes on this branch are discarded
///   too, exactly like a real `git reset --hard`).
/// - Any other local branch: `git branch -f <branch> <upstream>` — force-
///   moves just the branch ref itself; there's no working tree/index for a
///   non-checked-out branch to reset, so nothing else is touched.
///
/// Snapshots first (same convention as `pull`): the branch's PREVIOUS tip is
/// always recoverable via Undo, even though this command's whole point is to
/// discard it from the branch's own history. Refuses up front (no mutation)
/// if `branch` doesn't exist locally or has no configured upstream to reset
/// to — there being nothing to reset to is treated the same as `pull`
/// finding nothing to fast-forward.
/// JS call: `invoke("reset_branch_to_upstream", { path, branch })`.
#[tauri::command]
#[specta::specta]
pub fn reset_branch_to_upstream(path: String, branch: String) -> RemoteResult {
    if let Err(e) = validate_branch_name(&branch) {
        return RemoteResult::err(e);
    }
    let repo = match open_repo(&path) {
        Ok(r) => r,
        Err(w) => return w,
    };
    let local = match repo.find_branch(&branch, BranchType::Local) {
        Ok(b) => b,
        Err(_) => return RemoteResult::err(format!("No local branch named {branch:?}.")),
    };
    let upstream = match local.upstream() {
        Ok(u) => u,
        Err(_) => return RemoteResult::err(format!("{branch} has no configured upstream to reset to.")),
    };
    let upstream_name = match upstream.name() {
        Ok(Some(n)) => n.to_string(),
        _ => return RemoteResult::err(format!("{branch}'s upstream name isn't valid UTF-8.")),
    };

    let backup = match take_snapshot(&repo) {
        Ok(b) => b,
        Err(e) => return RemoteResult::err(format!("Safety snapshot failed, aborting: {e}")),
    };

    let is_current = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(|s| s.to_string()))
        .as_deref()
        == Some(branch.as_str());

    // Same `--end-of-options` placement `delete_branch`/`rename_branch` use
    // for `git branch` in git_write.rs: the flag(s) come BEFORE the marker,
    // never after — EMPIRICALLY VERIFIED (git 2.53.0) that `git branch
    // --end-of-options -f <branch> <start>` misparses `-f` as a positional
    // once it comes after the marker ("usage: git branch ..."); only
    // `-f --end-of-options <branch> <start>` (flag first) works.
    let out = if is_current {
        run_git(&path, &["reset", "--hard", "--end-of-options", &upstream_name])
    } else {
        run_git(&path, &["branch", "-f", "--end-of-options", &branch, &upstream_name])
    };
    match out {
        Ok(out) if out.ok => RemoteResult::ok(
            format!("Reset {branch} to {upstream_name} (snapshot {}).", short_backup(&backup)),
            Some(backup),
        ),
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

/// The ONE sanctioned exception to this module's "never force" rule (see
/// module doc above) — added so a branch that's been rebased/amended AFTER
/// already being pushed has a way to publish the rewritten history at all;
/// plain `push` is completely unchanged and still never forces anything.
///
/// Same current-branch resolution as `push` (`repo.head()` -> `is_branch()`
/// -> `shorthand()`) and the SAME `has_upstream` lookup `push` already does —
/// but here it's a hard precondition, not a branch point: force-pushing only
/// makes sense when there's already something on the remote to force over,
/// so a branch with no configured upstream refuses outright instead of
/// attempting anything (unlike plain `push`, which happily auto-publishes a
/// brand-new branch via `--set-upstream`).
///
/// `lease` selects the flag:
/// - `true` -> `git push --force-with-lease`: refuses (git's own rejection,
///   surfaced verbatim, never retried/escalated here) if the remote moved
///   since this repo last learned about it. The frontend's safer of the two
///   ("Force Push (Safe)").
/// - `false` -> `git push --force`: unconditional — whatever is on the
///   remote is overwritten regardless of whether this repo has ever seen it.
///   The frontend's "Force Push (Override Remote)", gated behind its OWN,
///   separately-armed, more severely worded confirmation.
///
/// Never falls back from lease to raw force on its own: a `--force-with-
/// lease` rejection is returned to the caller exactly like any other git
/// refusal; only a genuinely separate call with `lease:false` performs the
/// raw force — mirroring this module's "never force silently" stance for
/// plain `push`.
///
/// No Safety Manager snapshot, for the same reason plain `push` takes none:
/// this touches only the REMOTE ref, never local HEAD/branch/working-tree
/// state, so there is nothing local for Undo to protect.
///
/// Passes an EXPLICIT `<remote> <branch>` (never zero positionals) — an
/// adversarial review caught that zero positionals lets the user's own
/// `push.default` config decide what gets pushed. `push.default=matching`
/// (still a fully legal, non-error config some long-lived `.gitconfig`s
/// carry) makes a bare `git push --force-with-lease`/`--force` force-push
/// EVERY local branch that has a same-named remote counterpart, not just
/// the one this function resolved and the confirm dialog showed — silently
/// clobbering an unrelated branch's history, or (for the `lease` case)
/// reporting this call as a failure merely because some OTHER branch's own
/// push was rejected in the same combined invocation, even when the
/// intended branch's own push succeeded. Empirically verified (git 2.50.1):
/// `git push --force-with-lease origin main` correctly confines the
/// operation to just `main` even under `push.default=matching`. The remote
/// name is looked up via `branch_upstream_remote` (the real
/// `branch.<name>.remote` config value) rather than assumed to be "origin",
/// since a branch can legitimately track any remote.
///
/// A single bare positional would be misparsed: `git push --force-with-lease
/// main` (branch name, no remote) fails with "fatal: 'main' does not appear
/// to be a git repository" — git reads a lone positional as the
/// `<repository>` destination, not a refspec. `--end-of-options` guards both
/// positionals from being misread as flags, mirroring `push_tag`'s own
/// `<remote> <refspec>` shape below.
/// JS call: `invoke("force_push", { path, lease })`.
#[tauri::command]
#[specta::specta]
pub fn force_push(path: String, lease: bool) -> RemoteResult {
    let repo = match open_repo(&path) {
        Ok(r) => r,
        Err(w) => return w,
    };
    let branch = match repo.head().ok().filter(|h| h.is_branch()).and_then(|h| h.shorthand().map(|s| s.to_string())) {
        Some(b) => b,
        None => return RemoteResult::err("HEAD is not on a branch — nothing to force-push.".to_string()),
    };
    let has_upstream = repo.find_branch(&branch, BranchType::Local).ok().and_then(|b| b.upstream().ok()).is_some();
    if !has_upstream {
        return RemoteResult::err("This branch has no upstream yet — use Push to publish it first.".to_string());
    }
    let remote = match repo.branch_upstream_remote(&format!("refs/heads/{branch}")) {
        Ok(buf) => match buf.as_str() {
            Some(s) => s.to_string(),
            None => return RemoteResult::err("This branch's upstream remote name isn't valid UTF-8.".to_string()),
        },
        Err(e) => return RemoteResult::err(format!("Could not resolve this branch's upstream remote: {e}")),
    };

    let flag = if lease { "--force-with-lease" } else { "--force" };
    let out = run_git(&path, &["push", flag, "--end-of-options", &remote, &branch]);
    match out {
        Ok(out) if out.ok => {
            RemoteResult::ok(format!("Force-pushed {branch} ({}).", if lease { "lease" } else { "forced" }), None)
        }
        // e.g. "! [rejected]  <branch> -> <branch> (stale info)" when `lease`
        // and the remote moved since our last fetch — never silently retried
        // as a raw force; see this function's own doc comment.
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

/// Push a SPECIFIC local branch — not necessarily HEAD/the checked-out one —
/// without switching to it first, optionally under a DIFFERENT name on the
/// remote side. Complements plain `push` above, which only ever resolves and
/// pushes whatever branch HEAD currently sits on; the sidebar's per-branch
/// "Push…" menu item calls this instead so publishing a branch never
/// requires checking it out.
///
/// `branch` is raw user input (unlike `push`/`force_push`'s branch, which
/// comes from `repo.head()` and is never independently validated — see
/// `validate_branch_name`'s own doc comment), so both `branch` AND
/// `remote_branch` (when given — also raw user input) get the same
/// flag-injection/name-validity guard `create_branch`/`delete_branch`/
/// `reset_branch_to_upstream` already apply.
///
/// `remote_branch` (when given) publishes to a DIFFERENT name on the remote
/// than the local branch — a full `local:remote` refspec, same "qualify both
/// sides explicitly, never a bare positional" reasoning `push_tag`'s own doc
/// comment covers (`refs/heads/<branch>:refs/heads/<remote_branch>`, never
/// just `<branch>`, so git can't fall back to scanning ref namespaces or
/// deferring to `push.default`). Omitted, it defaults to the local branch's
/// own name (`local:local`, same shape `push` already produces).
///
/// `remote` (when given) picks which remote to push to, same as `push_tag`.
/// Omitted, it falls back to the branch's own configured upstream remote
/// (never assumed to be "origin" — a branch can legitimately track any
/// remote, mirroring `force_push`'s own `branch_upstream_remote` lookup), and
/// only falls further back to "origin" when the branch has no upstream at
/// all yet — matching plain `push`'s own first-publish default.
///
/// Upstream handling mirrors `push`: an already-tracked branch gets a bare
/// `git push <remote> <refspec>`; an untracked one gets `--set-upstream
/// <remote> <refspec>` so it comes away with the same upstream-tracking
/// plain `push` would have given it from checked out — even when
/// `remote_branch` differs from `branch`, `--set-upstream` correctly records
/// the differently-named remote branch as what future plain pulls/pushes
/// should track (empirically confirmed: `git push --set-upstream origin
/// local:remote-name` sets `branch.local.merge` to `refs/heads/remote-name`,
/// not `refs/heads/local`).
///
/// Never force-pushes — same "surface git's own rejection, never silently
/// force" stance as every other push variant in this module.
/// JS call: `invoke("push_branch", { path, branch, remote?, remoteBranch? })`.
#[tauri::command]
#[specta::specta]
pub fn push_branch(path: String, branch: String, remote: Option<String>, remote_branch: Option<String>) -> RemoteResult {
    if let Err(e) = validate_branch_name(&branch) {
        return RemoteResult::err(e);
    }
    let remote_branch = match remote_branch {
        Some(b) => {
            if let Err(e) = validate_branch_name(&b) {
                return RemoteResult::err(e);
            }
            b
        }
        None => branch.clone(),
    };

    let repo = match open_repo(&path) {
        Ok(r) => r,
        Err(w) => return w,
    };
    let local = match repo.find_branch(&branch, BranchType::Local) {
        Ok(b) => b,
        Err(_) => return RemoteResult::err(format!("No such local branch: {branch}")),
    };
    let has_upstream = local.upstream().is_ok();

    let remote = match remote {
        Some(r) => r,
        None if has_upstream => match repo.branch_upstream_remote(&format!("refs/heads/{branch}")) {
            Ok(buf) => buf.as_str().unwrap_or("origin").to_string(),
            Err(_) => "origin".to_string(),
        },
        None => "origin".to_string(),
    };
    if let Err(e) = validate_remote_name(&remote) {
        return RemoteResult::err(e);
    }

    let refspec = format!("refs/heads/{branch}:refs/heads/{remote_branch}");
    let out = if has_upstream {
        run_git(&path, &["push", "--end-of-options", &remote, &refspec])
    } else {
        run_git(&path, &["push", "--set-upstream", &remote, "--end-of-options", &refspec])
    };
    match out {
        Ok(out) if out.ok => RemoteResult::ok(
            if remote_branch == branch {
                format!("Pushed {branch} to {remote}.")
            } else {
                format!("Pushed {branch} to {remote}/{remote_branch}.")
            },
            None,
        ),
        // e.g. "! [rejected] ... (non-fast-forward)" — never forced.
        Ok(out) => RemoteResult::err(git_error_message(&out)),
        Err(e) => RemoteResult::err(e),
    }
}
