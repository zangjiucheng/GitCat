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

use git2::{BranchType, Repository};
use serde::Serialize;
use tauri::{AppHandle, Wry};

use crate::i18n_err::{ierr, ierrp};

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

/// One live progress segment emitted to the frontend during a streaming
/// fetch/pull (see `fetch_stream`/`pull_stream`). Emitted as the `"sync-progress"`
/// event, never taken as a command parameter — exported to TS via `specta_builder`
/// exactly like `GraphBatch`.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    /// Operation kind — "fetch" | "pull". The frontend uses it as a cheap
    /// discriminator so a late event from one op can't leak into another's modal.
    pub phase: String,
    /// One raw git progress segment (see `feed_progress`'s `\r`/`\n` split).
    pub line: String,
}

/// Every command in this module talks to a remote (even
/// `reset_branch_to_upstream`, which only ever moves a branch to a ref
/// `fetch` already learned about) — see `crate::wsl` for why that means
/// EVERY call here goes through its WSL-aware routing, not just the ones
/// that fetch/push over the network directly.
fn run_git(path: &str, args: &[&str]) -> Result<GitOut, String> {
    let output = crate::wsl::git_command(path, args)
        .output()
        .map_err(|e| ierrp("err_remote.run_git_failed", &[("detail", &e.to_string())]))?;
    Ok(GitOut {
        ok: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

/// Feed one chunk of raw progress bytes through the segmenter, invoking
/// `on_line` once per completed segment. git rewrites its current progress line
/// with a bare `\r` (carriage return) between updates and only ends a phase with
/// `\n`, so a `\n`-only reader would see nothing until the whole op finished —
/// we split on BOTH. `seg` carries the partial trailing segment across chunk
/// boundaries; because a completed segment is UTF-8-decoded only once it's whole,
/// a multi-byte char split across two reads is handled correctly. Pure + no I/O,
/// so it's unit-tested directly (see tests below).
fn feed_progress(chunk: &[u8], seg: &mut Vec<u8>, on_line: &mut impl FnMut(&str)) {
    for &b in chunk {
        if b == b'\r' || b == b'\n' {
            if !seg.is_empty() {
                on_line(String::from_utf8_lossy(seg).trim_end());
                seg.clear();
            }
        } else {
            seg.push(b);
        }
    }
}

/// Streaming sibling of `run_git`: spawns the SAME WSL-aware `git_command` (so
/// `GIT_TERMINAL_PROMPT=0` / null stdin / `no_console_window` / `SSH_ASKPASS` are
/// all inherited unchanged), but pipes stderr and reads it live, calling `on_line`
/// once per progress segment (see `feed_progress`). stdout is drained
/// concurrently on its own thread: a child blocked writing to a full, unread
/// stdout pipe would deadlock (the same hazard `procutil::output_with_timeout`
/// documents). Deliberately NO timeout — a live-progress remote op is expected to
/// be long, and the non-streaming `run_git` above never had one either.
fn run_git_streaming(path: &str, args: &[&str], mut on_line: impl FnMut(&str)) -> Result<GitOut, String> {
    use std::io::Read;
    use std::process::Stdio;
    let mut child = crate::wsl::git_command(path, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ierrp("err_remote.run_git_failed", &[("detail", &e.to_string())]))?;

    // Drain stdout on a sibling thread so a large stdout can't deadlock the
    // stderr read loop below (and vice versa).
    let mut stdout_pipe = child.stdout.take().expect("stdout piped above");
    let stdout_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        buf
    });

    let mut stderr_pipe = child.stderr.take().expect("stderr piped above");
    let mut stderr_all: Vec<u8> = Vec::new();
    let mut seg: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stderr_pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                stderr_all.extend_from_slice(&chunk[..n]);
                feed_progress(&chunk[..n], &mut seg, &mut on_line);
            }
            Err(_) => break,
        }
    }
    // Flush a final segment with no trailing \r/\n (e.g. the last "done." line).
    if !seg.is_empty() {
        on_line(String::from_utf8_lossy(&seg).trim_end());
    }

    let status = child.wait().map_err(|e| ierrp("err_remote.git_wait_failed", &[("detail", &e.to_string())]))?;
    let stdout = stdout_thread.join().unwrap_or_default();
    Ok(GitOut {
        ok: status.success(),
        code: status.code(),
        stdout: String::from_utf8_lossy(&stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&stderr_all).trim().to_string(),
    })
}

