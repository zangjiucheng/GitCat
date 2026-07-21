//! Rebase: replay the current branch's commits onto a target, with a real
//! conflict-per-commit path. Two entry points share everything below this
//! point (state inspection, continue/skip/abort): [`rebase_start`] (linear —
//! a plain `git rebase <onto>`, no todo list) and [`rebase_interactive_start`]
//! (a real todo-list sequencer: reorder/pick/squash/fixup/drop/edit).
//!
//! Mirrors git_merge.rs's / git_pick.rs's model exactly (read git_merge.rs's
//! doc comment first): every mutation SNAPSHOTS first (Safety Manager), then
//! shells out to the git CLI — libgit2 has no rebase porcelain of its own that
//! tracks CLI-compatible sequencer state, and the CLI owns the in-progress
//! state (the `rebase-merge`/`rebase-apply` directory, conflict markers,
//! `--continue`/`--skip`/`--abort`). git2 is used only to open the repo, read
//! HEAD's identity, and locate the git dir for that sequencer state.
//!
//! KEY DISCOVERY (empirically reconfirmed on git 2.53.0 before writing the
//! code below): git's modern default backend for ANY rebase — interactive or
//! not — is the "merge" backend, which uses the exact same `rebase-merge/`
//! directory and `git-rebase-todo` file `-i` uses (`tests/rebase.rs` already
//! asserts `RepositoryState::RebaseInteractive` for a plain, non-`-i`
//! `rebase_start`). This means `in_progress`/`stopped_label`/`onto_label`/
//! `conflict.rs`'s op-detection/the resolver's whole dispatch ALREADY work
//! against `-i`-shaped state — zero changes were needed anywhere but this
//! file, and inside this file only `classify` gained one new branch (see
//! "editing" below) and two new commands were added alongside the existing
//! four.
//!
//! Interactive todo mechanism (see [`rebase_interactive_start`]'s own doc for
//! the full empirical trail): git invokes
//! `<GIT_SEQUENCE_EDITOR> <path-to-git-rebase-todo>` (one trailing arg,
//! through a real shell) and then re-reads that same file back. GitCat
//! precomputes the ENTIRE todo (every row explicit — see [`build_todo_text`]
//! for why "drop" must never be an omitted line) into a real file under
//! `<git-dir>/gitgui/rebase-todo/`, then sets
//! `GIT_SEQUENCE_EDITOR = "cp '<shell-quoted path>'"` so git's own copy just
//! overwrites the todo git generated with GitCat's precomputed one.
//! `GIT_EDITOR=true` is unchanged from every existing op (squash's
//! auto-concatenated message is accepted verbatim — no real editor ever
//! opens).
//!
//! Semantics: `git rebase <onto>` (or `git rebase -i <onto>` with a
//! precomputed todo) replays every commit reachable from HEAD but not from
//! `<onto>` on top of `<onto>`, then fast-forwards the current branch. Rebase
//! is the ONE op (of cherry-pick/merge/rebase) where a mid-sequence SKIP is
//! meaningful — it drops the commit currently being replayed entirely,
//! distinct from Abort (undo everything) and Continue (keep going after a
//! resolved conflict, OR past an "editing" pause — see below).
//!
//! State machine returned to the UI (`RebaseResult.state`):
//!   "clean"    — the rebase completed (all commits replayed, or there was
//!                nothing to replay and the branch was already up to date is
//!                reported as "empty" instead — see below); the branch tip
//!                moved (or, for a genuine no-op, stayed put) and the working
//!                tree is clean.
//!   "conflict" — a real conflict while replaying a commit (a plain `pick`,
//!                OR the internal cherry-pick a `squash`/`fixup` step itself
//!                performs — empirically verified to look IDENTICAL to a
//!                plain-pick conflict from here: non-empty unmerged files);
//!                `conflicted_files` is non-empty and the repo is mid-rebase.
//!                The UI opens the resolver, then calls `rebase_continue`,
//!                `rebase_skip`, or `rebase_abort`. EMPIRICALLY VERIFIED (see
//!                tests/rebase.rs) that continuing past one conflict straight
//!                into a SECOND conflicting commit re-reports "conflict" (not
//!                falsely "clean") — `git rebase --continue`/`--skip` exit
//!                non-zero and leave the sequencer's unmerged files populated
//!                exactly like the first conflict, so the SAME
//!                state-inspection logic (not message-scraping) that
//!                classifies the first conflict also classifies every
//!                subsequent one in the sequence.
//!   "editing"  — NEW: the sequencer stopped cleanly at an `edit` todo line —
//!                the commit is already checked out/committed, nothing is
//!                conflicted, the user can amend it (e.g. via
//!                `workdir::commit(path, msg, amend: true)`, reused UNCHANGED
//!                — see tests/rebase.rs's
//!                `rebase_interactive_edit_amend_via_workdir_commit_then_continue`)
//!                then call `rebase_continue`. EMPIRICALLY DERIVED distinguishing
//!                signal (see tests/rebase.rs for the full 4-scenario matrix
//!                this was built from): checked ONLY once `unmerged_files()`
//!                is empty (so it can never shadow a real, or squash-step,
//!                conflict — a squash-step conflict ALSO leaves
//!                `rebase-merge/amend` present, which is why `amend` alone is
//!                NOT a safe discriminant and is never consulted), a plain
//!                `rebase-merge/stopped-sha` file existing means "stopped
//!                cleanly", and — checked in that order — this is reached
//!                strictly before the existing hook/gpgsign `in_progress`
//!                fallback below, which empirically never leaves a
//!                `stopped-sha` behind at all.
//!   "empty"    — HEAD is already based on (up to date with) `<onto>` — git
//!                itself reports "…up to date." and mutates nothing.
//!   "error"    — anything else (dirty-tree refusal, bad revision, a stale/
//!                mismatched interactive todo caught before any mutation, …);
//!                `message` carries a message (git's own stderr, or GitCat's
//!                own pre-flight refusal). No in-progress state is left
//!                behind and, for a pre-flight refusal, no snapshot is taken.
//!
//! Failure model (like git_merge / git_pick): commands return a plain
//! [`RebaseResult`], never a Rust `Err`, so the JS promise always resolves.
//! ([`rebase_interactive_plan`] is the one exception — it is a pure READ with
//! no mutation and no snapshot, so it returns a plain `Result` like
//! git_read.rs's reads.)
//!
//! Why a dedicated `RebaseResult` rather than reusing `PickResult`/
//! `MergeResult`: the field shape is identical today (same convention
//! discussion as git_merge.rs's `MergeResult` vs `PickResult`) — one result
//! type per operation module keeps each module's public API self-describing
//! in the generated TS bindings, and leaves room for a rebase-specific field
//! (e.g. sequence progress) later without a breaking rename.
//!
//! `rebase_continue`/`rebase_skip`/`rebase_abort` are REUSED UNCHANGED for the
//! interactive path — empirically confirmed (tests/rebase.rs) that all three
//! operate purely on generic sequencer state with no assumption about how the
//! rebase was started: abort during an "editing" pause fully restores the
//! pre-rebase HEAD exactly like abort-during-conflict; continue during an
//! "editing" pause (with or without an amend first) proceeds exactly like
//! continuing past a resolved conflict.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{Oid, Repository, Sort};
use serde::{Deserialize, Serialize};