/// Best human message from a failed git run (prefer stderr, then stdout).
///
/// Every git subprocess this app runs — WSL-routed or plain (see
/// `crate::wsl::git_command`) — is launched with `stdin(Stdio::null())` and
/// no console window at all, so the `ssh` child it spawns for a remote
/// operation has NO terminal to prompt on, ever. Two distinct SSH failure
/// modes fall out of that same one root cause, and both get an extra,
/// actionable hint appended here (never auto-worked-around: silently
/// bypassing either one has a real security cost, see the host-key case
/// below, so this only makes the cause discoverable, matching this file's
/// "never force/bypass silently" convention elsewhere):
///
///   - "Permission denied (publickey...)" — auth itself failed. On a
///     WSL-routed repo specifically, `wsl.exe -e` is a direct exec with NO
///     shell at all, so `~/.bashrc`/`~/.profile` never run — a distro whose
///     SSH agent is only started/exported there (a bare `ssh-agent`
///     session, or a Windows-agent-via-npiperelay bridge sourced in
///     `.bashrc`) is invisible to this non-interactive invocation, and a
///     still-locked passphrase-protected key can't be unlocked
///     non-interactively either way.
///   - "Host key verification failed" — this HOST has never been connected
///     to before from wherever `ssh`'s own `known_hosts` lives for this
///     invocation (Windows' `%USERPROFILE%\.ssh\known_hosts` for a plain
///     path, or the WSL DISTRO's own separate `~/.ssh/known_hosts` for a
///     WSL-routed one — on a WSL repo this can trip even when the same
///     host is already trusted on the WINDOWS side via another tool
///     (GitExtensions, plain `ssh`, ...): that's a completely different
///     known_hosts file from the distro's own, and each side only ever
///     gets populated by actually connecting through IT specifically. On a
///     plain (non-WSL) repo the cause is simpler: this app's own git
///     subprocess just genuinely never got a chance to accept this host's
///     key yet, unlike a tool that runs `ssh` with a real console attached.
///     A real interactive `ssh` normally prompts
///     "...are you sure you want to continue connecting?" the first time;
///     with no terminal to answer on, OpenSSH treats an unanswerable
///     prompt as a "no" and fails closed instead of hanging — which is the
///     secure behavior (silently auto-trusting an unverified host key here
///     would be a real MITM-protection regression, not a convenience fix),
///     so the fix has to be "go accept it once from somewhere interactive",
///     not something this app can safely do on its own behalf.
fn git_error_message(path: &str, out: &GitOut) -> String {
    let base = if !out.stderr.is_empty() {
        out.stderr.clone()
    } else if !out.stdout.is_empty() {
        out.stdout.clone()
    } else {
        ierrp("err_remote.git_exited_status", &[("code", &format!("{:?}", out.code))])
    };
    let is_wsl = crate::wsl::wsl_target(path).is_some();
    // Kept short on purpose: Tama's toast-line (index.html's .toast-line)
    // clamps to 5 wrapped lines in a ~150px-wide bubble, so a full
    // explanation of *why* would just get silently cut off. The raw git
    // stderr (`base`) travels as a param, unlocalized, exactly like it does
    // in the plain-passthrough `else` arm below.
    if is_wsl && base.contains("Permission denied") && base.contains("publickey") {
        ierrp("err_remote.ssh_publickey_wsl_hint", &[("base", &base)])
    } else if base.contains("Host key verification failed") {
        if is_wsl {
            ierrp("err_remote.host_key_wsl_hint", &[("base", &base)])
        } else {
            ierrp("err_remote.host_key_hint", &[("base", &base)])
        }
    } else {
        base
    }
}

fn short_backup(r: &str) -> String {
    r.rsplit('/').next().unwrap_or(r).to_string()
}

fn open_repo(path: &str) -> Result<Repository, RemoteResult> {
    crate::trust::open_repo(path).map_err(|e| RemoteResult::err(ierrp("err_remote.cannot_open", &[("detail", e.message())])))
}

fn take_snapshot(repo: &Repository) -> Result<String, String> {
    crate::safety::snapshot(repo)
}