use crate::procutil::NoConsoleWindowExt;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/// Result of any rebase step (start / continue / skip / abort). Serializes
/// camelCase: `conflictedFiles`, `backupRef`.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseResult {
    pub ok: bool,
    /// "clean" | "conflict" | "editing" | "empty" | "error"
    pub state: String,
    /// Repo-relative paths with unmerged entries — non-empty only when
    /// `state == "conflict"`.
    pub conflicted_files: Vec<String>,
    pub message: String,
    /// Pre-op safety snapshot ref (present when we snapshotted before mutating),
    /// so the UI can name the snapshot the user can Undo to.
    pub backup_ref: Option<String>,
    /// True SPECIFICALLY when `state == "error"` because git refused the
    /// rebase outright — the dirty working tree or index would collide with
    /// it — rather than some other refusal (bad revision, a rebase already
    /// in progress, hook rejection, …). See `blocked_by_local_changes` (the
    /// free function below) for the empirical detection; `false` for every
    /// other outcome, including every success/conflict/editing/empty state,
    /// so the frontend can offer a "stash and retry" action without doing
    /// any prose-matching of its own — same design as git_pick.rs's field of
    /// the same name (see that field's own doc comment).
    pub blocked_by_local_changes: bool,
}

impl RebaseResult {
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

/// EMPIRICALLY VERIFIED (git 2.53.0, default config — `rebase.autoStash`
/// must be off, see `rebase_start`'s `--no-autostash`): a rebase refused
/// because local changes are in the way reports "error: cannot rebase: You
/// have unstaged changes." or "...uncommitted changes." — completely
/// different wording from cherry-pick/merge/revert's "would be overwritten
/// by", hence a dedicated detector rather than a shared one (duplicated per
/// module per this codebase's own convention — see git_pick.rs's function of
/// the same name).
fn blocked_by_local_changes(stderr: &str) -> bool {
    let blob = stderr.to_lowercase();
    blob.contains("cannot rebase")
        && (blob.contains("unstaged changes") || blob.contains("uncommitted changes"))
}

/// One row the interactive-rebase planner shows: a plannable (non-merge)
/// commit between `onto` and HEAD, oldest-first (this IS the replay/todo
/// order — see [`commit_range`]). `sha` is the full 40-hex id so a
/// [`TodoItem`] built from it round-trips exactly; `subject` is
/// `commit.summary()` (guaranteed single-line by libgit2 — truncates at the
/// first blank line) and is ALWAYS what gets written into the precomputed
/// todo file's trailing text — never a caller-supplied string (see
/// [`rebase_interactive_start`]'s doc comment for why that matters).
/// Serializes camelCase: `shortSha`.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanCommit {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
}

/// One planner row's chosen action, as sent back to [`rebase_interactive_start`].
/// `sha` is validated against a FRESHLY recomputed commit range before
/// anything is written or mutated — see that command's doc comment.
/// `action` is one of `"pick" | "squash" | "fixup" | "drop" | "edit"`.
#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub sha: String,
    pub action: String,
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
/// commit-message editor (`true` exits 0 immediately) via `GIT_EDITOR`
/// AND `GIT_SEQUENCE_EDITOR` — the latter matters even for a NON-interactive
/// rebase because `--continue`/`--skip` can still shell out to it when
/// finishing up. Neither should ever block a headless app. Returns `Err` only
/// if git can't spawn.
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

/// Like [`git`], but for [`rebase_interactive_start`]'s one specific need: an
/// arbitrary extra `(key, value)` env var (`GIT_SEQUENCE_EDITOR` set to the
/// precomputed-todo `cp` invocation — see that command's doc comment) rather
/// than the blanket `no_editor` no-op. Kept as its own tiny function (not a
/// third parameter bolted onto `git`) so every EXISTING call site's signature
/// is completely undisturbed.
fn git_with_env(path: &str, args: &[&str], envs: &[(&str, &str)]) -> Result<Out, String> {
    let mut cmd = Command::new("git");
    cmd.no_console_window();
    cmd.arg("-C").arg(path).args(args);
    for (k, v) in envs {
        cmd.env(k, v);
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
fn validate_rev(rev: &str) -> Result<(), String> {
    if rev.is_empty() {
        return Err("No target to rebase onto.".into());
    }
    if rev.starts_with('-') {
        return Err(format!("Refusing a revision that looks like a flag: {rev:?}"));
    }
    if rev.chars().any(|c| c.is_control()) {
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

/// True while a rebase is in progress: the sequencer keeps a `rebase-merge`
/// (the modern, default backend — verified on git 2.53.0 for a plain
/// non-interactive `git rebase <upstream>`) or `rebase-apply` (the older
/// patch-based backend, kept for completeness) directory in the git dir until
/// the rebase finishes/aborts. `repo.path()` is the git dir, so this is
/// correct for worktrees and non-standard layouts too.
fn in_progress(repo: &Repository) -> bool {
    repo.path().join("rebase-merge").exists() || repo.path().join("rebase-apply").exists()
}

/// Current branch shorthand for friendlier messages, else "HEAD". During a
/// rebase HEAD is detached (replaying commits one at a time), so this is only
/// meaningful before starting / after finishing.
fn head_name(repo: &Repository) -> String {
    match repo.head() {
        Ok(h) if h.is_branch() => h.shorthand().unwrap_or("HEAD").to_string(),
        _ => "HEAD".to_string(),
    }
}

/// A short, human label for the commit the sequencer is currently stopped on
/// (read from `rebase-merge/stopped-sha` while in progress), for `continue`/
/// `skip` messages. Falls back to "the commit" — best-effort, never blocks.
fn stopped_label(repo: &Repository, path: &str) -> String {
    let full = repo.path().join("rebase-merge").join("stopped-sha");
    let sha = std::fs::read_to_string(full).ok().map(|s| s.trim().to_string());
    match sha.filter(|s| !s.is_empty()) {
        Some(sha) => git(path, &["rev-parse", "--short", &sha], false)
            .ok()
            .filter(|o| o.ok)
            .map(|o| o.stdout)
            .filter(|s| !s.is_empty())
            .unwrap_or(sha),
        None => "the commit".to_string(),
    }
}

/// Compact tail of a backup ref, e.g. ".../1720000000-42-3" -> "1720000000-42-3".
fn short_backup(r: &str) -> String {
    r.rsplit('/').next().unwrap_or(r).to_string()
}

// ---------------------------------------------------------------------------
// Interactive rebase: commit-range revwalk + precomputed-todo mechanism
// ---------------------------------------------------------------------------

/// Rebase-todo verbs GitCat's planner may emit — kept as a small allowlist so
/// a bad/unknown action is refused with a clean message before it ever
/// reaches a file git will parse.
const TODO_ACTIONS: [&str; 5] = ["pick", "squash", "fixup", "drop", "edit"];

/// Process-wide monotonic tie-breaker for precomputed-todo filenames,
/// mirroring `workdir.rs`'s `DISCARD_SEQ`/`STASH_SEQ` — a separate counter
/// since this names its own sidecar files.
static TODO_SEQ: AtomicU64 = AtomicU64::new(0);

/// Resolve `rev` to a commit oid via the canonical revparse + peel-to-commit
/// pattern already used by `git_bisect.rs`'s `canonical_oid`.
fn resolve_oid(repo: &Repository, rev: &str) -> Result<Oid, String> {
    let obj = repo
        .revparse_single(rev)
        .map_err(|e| format!("Cannot resolve revision {rev:?}: {}", e.message()))?;
    let commit = obj
        .peel_to_commit()
        .map_err(|e| format!("Revision {rev:?} is not a commit: {}", e.message()))?;
    Ok(commit.id())
}

/// Oldest-first list of PLANNABLE (non-merge) commit oids reachable from HEAD
/// but not from `onto` — mirrors git's own default (non-`-r`)
/// interactive-rebase todo: merge commits are silently dropped entirely, the
/// rest flattened into one linear pick sequence. EMPIRICALLY VERIFIED against
/// `git rev-list --no-merges --reverse --topo-order <onto>..HEAD` producing
/// the identical ordering (see this module's doc comment / design notes).
/// Shared by [`rebase_interactive_plan`] (what to show) and
/// [`rebase_interactive_start`] (what to validate the caller's todo against —
/// re-derived fresh, never trusted from the frontend).
fn commit_range(repo: &Repository, onto: Oid) -> Result<Vec<Oid>, String> {
    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    walk.set_sorting(Sort::TOPOLOGICAL)
        .map_err(|e| e.message().to_string())?;
    walk.push_head()
        .map_err(|e| format!("Cannot walk from HEAD: {}", e.message()))?;
    walk.hide(onto)
        .map_err(|e| format!("Cannot resolve target: {}", e.message()))?;

    let mut oids: Vec<Oid> = Vec::new();
    for oid in walk {
        let oid = oid.map_err(|e| e.message().to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.message().to_string())?;
        // Drop merge commits (>1 parent) — matches git's own silent-drop
        // default; see module doc for why a merge is never a plannable row.
        if commit.parent_count() <= 1 {
            oids.push(oid);
        }
    }
    oids.reverse(); // revwalk is newest-first; oldest-first is the replay/todo order.
    Ok(oids)
}

/// [`PlanCommit`] rows for `oids`, in the SAME order given (oldest-first).
fn plan_commits(repo: &Repository, oids: &[Oid]) -> Result<Vec<PlanCommit>, String> {
    oids.iter()
        .map(|&oid| {
            let commit = repo.find_commit(oid).map_err(|e| e.message().to_string())?;
            let sha = oid.to_string();
            let short_sha = sha.chars().take(7).collect();
            Ok(PlanCommit {
                sha,
                short_sha,
                subject: commit.summary().unwrap_or("").to_string(),
            })
        })
        .collect()
}

/// POSIX single-quote a shell argument: wrap in `'...'`, and if the string
/// itself contains a literal `'`, close the quote, escape it, and reopen —
/// the standard `'\''` idiom. EMPIRICALLY VERIFIED (git 2.53.0, macOS)
/// against both a path containing a space and a path containing a literal
/// `'` — see this module's doc comment for the full trail. This is the exact
/// analogue of `workdir.rs`'s `literal_pathspec` helper: one small, targeted
/// escaping function for one specific injection class.
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// `<git-dir>/gitgui/rebase-todo/` — reuses the existing `<git-dir>/gitgui/`
/// sidecar convention already established for `workdir.rs`'s
/// `discard-backup/`/`stash-conflict.json`, rather than `std::env::temp_dir()`
/// — keeps it repo-scoped, inspectable, and cleaned up the same way.
fn todo_dir(repo: &Repository) -> PathBuf {
    repo.path().join("gitgui").join("rebase-todo")
}

/// Build the ENTIRE precomputed todo text: one explicit verb line per commit,
/// in order — NEVER omit a line, even for "drop" (see this module's doc
/// comment: omitting every line produces a genuinely empty file, and git
/// refuses an empty todo with "nothing to do" instead of doing what the user
/// asked — an explicit `drop` line for every commit succeeds cleanly and
/// lands HEAD on `onto`). The trailing "subject" text after each sha is
/// ALWAYS a freshly re-read `commit.summary()` (guaranteed single-line by
/// libgit2 — truncates at the first blank line) — NEVER the frontend's copy
/// of it — and any embedded `\n`/`\r` is defensively stripped so it can never
/// smuggle a second, real todo line (git's todo parser only tokenizes the
/// first two words of each line; the trailing text is purely cosmetic and
/// never affects the replayed commit's real message).
fn build_todo_text(repo: &Repository, todo: &[TodoItem]) -> Result<String, String> {
    let mut text = String::new();
    for item in todo {
        let oid = Oid::from_str(&item.sha)
            .map_err(|e| format!("Bad commit id {:?}: {}", item.sha, e.message()))?;
        let commit = repo
            .find_commit(oid)
            .map_err(|e| format!("Cannot find commit {:?}: {}", item.sha, e.message()))?;
        let subject: String = commit
            .summary()
            .unwrap_or("")
            .chars()
            .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
            .collect();
        text.push_str(&item.action);
        text.push(' ');
        text.push_str(&item.sha);
        text.push(' ');
        text.push_str(&subject);
        text.push('\n');
    }
    Ok(text)
}

/// Write `text` to a freshly, uniquely named file under [`todo_dir`]
/// (creating the directory if needed) and return its path. Naming mirrors
/// `workdir.rs`'s discard-backup convention: `<secs>-<nanos>-<seq>` so two
/// interactive rebases started back-to-back (even within the same process)
/// can never collide.
fn write_precomputed_todo(repo: &Repository, text: &str) -> Result<PathBuf, String> {
    let dir = todo_dir(repo);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create rebase-todo dir: {e}"))?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let seq = TODO_SEQ.fetch_add(1, Ordering::SeqCst);
    let path = dir.join(format!("{}-{}-{}-todo", now.as_secs(), now.subsec_nanos(), seq));
    fs::write(&path, text).map_err(|e| format!("could not write precomputed todo: {e}"))?;
    Ok(path)
}

/// Turn a finished `rebase` / `--continue` / `--skip` run into a
/// [`RebaseResult`] by inspecting the resulting REPO STATE (not by scraping
/// git's prose, except for the one benign "nothing happened" case git only
/// reports via message text: "up to date"). `label` is a display name for the
/// rebase target (`onto`); `backup` is the pre-op snapshot ref (`None` when we
/// couldn't/didn't snapshot).
fn classify(
    repo: &Repository,
    path: &str,
    out: &Out,
    backup: Option<String>,
    label: &str,
) -> RebaseResult {
    let snap_note = backup
        .as_deref()
        .map(|b| format!(" (snapshot {})", short_backup(b)))
        .unwrap_or_default();

    // A real conflict: the index has unmerged entries. This is the SAME check
    // whether we just landed on the FIRST conflicting commit or continued/
    // skipped straight into a SECOND (or Nth) one — empirically verified (see
    // tests/rebase.rs) that every stop in the sequence looks identical here.
    // Checked BEFORE `out.ok` (a conflict always makes git exit non-zero, so
    // this never fires when `out.ok` is true, but keeping it textually first
    // documents that a genuine conflict always wins over every other read).
    let conflicts = unmerged_files(path);
    if !conflicts.is_empty() {
        let n = conflicts.len();
        return RebaseResult {
            ok: false,
            state: "conflict".into(),
            conflicted_files: conflicts,
            message: format!(
                "Rebase onto {label} hit a conflict in {n} file{}. Resolve them, then Continue \
                 — or Skip this commit, or Abort.",
                if n == 1 { "" } else { "s" }
            ),
            backup_ref: backup,
            blocked_by_local_changes: false,
        };
    }

    // No unmerged files, but the sequencer stopped cleanly at an `edit` todo
    // line: the commit is already checked out (and committed — nothing to
    // resolve), the working tree is clean, and the user is free to amend it
    // before continuing. EMPIRICALLY DERIVED (see this module's doc comment
    // and tests/rebase.rs): `rebase-merge/stopped-sha` existing, checked ONLY
    // after confirming there are no unmerged files (so this can never shadow
    // a real or squash-step conflict, both of which also leave `stopped-sha`
    // — and a squash-step conflict ALSO leaves `rebase-merge/amend`, which is
    // why `amend` is never consulted as a discriminant on its own), means a
    // clean stop rather than a conflict.
    //
    // CRITICAL — checked BEFORE `out.ok`, not just before the `in_progress`
    // fallback: EMPIRICALLY VERIFIED that `git rebase -i` exits ZERO for a
    // clean `edit` stop (unlike a conflict, which always exits non-zero). If
    // this check sat inside the `!out.ok` branch (as a first pass at this
    // logic did), a clean edit-pause would fall into the `out.ok` branch
    // below and be misreported as "clean" — see tests/rebase.rs's
    // `rebase_interactive_edit_pauses_cleanly_state_is_editing` (and its
    // sibling amend/abort tests), which caught exactly this regression.
    if repo.path().join("rebase-merge").join("stopped-sha").exists() {
        let sha = stopped_label(repo, path);
        return RebaseResult {
            ok: false,
            state: "editing".into(),
            conflicted_files: Vec::new(),
            message: format!("Rebase paused to edit {sha} — amend it, then Continue."),
            backup_ref: backup,
            blocked_by_local_changes: false,
        };
    }

    if out.ok {
        // Verified on git 2.53.0: a no-op rebase (HEAD already based on
        // <onto>) exits 0 and prints "Current branch <name> is up to date."
        // — nothing is mutated. Report it as a benign no-op (parity with
        // merge's "empty"), not "clean".
        let blob = format!("{} {}", out.stdout, out.stderr).to_lowercase();
        if blob.contains("up to date") || blob.contains("up-to-date") {
            return RebaseResult {
                ok: false,
                state: "empty".into(),
                conflicted_files: Vec::new(),
                message: format!(
                    "{} is already up to date with {label} — nothing to rebase.",
                    head_name(repo)
                ),
                backup_ref: backup,
                blocked_by_local_changes: false,
            };
        }
        return RebaseResult {
            ok: true,
            state: "clean".into(),
            conflicted_files: Vec::new(),
            message: format!("Rebased {} onto {label}{snap_note}.", head_name(repo)),
            backup_ref: backup,
            blocked_by_local_changes: false,
        };
    }

    // No unmerged files. If the sequencer is still active, the replay itself
    // resolved cleanly but the concluding commit could not be created (hook
    // rejection, gpg-sign failure, …). We must NEVER auto-abort + mislabel
    // this as clean (it would silently discard progress), and must NEVER
    // return "error" while mid-rebase (the UI's error path doesn't open the
    // resolver -> orphaned sequencer state with no Abort/Skip button).
    if in_progress(repo) {
        return RebaseResult {
            ok: false,
            state: "conflict".into(),
            conflicted_files: Vec::new(),
            message: format!(
                "Rebase onto {label} could not finish: {}. Continue to retry, Skip this commit, \
                 or Abort.",
                git_msg(out)
            ),
            backup_ref: backup,
            blocked_by_local_changes: false,
        };
    }

    // Not mid-rebase (dirty-tree refusal, bad revision, rebase already in
    // progress refused by git itself, …): surface git verbatim. Never forced.
    RebaseResult {
        ok: false,
        state: "error".into(),
        conflicted_files: Vec::new(),
        message: git_msg(out),
        backup_ref: backup,
        blocked_by_local_changes: blocked_by_local_changes(&out.stderr),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands (registered in lib.rs)
// ---------------------------------------------------------------------------

/// Rebase the current branch onto `onto`. Snapshots FIRST, then runs
/// `git rebase --end-of-options <onto>` (linear only — no `-i`; a
/// `GIT_SEQUENCE_EDITOR=true`/`GIT_EDITOR=true` non-interactive editor is set
/// so nothing can block a headless app).
///
/// A dirty working tree makes git refuse the rebase — that surfaces as
/// `state:"error"` with git's own message; we never force. On a conflict this
/// resolves to `state:"conflict"` (repo left mid-rebase for the resolver), NOT
/// a failure.
///
/// JS: `invoke("rebase_start", { path, onto })`.
///
/// Opens the repo and takes a safety snapshot with git2, then shells out to
/// the git CLI to replay every commit in the range — both steps scale with
/// history/working-tree size. As a plain sync command this ran inline on
/// Tauri's main thread, freezing the whole app window (not just the rebase
/// panel) for as long as the rebase took; `async fn` + `run_blocking` moves
/// it onto Tauri's blocking-task thread pool instead.
#[tauri::command]
#[specta::specta]
pub async fn rebase_start(path: String, onto: String) -> RebaseResult {
    crate::blocking::run_blocking(move || {
        if let Err(e) = validate_rev(&onto) {
            return RebaseResult::error(e);
        }
        let repo = match crate::trust::open_repo(&path) {
            Ok(r) => r,
            Err(e) => return RebaseResult::error(format!("Cannot open repository: {}", e.message())),
        };

        // Refuse to stack a new rebase on top of an unfinished one.
        if in_progress(&repo) {
            return RebaseResult::error("A rebase is already in progress — resolve or abort it first.");
        }

        // Snapshot FIRST — never mutate without a pre-op backup. If it fails, abort.
        let backup = match crate::safety::snapshot(&repo) {
            Ok(b) => b,
            Err(e) => return RebaseResult::error(format!("Safety snapshot failed, aborting: {e}")),
        };

        // git rebase --no-autostash --end-of-options <onto>
        //
        // --no-autostash is explicit, not incidental: with an ambient
        // `rebase.autoStash=true` in the user's global gitconfig, a dirty tree
        // that collides with the rebase doesn't refuse up front — git silently
        // stashes it, rebases, and re-applies the stash. If THAT reapply itself
        // conflicts, git still exits 0 (the rebase's own sequencer state is
        // gone), so `classify()` below (which checks unmerged_files
        // unconditionally, not gated on in_progress) reports a normal
        // "conflict" and opens the Resolver — but `rebase_continue`/
        // `rebase_skip`/`rebase_abort` all gate on `in_progress()` first and
        // find the rebase already concluded: continue/skip then error ("no
        // rebase in progress") and abort falsely reports "clean", silently
        // leaving real conflict markers in the working tree with the user's
        // original edit stranded in `stash@{0}`. Passing --no-autostash makes
        // the dirty-tree case refuse up front instead, matching this module's
        // own "never leave the tree in a misleading state" contract —
        // independent of what the user's global gitconfig happens to set.
        let args: Vec<&str> = vec!["rebase", "--no-autostash", "--end-of-options", &onto];

        let out = match git(&path, &args, true) {
            Ok(o) => o,
            Err(e) => {
                return RebaseResult {
                    ok: false,
                    state: "error".into(),
                    conflicted_files: Vec::new(),
                    message: e,
                    backup_ref: Some(backup),
                    blocked_by_local_changes: false,
                }
            }
        };

        classify(&repo, &path, &out, Some(backup), &onto)
    })
    .await
}

/// Continue an in-progress rebase after the user resolved the conflict (files
/// were `git add`ed by the resolver). Runs `git rebase --continue` with
/// `GIT_EDITOR=true`/`GIT_SEQUENCE_EDITOR=true` so it commits the resolution
/// non-interactively.
///
/// Re-classifies the outcome: `clean` once the whole sequence finishes,
/// `conflict` again if THIS commit is still unresolved, or — critically —
/// `conflict` again if resolving this commit landed on the NEXT conflicting
/// commit in the sequence (empirically verified, see tests/rebase.rs).
///
/// JS: `invoke("rebase_continue", { path })`.
///
/// Opens the repo and shells out `git rebase --continue`, which can itself
/// replay one or more further commits before stopping again — a call whose
/// cost scales with how much of the sequence is left. As a plain sync
/// command this blocked the whole app window on Tauri's main thread for as
/// long as that replay took; `run_blocking` moves it off the main thread.
#[tauri::command]
#[specta::specta]
pub async fn rebase_continue(path: String) -> RebaseResult {
    crate::blocking::run_blocking(move || {
        let repo = match crate::trust::open_repo(&path) {
            Ok(r) => r,
            Err(e) => return RebaseResult::error(format!("Cannot open repository: {}", e.message())),
        };
        if !in_progress(&repo) {
            return RebaseResult::error("No rebase in progress to continue.");
        }

        // Name the target (for messages) while the sequencer's `onto` file exists.
        let label = onto_label(&repo, &path);

        // Snapshot the pre-commit state. Best-effort: continue must remain
        // possible even if it can't run.
        let backup = crate::safety::snapshot(&repo).ok();

        let out = match git(&path, &["rebase", "--continue"], true) {
            Ok(o) => o,
            Err(e) => {
                return RebaseResult {
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

/// Skip the commit the rebase is currently stopped on — DROPS it from the
/// resulting history entirely (distinct from Abort/Continue; this is the one
/// op where mid-sequence skip is meaningful). Runs `git rebase --skip` with
/// the same non-interactive editor guards.
///
/// Re-classifies the outcome exactly like `rebase_continue`: `clean` once the
/// sequence finishes, or `conflict` again if skipping landed on the next
/// conflicting commit (empirically verified, see tests/rebase.rs).
///
/// JS: `invoke("rebase_skip", { path })`.
///
/// Opens the repo and shells out `git rebase --skip`, which — like
/// `--continue` — can replay further commits before stopping again, a cost
/// that scales with the remaining sequence. Previously ran inline on Tauri's
/// main thread, freezing the whole window; `run_blocking` moves it off.
#[tauri::command]
#[specta::specta]
pub async fn rebase_skip(path: String) -> RebaseResult {
    crate::blocking::run_blocking(move || {
        let repo = match crate::trust::open_repo(&path) {
            Ok(r) => r,
            Err(e) => return RebaseResult::error(format!("Cannot open repository: {}", e.message())),
        };
        if !in_progress(&repo) {
            return RebaseResult::error("No rebase in progress to skip a commit from.");
        }

        let dropped = stopped_label(&repo, &path);
        let label = onto_label(&repo, &path);

        // Best-effort snapshot before dropping a commit's changes — mirrors
        // rebase_continue (never blocks Skip if it fails).
        let backup = crate::safety::snapshot(&repo).ok();

        let out = match git(&path, &["rebase", "--skip"], true) {
            Ok(o) => o,
            Err(e) => {
                return RebaseResult {
                    ok: false,
                    state: "error".into(),
                    conflicted_files: Vec::new(),
                    message: e,
                    backup_ref: backup,
                    blocked_by_local_changes: false,
                }
            }
        };

        let mut result = classify(&repo, &path, &out, backup, &label);
        if result.state == "clean" {
            result.message = format!("Skipped {dropped} — {}", result.message);
        }
        result
    })
    .await
}

/// Abort an in-progress rebase: `git rebase --abort` restores the pre-rebase
/// state. This is the escape hatch — it must ALWAYS be able to run, so it
/// deliberately does NOT take a snapshot (a snapshot failure must never block
/// the user's way out). Idempotent: "nothing in progress" is a benign success.
///
/// JS: `invoke("rebase_abort", { path })`.
///
/// Opens the repo with git2 and shells out `git rebase --abort`, which
/// restores the working tree/index to the pre-rebase snapshot — an operation
/// whose cost scales with how much of the rebase had progressed. As a plain
/// sync command this ran inline on Tauri's main thread, freezing the whole
/// app window; `run_blocking` moves it onto the blocking-task thread pool.
#[tauri::command]
#[specta::specta]
pub async fn rebase_abort(path: String) -> RebaseResult {
    crate::blocking::run_blocking(move || {
        let repo = match crate::trust::open_repo(&path) {
            Ok(r) => r,
            Err(e) => return RebaseResult::error(format!("Cannot open repository: {}", e.message())),
        };
        if !in_progress(&repo) {
            return RebaseResult {
                ok: true,
                state: "clean".into(),
                conflicted_files: Vec::new(),
                message: "No rebase in progress.".into(),
                backup_ref: None,
                blocked_by_local_changes: false,
            };
        }
        match git(&path, &["rebase", "--abort"], false) {
            Ok(o) if o.ok => RebaseResult {
                ok: true,
                state: "clean".into(),
                conflicted_files: Vec::new(),
                message: "Rebase aborted — back to the pre-rebase state.".into(),
                backup_ref: None,
                blocked_by_local_changes: false,
            },
            Ok(o) => RebaseResult::error(git_msg(&o)),
            Err(e) => RebaseResult::error(e),
        }
    })
    .await
}

/// List the commits an interactive-rebase planner can show/edit: every
/// non-merge commit reachable from HEAD but not from `onto`, oldest-first
/// (see [`commit_range`]'s doc for why merges are excluded). Pure READ — no
/// mutation, no snapshot, returns a plain `Result` like `git_read.rs`'s reads
/// rather than a `RebaseResult` (there is nothing to classify: this never
/// touches the sequencer).
///
/// JS: `invoke("rebase_interactive_plan", { path, onto })`.
///
/// Opens the repo and revwalks the full `onto..HEAD` range with git2, a cost
/// that grows with the branch's history — as a plain sync command that walk
/// ran inline on Tauri's main thread, freezing the whole app window while it
/// computed. `run_blocking` moves it onto Tauri's blocking-task thread pool.
#[tauri::command]
#[specta::specta]
pub async fn rebase_interactive_plan(path: String, onto: String) -> Result<Vec<PlanCommit>, String> {
    crate::blocking::run_blocking(move || {
        validate_rev(&onto)?;
        let repo = Repository::open(&path)
            .map_err(|e| format!("Cannot open repository: {}", e.message()))?;
        let onto_oid = resolve_oid(&repo, &onto)?;
        let oids = commit_range(&repo, onto_oid)?;
        plan_commits(&repo, &oids)
    })
    .await
}

/// Run a planned interactive rebase: reorder/pick/squash/fixup/drop/edit,
/// exactly as chosen in the planner (`todo`, oldest-first — this IS the
/// replay/todo order).
///
/// Re-derives the AUTHORITATIVE commit range itself (the exact same
/// [`commit_range`] walk [`rebase_interactive_plan`] used) and validates the
/// caller's `todo` against it BEFORE writing anything or snapshotting —
/// mirrors the Resolver's own "never trust in-memory state, re-derive from
/// the live backend" discipline, applied server-side: a stale frontend (one
/// that hasn't refreshed after an external change) is refused with
/// `state:"error"` and NO mutation, rather than silently rebasing the wrong
/// set of commits. Also refused before any mutation: an unknown/malformed
/// action, and a first row whose action is `squash`/`fixup` (nothing
/// precedes it to combine into — git would itself error with "cannot
/// 'squash' without a previous commit", but a clean pre-check gives a better
/// message, matching this app's "clean message before hitting git's own"
/// style used throughout).
///
/// Once validated: snapshots (Safety Manager, exactly like `rebase_start`),
/// builds the todo text (see [`build_todo_text`] — the trailing per-line
/// subject is ALWAYS re-read server-side from `commit.summary()`, never the
/// caller's copy), writes it to a sidecar file (see [`write_precomputed_todo`]
/// / [`todo_dir`]), points `GIT_SEQUENCE_EDITOR` at a `cp` of that file (see
/// [`shell_single_quote`] and this module's doc comment for the full
/// empirical trail on why this exact mechanism is safe), runs
/// `git rebase -i --end-of-options <onto>` with the same non-interactive
/// `GIT_EDITOR=true` convention as every other op, deletes the sidecar file
/// (best-effort, always), and classifies the result through the SAME
/// [`classify`] linear rebase uses (now including the "editing" branch).
///
/// JS: `invoke("rebase_interactive_start", { path, onto, todo })`.
///
/// Opens the repo, revwalks the commit range, and takes a safety snapshot
/// with git2, then shells out to the git CLI to replay the whole precomputed
/// todo — all three scale with history/working-tree size. As a plain sync
/// command this ran inline on Tauri's main thread, freezing the whole app
/// window for as long as the replay took; `run_blocking` moves it off.
#[tauri::command]
#[specta::specta]
pub async fn rebase_interactive_start(path: String, onto: String, todo: Vec<TodoItem>) -> RebaseResult {
    crate::blocking::run_blocking(move || {
        if let Err(e) = validate_rev(&onto) {
            return RebaseResult::error(e);
        }
        let repo = match Repository::open(&path) {
            Ok(r) => r,
            Err(e) => return RebaseResult::error(format!("Cannot open repository: {}", e.message())),
        };

        // Refuse to stack an interactive rebase on top of an unfinished op of any kind.
        if in_progress(&repo) {
            return RebaseResult::error("A rebase is already in progress — resolve or abort it first.");
        }

        let onto_oid = match resolve_oid(&repo, &onto) {
            Ok(oid) => oid,
            Err(e) => return RebaseResult::error(e),
        };

        // Re-derive the authoritative range — never trust the caller's todo shape.
        let fresh = match commit_range(&repo, onto_oid) {
            Ok(v) => v,
            Err(e) => return RebaseResult::error(e),
        };

        if todo.is_empty() {
            return RebaseResult::error("Nothing to rebase — no commits between HEAD and the target.");
        }
        for item in &todo {
            if let Err(e) = validate_rev(&item.sha) {
                return RebaseResult::error(e);
            }
            if !TODO_ACTIONS.contains(&item.action.as_str()) {
                return RebaseResult::error(format!("Unknown rebase action: {:?}", item.action));
            }
        }
        if matches!(todo[0].action.as_str(), "squash" | "fixup") {
            return RebaseResult::error(
                "The first commit in the plan can't be squash/fixup — nothing precedes it to combine into.",
            );
        }
        let fresh_shas: HashSet<String> = fresh.iter().map(Oid::to_string).collect();
        let todo_shas: HashSet<String> = todo.iter().map(|t| t.sha.clone()).collect();
        // Set-equality alone is NOT enough: a todo with a duplicate sha (one row
        // deduped away) can pass set-equality while still being a different shape
        // than the authoritative range — e.g. fresh=[A,B,C] but
        // todo=[(A,pick),(B,pick),(B,squash),(C,pick)] (4 rows) dedups to the same
        // {A,B,C} set. That would silently double-process B (once as "pick", once
        // as "squash" into itself) while A and B never each get their correct
        // distinct one-line treatment — a malformed todo git could turn into a
        // confusing sequencer stop `classify()` has no clean branch for. The
        // length check below catches exactly this: `todo` must have exactly one
        // row per fresh commit, no more, no fewer.
        if todo.len() != fresh.len() || todo_shas != fresh_shas {
            return RebaseResult::error(
                "This plan is out of date with the repository — refresh and try again.",
            );
        }

        // Snapshot FIRST — never mutate without a pre-op backup.
        let backup = match crate::safety::snapshot(&repo) {
            Ok(b) => b,
            Err(e) => return RebaseResult::error(format!("Safety snapshot failed, aborting: {e}")),
        };

        let todo_text = match build_todo_text(&repo, &todo) {
            Ok(t) => t,
            Err(e) => {
                return RebaseResult {
                    ok: false,
                    state: "error".into(),
                    conflicted_files: Vec::new(),
                    message: e,
                    backup_ref: Some(backup),
                    blocked_by_local_changes: false,
                }
            }
        };
        let todo_path = match write_precomputed_todo(&repo, &todo_text) {
            Ok(p) => p,
            Err(e) => {
                return RebaseResult {
                    ok: false,
                    state: "error".into(),
                    conflicted_files: Vec::new(),
                    message: e,
                    backup_ref: Some(backup),
                    blocked_by_local_changes: false,
                }
            }
        };

        // Pass the ALREADY-RESOLVED `onto_oid` here — never the raw `onto` string.
        // `onto` (e.g. a branch name like "main") would otherwise be re-resolved
        // by this freshly spawned `git` process at whatever moment IT starts up,
        // independently of the `onto_oid` the validation above already reasoned
        // about. If `onto` moved between the validation step above and this
        // invocation (a narrow but real TOCTOU window — another process/window
        // fast-forwarded or reset the branch), that re-resolution would rebase
        // onto a DIFFERENT target than the one the todo was just validated
        // against. Using the resolved oid's full hex string pins the actual
        // invocation to exactly the commit that was validated — EMPIRICALLY
        // VERIFIED (git 2.53.0) that `--end-of-options <full-oid>` behaves
        // identically to a branch name here (git accepts any revision in this
        // position; there is nothing branch-name-specific about how `-i` uses it).
        let onto_oid_str = onto_oid.to_string();
        let seq_editor = format!("cp {}", shell_single_quote(&todo_path.to_string_lossy()));
        let out = git_with_env(
            &path,
            &["rebase", "-i", "--end-of-options", &onto_oid_str],
            &[("GIT_SEQUENCE_EDITOR", seq_editor.as_str()), ("GIT_EDITOR", "true")],
        );
        // Best-effort cleanup, always — git has already copied the content into
        // .git/rebase-merge/git-rebase-todo by the time this invocation returns.
        let _ = fs::remove_file(&todo_path);

        let out = match out {
            Ok(o) => o,
            Err(e) => {
                return RebaseResult {
                    ok: false,
                    state: "error".into(),
                    conflicted_files: Vec::new(),
                    message: e,
                    backup_ref: Some(backup),
                    blocked_by_local_changes: false,
                }
            }
        };

        classify(&repo, &path, &out, Some(backup), &onto)
    })
    .await
}

/// A short, human label for the rebase target (read from
/// `rebase-merge/onto` while in progress; falls back to "the upstream").
/// Best-effort, never blocks.
fn onto_label(repo: &Repository, path: &str) -> String {
    let full = repo.path().join("rebase-merge").join("onto");
    let sha = std::fs::read_to_string(full).ok().map(|s| s.trim().to_string());
    match sha.filter(|s| !s.is_empty()) {
        Some(sha) => git(path, &["rev-parse", "--short", &sha], false)
            .ok()
            .filter(|o| o.ok)
            .map(|o| o.stdout)
            .filter(|s| !s.is_empty())
            .unwrap_or(sha),
        None => "the upstream".to_string(),
    }
}