/// Same flag-injection guard as git_write.rs's validate_branch_name, sized
/// for remote names ("origin", "upstream", ...) rather than branch names.
fn validate_remote_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(ierr("err_remote.remote_name_empty"));
    }
    if name.starts_with('-') {
        return Err(ierrp("err_remote.remote_name_flag", &[("name", &format!("{name:?}"))]));
    }
    if name.chars().any(|c| c.is_control() || c == ' ') {
        return Err(ierrp("err_remote.remote_name_control", &[("name", &format!("{name:?}"))]));
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
        return Err(ierr("err_remote.branch_name_empty"));
    }
    if name.starts_with('-') {
        return Err(ierrp("err_remote.branch_name_flag", &[("name", &format!("{name:?}"))]));
    }
    for ch in name.chars() {
        if ch.is_control() || ch == ' ' || ch == '\u{7f}' {
            return Err(ierrp("err_remote.branch_name_control", &[("name", &format!("{name:?}"))]));
        }
        if matches!(ch, '~' | '^' | ':' | '?' | '*' | '[' | '\\') {
            return Err(ierrp("err_remote.branch_name_illegal_char", &[("ch", &ch.to_string()), ("name", &format!("{name:?}"))]));
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
        return Err(ierrp("err_remote.branch_name_invalid", &[("name", &format!("{name:?}"))]));
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
        return Err(ierr("err_remote.tag_name_empty"));
    }
    if name.starts_with('-') {
        return Err(ierrp("err_remote.tag_name_flag", &[("name", &format!("{name:?}"))]));
    }
    for ch in name.chars() {
        if ch.is_control() || ch == ' ' || ch == '\u{7f}' {
            return Err(ierrp("err_remote.tag_name_control", &[("name", &format!("{name:?}"))]));
        }
        if matches!(ch, '~' | '^' | ':' | '?' | '*' | '[' | '\\') {
            return Err(ierrp("err_remote.tag_name_illegal_char", &[("ch", &ch.to_string()), ("name", &format!("{name:?}"))]));
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
        return Err(ierrp("err_remote.tag_name_invalid", &[("name", &format!("{name:?}"))]));
    }
    Ok(())
}

/// Update remote-tracking refs. `remote` fetches just that one remote;
/// omitted, it fetches every configured remote (`--all`). Always `--prune`s
/// stale remote-tracking branches that no longer exist on the remote.
/// JS call: `invoke("fetch", { path, remote? })`.
///
/// BUG FIX: was a plain (non-async) `fn` — per `blocking.rs`'s own doc
/// comment, that runs INLINE on Tauri's main thread. This one shells out to
/// `git fetch`, a real network call that can take anywhere from under a
/// second to minutes depending on the remote and how much history changed,
/// so the whole app window (redraws, every other command's IPC) froze for
/// the entire fetch. `async fn` + `run_blocking` moves it onto Tauri's
/// blocking-task thread pool.
#[tauri::command]
#[specta::specta]
pub async fn fetch(path: String, remote: Option<String>) -> RemoteResult {
    crate::blocking::run_blocking(move || {
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
            Ok(out) => RemoteResult::err(git_error_message(&path, &out)),
            Err(e) => RemoteResult::err(e),
        }
    })
    .await
}

/// Streaming twin of [`fetch`]: identical behaviour (same validation, args,
/// success message, and `git_error_message` failure path), but forces
/// `--progress` so git writes transfer progress to stderr, reads it live via
/// `run_git_streaming`, and emits each segment as a `"sync-progress"` event so
/// the frontend's progress modal can show what git is doing. `fetch` (silent,
/// used by the ambient auto-fetch timer and the pull-with-strategy flows) is
/// left in place; only the user-initiated topbar/menu Fetch calls this one.
///
/// FOLLOW-UP: no process-kill cancel yet — the modal is dismissable and the op
/// runs to completion in the background (`fetch` only moves remote-tracking
/// refs, so a background finish is harmless). A real cancel would need a shared
/// `Child` handle + a `sync_cancel` command (mirroring `bisect_run_cancel`), and
/// killing `wsl.exe` doesn't reliably kill the inner git on the WSL path.
/// JS call: `invoke("fetch_stream", { path, remote? })`.
#[tauri::command]
#[specta::specta]
pub async fn fetch_stream(app: AppHandle<Wry>, path: String, remote: Option<String>) -> RemoteResult {
    crate::blocking::run_blocking(move || {
        if let Some(r) = &remote {
            if let Err(e) = validate_remote_name(r) {
                return RemoteResult::err(e);
            }
        }
        // `--progress` MUST precede `--end-of-options` — anything after that
        // marker is parsed as a positional (same rule this module documents for
        // the specific-remote fetch's remote arg).
        let args: Vec<&str> = match &remote {
            Some(r) => vec!["fetch", "--prune", "--progress", "--end-of-options", r.as_str()],
            None => vec!["fetch", "--all", "--prune", "--progress"],
        };
        let mut emit = |line: &str| {
            crate::event_util::emit_on_main(&app, "sync-progress", SyncProgress { phase: "fetch".into(), line: line.to_string() });
        };
        match run_git_streaming(&path, &args, &mut emit) {
            Ok(out) if out.ok => RemoteResult::ok(
                match &remote {
                    Some(r) => format!("Fetched {r}."),
                    None => "Fetched all remotes.".to_string(),
                },
                None,
            ),
            Ok(out) => RemoteResult::err(git_error_message(&path, &out)),
            Err(e) => RemoteResult::err(e),
        }
    })
    .await
}

/// Fast-forward the current branch to its upstream (`git pull --ff-only`).
/// Refuses (git's own message) rather than merging/rebasing on divergence —
/// see module doc for why.
/// JS call: `invoke("pull", { path })`.
///
/// BUG FIX: was a plain (non-async) `fn` — per `blocking.rs`'s own doc
/// comment, that runs INLINE on Tauri's main thread. `open_repo`/
/// `take_snapshot` are git2 calls and `git pull --ff-only` is a real network
/// fetch-then-merge, so together this could block the whole window for
/// however long the remote takes to answer. `async fn` + `run_blocking`
/// moves the whole body onto Tauri's blocking-task thread pool.
#[tauri::command]
#[specta::specta]
pub async fn pull(path: String) -> RemoteResult {
    crate::blocking::run_blocking(move || {
        let repo = match open_repo(&path) {
            Ok(r) => r,
            Err(w) => return w,
        };
        let backup = match take_snapshot(&repo) {
            Ok(b) => b,
            Err(e) => return RemoteResult::err(ierrp("err_remote.snapshot_failed", &[("detail", &e)])),
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
            Ok(out) => RemoteResult::err(git_error_message(&path, &out)),
            Err(e) => RemoteResult::err(e),
        }
    })
    .await
}

/// Streaming twin of [`pull`]: identical behaviour — takes the SAME pre-op
/// safety snapshot, stays `--ff-only`, returns the same `backup_ref`, and routes
/// failures through the same `git_error_message` — but forces `--progress` (git
/// pull forwards it to the underlying fetch) and streams stderr via
/// `run_git_streaming`, emitting `"sync-progress"` events for the modal. The
/// ff-only merge summary ("Already up to date." / "Updating …") still lands on
/// stdout, which is captured intact, so the success-message parse below is
/// unchanged. See `fetch_stream` for the (deferred) cancellation rationale.
/// JS call: `invoke("pull_stream", { path })`.
#[tauri::command]
#[specta::specta]
pub async fn pull_stream(app: AppHandle<Wry>, path: String) -> RemoteResult {
    crate::blocking::run_blocking(move || {
        let repo = match open_repo(&path) {
            Ok(r) => r,
            Err(w) => return w,
        };
        let backup = match take_snapshot(&repo) {
            Ok(b) => b,
            Err(e) => return RemoteResult::err(ierrp("err_remote.snapshot_failed", &[("detail", &e)])),
        };
        let mut emit = |line: &str| {
            crate::event_util::emit_on_main(&app, "sync-progress", SyncProgress { phase: "pull".into(), line: line.to_string() });
        };
        match run_git_streaming(&path, &["pull", "--ff-only", "--progress"], &mut emit) {
            Ok(out) if out.ok => {
                let msg = if out.stdout.contains("Already up to date") {
                    "Already up to date.".to_string()
                } else {
                    format!("Pulled (snapshot {}).", short_backup(&backup))
                };
                RemoteResult::ok(msg, Some(backup))
            }
            Ok(out) => RemoteResult::err(git_error_message(&path, &out)),
            Err(e) => RemoteResult::err(e),
        }
    })
    .await
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
///
/// BUG FIX: was a plain (non-async) `fn` — per `blocking.rs`'s own doc
/// comment, that runs INLINE on Tauri's main thread. It's a pure read with no
/// network involved, but `trust::open_repo`/`find_branch` still go through
/// git2 and, for a WSL/UNC path, can stall on the filesystem bridge exactly
/// like the already-fixed `dashboard_repo_status`/`workdir_status` reads did.
/// `async fn` + `run_blocking` keeps it off the main thread regardless.
#[tauri::command]
#[specta::specta]
pub async fn current_upstream(path: String) -> Result<Option<String>, String> {
    crate::blocking::run_blocking(move || {
        let repo = crate::trust::open_repo(&path).map_err(|e| ierrp("err_remote.cannot_open", &[("detail", e.message())]))?;
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
    })
    .await
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
///
/// BUG FIX: was a plain (non-async) `fn` — per `blocking.rs`'s own doc
/// comment, that runs INLINE on Tauri's main thread. It opens the repo and
/// snapshots via git2, then shells out to `git reset --hard`/`git branch -f`,
/// which for a large working tree or a WSL/UNC path can take real time to
/// touch every file. `async fn` + `run_blocking` moves the whole body onto
/// Tauri's blocking-task thread pool so it can't freeze the window.
#[tauri::command]
#[specta::specta]
pub async fn reset_branch_to_upstream(path: String, branch: String) -> RemoteResult {
    crate::blocking::run_blocking(move || {
        if let Err(e) = validate_branch_name(&branch) {
            return RemoteResult::err(e);
        }
        let repo = match open_repo(&path) {
            Ok(r) => r,
            Err(w) => return w,
        };
        let local = match repo.find_branch(&branch, BranchType::Local) {
            Ok(b) => b,
            Err(_) => return RemoteResult::err(ierrp("err_remote.no_local_branch", &[("branch", &format!("{branch:?}"))])),
        };
        let upstream = match local.upstream() {
            Ok(u) => u,
            Err(_) => return RemoteResult::err(ierrp("err_remote.branch_no_upstream_reset", &[("branch", &branch)])),
        };
        let upstream_name = match upstream.name() {
            Ok(Some(n)) => n.to_string(),
            _ => return RemoteResult::err(ierrp("err_remote.upstream_name_not_utf8", &[("branch", &branch)])),
        };

        let backup = match take_snapshot(&repo) {
            Ok(b) => b,
            Err(e) => return RemoteResult::err(ierrp("err_remote.snapshot_failed", &[("detail", &e)])),
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
            Ok(out) => RemoteResult::err(git_error_message(&path, &out)),
            Err(e) => RemoteResult::err(e),
        }
    })
    .await
}

/// Push the current branch. Publishes to "origin" with `--set-upstream` when
/// it has no configured upstream yet; otherwise a plain `git push`. Never
/// force-pushes — a non-fast-forward rejection surfaces git's own message.
/// JS call: `invoke("push", { path })`.
///
/// BUG FIX: was a plain (non-async) `fn` — per `blocking.rs`'s own doc
/// comment, that runs INLINE on Tauri's main thread. `git push` is a real
/// network round-trip that can take anywhere from under a second to a long
/// time on a slow connection or large history, freezing the entire app
/// window for the duration. `async fn` + `run_blocking` moves the whole body
/// onto Tauri's blocking-task thread pool.
#[tauri::command]
#[specta::specta]
pub async fn push(path: String) -> RemoteResult {
    crate::blocking::run_blocking(move || {
        let repo = match open_repo(&path) {
            Ok(r) => r,
            Err(w) => return w,
        };
        let branch = match repo.head().ok().filter(|h| h.is_branch()).and_then(|h| h.shorthand().map(|s| s.to_string())) {
            Some(b) => b,
            None => return RemoteResult::err(ierr("err_remote.head_not_on_branch_push")),
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
            Ok(out) => RemoteResult::err(git_error_message(&path, &out)),
            Err(e) => RemoteResult::err(e),
        }
    })
    .await
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
///
/// BUG FIX: was a plain (non-async) `fn` — per `blocking.rs`'s own doc
/// comment, that runs INLINE on Tauri's main thread. Like plain `push`, this
/// is a real network round-trip (`git push --force[-with-lease]`), so any
/// latency to the remote froze the entire app window, not just the confirm
/// dialog that triggered it. `async fn` + `run_blocking` moves the whole body
/// onto Tauri's blocking-task thread pool.
#[tauri::command]
#[specta::specta]
pub async fn force_push(path: String, lease: bool) -> RemoteResult {
    crate::blocking::run_blocking(move || {
        let repo = match open_repo(&path) {
            Ok(r) => r,
            Err(w) => return w,
        };
        let branch = match repo.head().ok().filter(|h| h.is_branch()).and_then(|h| h.shorthand().map(|s| s.to_string())) {
            Some(b) => b,
            None => return RemoteResult::err(ierr("err_remote.head_not_on_branch_force_push")),
        };
        let has_upstream = repo.find_branch(&branch, BranchType::Local).ok().and_then(|b| b.upstream().ok()).is_some();
        if !has_upstream {
            return RemoteResult::err(ierr("err_remote.no_upstream_use_push"));
        }
        let remote = match repo.branch_upstream_remote(&format!("refs/heads/{branch}")) {
            Ok(buf) => match buf.as_str() {
                Some(s) => s.to_string(),
                None => return RemoteResult::err(ierr("err_remote.upstream_remote_not_utf8")),
            },
            Err(e) => return RemoteResult::err(ierrp("err_remote.cannot_resolve_upstream_remote", &[("detail", &e.to_string())])),
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
            Ok(out) => RemoteResult::err(git_error_message(&path, &out)),
            Err(e) => RemoteResult::err(e),
        }
    })
    .await
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
///
/// BUG FIX: was a plain (non-async) `fn` — per `blocking.rs`'s own doc
/// comment, that runs INLINE on Tauri's main thread. It shells out to
/// `git push` over the network (no git2 involved at all, but that doesn't
/// matter — `Command::new`/subprocess waits block just as hard as libgit2
/// calls), so any latency talking to the remote froze the whole window.
/// `async fn` + `run_blocking` moves it onto Tauri's blocking-task thread pool.
#[tauri::command]
#[specta::specta]
pub async fn push_tag(path: String, remote: Option<String>, name: String) -> RemoteResult {
    crate::blocking::run_blocking(move || {
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
            Ok(out) => RemoteResult::err(git_error_message(&path, &out)),
            Err(e) => RemoteResult::err(e),
        }
    })
    .await
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
///
/// BUG FIX: was a plain (non-async) `fn` — per `blocking.rs`'s own doc
/// comment, that runs INLINE on Tauri's main thread. It opens the repo via
/// git2 and then shells out to `git push` over the network, so — same as
/// `push`/`force_push` — any latency reaching the remote froze the entire
/// app window for the duration. `async fn` + `run_blocking` moves the whole
/// body onto Tauri's blocking-task thread pool.
#[tauri::command]
#[specta::specta]
pub async fn push_branch(path: String, branch: String, remote: Option<String>, remote_branch: Option<String>) -> RemoteResult {
    crate::blocking::run_blocking(move || {
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
            Err(_) => return RemoteResult::err(ierrp("err_remote.no_such_local_branch", &[("branch", &branch)])),
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
            Ok(out) => RemoteResult::err(git_error_message(&path, &out)),
            Err(e) => RemoteResult::err(e),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(stderr: &str) -> GitOut {
        GitOut { ok: false, code: Some(128), stdout: String::new(), stderr: stderr.to_string() }
    }

    #[test]
    fn git_error_message_appends_the_wsl_ssh_hint_only_on_a_wsl_path() {
        let msg = git_error_message(r"\\wsl.localhost\Ubuntu\home\jc\repo", &out("Permission denied (publickey)."));
        // Now an i18n key; the raw git stderr rides along verbatim as the `base` param.
        assert!(msg.contains("err_remote.ssh_publickey_wsl_hint"), "expected the WSL-specific hint key: {msg:?}");
        assert!(msg.contains("Permission denied (publickey)."), "original stderr must travel as a param: {msg:?}");
    }

    #[test]
    fn git_error_message_leaves_a_non_wsl_permission_error_unmodified() {
        let msg = git_error_message(r"C:\Users\jc\repo", &out("Permission denied (publickey)."));
        assert_eq!(msg, "Permission denied (publickey).", "a plain Windows-path repo must never see the WSL-specific hint");
    }

    #[test]
    fn git_error_message_leaves_a_wsl_path_non_ssh_error_unmodified() {
        let msg = git_error_message(r"\\wsl.localhost\Ubuntu\home\jc\repo", &out("fatal: not a git repository"));
        assert_eq!(msg, "fatal: not a git repository", "only an actual SSH permission failure should get the hint");
    }

    // Every git subprocess runs with stdin(Stdio::null()) and no console (see
    // wsl::git_command), so ssh can never interactively prompt to trust a
    // new host key — this hits BOTH WSL and plain Windows repos (unlike the
    // publickey case above, which is WSL-only), since each side has its own
    // separate known_hosts file that may simply never have seen this host
    // before, regardless of what another tool has already trusted elsewhere.
    #[test]
    fn git_error_message_appends_a_host_key_hint_on_a_wsl_path() {
        let msg = git_error_message(
            r"\\wsl.localhost\Ubuntu\home\jc\repo",
            &out("Host key verification failed.\r\nfatal: Could not read from remote repository."),
        );
        assert!(msg.contains("err_remote.host_key_wsl_hint"), "expected the WSL-specific host-key hint key: {msg:?}");
        assert!(msg.contains("Host key verification failed."), "original stderr must travel as a param: {msg:?}");
    }

    #[test]
    fn git_error_message_appends_a_host_key_hint_on_a_plain_windows_path_too() {
        let msg = git_error_message(
            r"C:\Users\jc\repo",
            &out("Host key verification failed.\r\nfatal: Could not read from remote repository."),
        );
        assert!(msg.contains("err_remote.host_key_hint"), "expected the plain-path host-key hint key: {msg:?}");
        assert!(msg.contains("Host key verification failed."), "original stderr must travel as a param: {msg:?}");
        assert!(!msg.contains("host_key_wsl_hint"), "a non-WSL repo must never use the WSL-specific hint key: {msg:?}");
    }

    #[test]
    fn git_error_message_falls_back_to_stdout_then_a_generic_message() {
        let mut o = out("");
        o.stdout = "some stdout text".to_string();
        assert_eq!(git_error_message("/any/path", &o), "some stdout text");

        let empty = GitOut { ok: false, code: Some(1), stdout: String::new(), stderr: String::new() };
        assert_eq!(
            git_error_message("/any/path", &empty),
            crate::i18n_err::ierrp("err_remote.git_exited_status", &[("code", "Some(1)")])
        );
    }

    // Drive `feed_progress` chunk-by-chunk (mirroring run_git_streaming's read
    // loop, including the final flush) and collect every emitted segment.
    fn segment(chunks: &[&[u8]]) -> Vec<String> {
        let mut seg: Vec<u8> = Vec::new();
        let mut lines: Vec<String> = Vec::new();
        let mut on_line = |s: &str| lines.push(s.to_string());
        for c in chunks {
            feed_progress(c, &mut seg, &mut on_line);
        }
        if !seg.is_empty() {
            on_line(String::from_utf8_lossy(&seg).trim_end());
        }
        lines
    }

    #[test]
    fn feed_progress_splits_on_both_carriage_return_and_newline() {
        // git rewrites the SAME progress line with \r, ending a phase with \n.
        let input = b"remote: Counting objects: 100%\rReceiving objects:  42% (42/100)\rReceiving objects: 100% (100/100)\nResolving deltas: 100% (10/10)\n";
        assert_eq!(
            segment(&[input]),
            vec![
                "remote: Counting objects: 100%",
                "Receiving objects:  42% (42/100)",
                "Receiving objects: 100% (100/100)",
                "Resolving deltas: 100% (10/10)",
            ]
        );
    }

    #[test]
    fn feed_progress_flushes_a_final_segment_with_no_trailing_delimiter() {
        assert_eq!(segment(&[b"done."]), vec!["done."]);
    }

    #[test]
    fn feed_progress_reassembles_a_segment_and_a_utf8_char_split_across_chunks() {
        // A segment (and a multi-byte char, "é" = 0xC3 0xA9) split across two
        // reads must reassemble, not corrupt or drop.
        let lines = segment(&[b"Receiving obj\xc3", b"\xa9cts: 5%\rok\n"]);
        assert_eq!(lines, vec!["Receiving objécts: 5%", "ok"]);
    }

    #[test]
    fn feed_progress_ignores_empty_segments_from_blank_lines() {
        // Back-to-back delimiters (e.g. \r\n or a blank line) must not emit "".
        assert_eq!(segment(&[b"a\r\n\nb\n"]), vec!["a", "b"]);
    }
}
