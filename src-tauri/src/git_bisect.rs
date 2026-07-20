//! git bisect: mark a known-good and known-bad commit, let GitCat check out the
//! midpoint, and mark each good/bad/skip until it converges on the first bad
//! commit. HEAD detaches during a bisect; `bisect_reset` restores the original
//! HEAD/branch.
//!
//! Read/write split (see git_write.rs / git_pick.rs): every MUTATION shells out
//! to the git CLI — libgit2 has no bisect porcelain and the CLI owns the
//! sequencer state (BISECT_* files, refs/bisect/*). git2 is used ONLY to open
//! the repo, canonicalize user-supplied revs to full OIDs, and resolve commits
//! to sha+subject for the UI. Reads here are pure (`bisect_status` never
//! mutates).
//!
//! SAFETY / snapshot policy:
//!   * `bisect_start` SNAPSHOTS FIRST (mandatory; aborts if it fails). Starting a
//!     bisect detaches HEAD and checks out the midpoint, so this pins the exact
//!     pre-bisect HEAD under refs/gitgui/backup for the Undo ribbon.
//!   * `bisect_mark` does NOT snapshot: it only navigates a detached HEAD among
//!     commits that already exist; `bisect_reset` fully undoes the session.
//!   * `bisect_reset` does NOT snapshot: it is the escape hatch and must ALWAYS
//!     be able to run (mirrors `cherry_pick_abort`). Idempotent.
//!
//! SAFETY / user-supplied shas: `git bisect` does NOT accept `--end-of-options`
//! before a rev, so we canonicalize each user rev to a full 40-hex OID with git2
//! `revparse_single` BEFORE shelling out; a 40-hex string can never be read as a
//! flag or smuggle an argument, and an unresolvable rev is rejected cleanly.
//!
//! PARSING robustness: machine-readable signals over prose — counts from
//! `git rev-list --bisect-vars` (numeric); the checked-out commit under test from
//! .git/BISECT_EXPECTED_REV (NOT bisect_rev, which ignores skips); boundaries
//! from literal `git bisect good|bad <sha>` log lines; convergence + first bad
//! from the log's `# first bad commit: [<40hex>]` line; in-progress from
//! .git/BISECT_START. Every git call is forced to LC_ALL=C.
//!
//! AUTOMATED MODE (`bisect_run_start`): the equivalent of `git bisect run
//! <script>`, but driven from Rust so progress can be pushed to the frontend
//! as it happens instead of only seeing the final result. It does NOT
//! reimplement mark logic — every step funnels through the exact same
//! `apply_mark` that `bisect_mark` calls. `BisectRunState` (`app.manage()`d
//! in lib.rs) carries TWO independently-purposed `AtomicBool`s: a
//! cancellation flag (polled between every step) and a mutual-exclusion
//! "already running" guard, STRUCTURALLY enforced via `compare_exchange` —
//! mirrors `watch::WatchState`'s single-watcher invariant, which is likewise
//! enforced structurally (a `Mutex<Option<Debouncer>>`) rather than merely
//! documented/assumed. Without that guard, two concurrent `bisect_run_start`
//! calls (a double-click race, or a direct/raw IPC call bypassing the
//! frontend's own `autoRunning` guard) could each spin up a `run_bisect`
//! loop against the same repo at the same time, interleaving
//! `git bisect good/bad/skip` calls and checkouts against the same on-disk
//! sequencer state. The core loop (`run_bisect`) is split out from the
//! `#[tauri::command]` exactly like `watch::start_watching` is split from
//! `watch_repo`, so it's directly unit-testable without a real
//! AppHandle/State — as is the run/claim/release wrapper `try_run_bisect`
//! (see tests/bisect.rs).
//!
//! MAIN-THREAD BLOCKING (see blocking.rs): `bisect_start`, `bisect_mark`,
//! `bisect_status`, `bisect_reset`, and `bisect_run_start` all either open the
//! repo with git2 or shell out to `git`/an arbitrary test command, so every
//! one of them is now an `async fn` routed through `crate::blocking::run_blocking`
//! rather than a plain sync `fn` that would run inline on Tauri's main thread.
//! `bisect_run_cancel` is the one exception — it only flips an in-memory
//! `AtomicBool` on `BisectRunState`, no repo/subprocess access at all — so it
//! deliberately stays a plain sync `fn`.

use std::fs;
use std::process::{Command, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};

use git2::Repository;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, Wry};

#[derive(Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub sha: String,
    pub subject: String,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BisectStatus {
    pub ok: bool,
    pub in_progress: bool,
    pub current: Option<CommitInfo>,
    pub bad_ref: Option<String>,
    pub good_refs: Vec<String>,
    pub remaining_revs: usize,
    pub est_steps: usize,
    pub first_bad: Option<CommitInfo>,
    pub log: Vec<String>,
    pub message: String,
    pub backup_ref: Option<String>,
}

impl BisectStatus {
    fn refused(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            in_progress: false,
            current: None,
            bad_ref: None,
            good_refs: Vec::new(),
            remaining_revs: 0,
            est_steps: 0,
            first_bad: None,
            log: Vec::new(),
            message: message.into(),
            backup_ref: None,
        }
    }
    fn idle(message: impl Into<String>) -> Self {
        let mut s = Self::refused(message);
        s.ok = true;
        s
    }
}

struct Out {
    ok: bool,
    code: i32,
    stdout: String,
    stderr: String,
}

/// Run `git -C <path> <args…>` with LC_ALL=C (stable English prose/stderr) and
/// the pager disabled. Returns `Err` only when git can't be spawned.
fn git(path: &str, args: &[&str]) -> Result<Out, String> {
    let o = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("LC_ALL", "C")
        .env("LANGUAGE", "")
        .env("GIT_PAGER", "cat")
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    Ok(Out {
        ok: o.status.success(),
        code: o.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&o.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&o.stderr).trim().to_string(),
    })
}

fn git_msg(o: &Out) -> String {
    if !o.stderr.is_empty() {
        o.stderr.clone()
    } else if !o.stdout.is_empty() {
        o.stdout.clone()
    } else {
        format!("git exited with status {}", o.code)
    }
}

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

fn short_backup(r: &str) -> String {
    r.rsplit('/').next().unwrap_or(r).to_string()
}

/// A bisect is underway iff `<git-dir>/BISECT_START` exists.
fn in_progress(repo: &Repository) -> bool {
    repo.path().join("BISECT_START").exists()
}

fn validate_rev(rev: &str) -> Result<(), String> {
    if rev.is_empty() {
        return Err("No commit specified.".into());
    }
    if rev.starts_with('-') {
        return Err(format!("Refusing a revision that looks like a flag: {rev:?}"));
    }
    if rev.chars().any(|c| c.is_control()) {
        return Err("Revision has a control character.".into());
    }
    Ok(())
}

/// Resolve a user rev to a full 40-hex OID string with git2 (validates existence
/// AND makes it un-flaggable before it reaches the CLI).
fn canonical_oid(repo: &Repository, rev: &str) -> Result<String, String> {
    validate_rev(rev)?;
    repo.revparse_single(rev)
        .and_then(|o| o.peel_to_commit())
        .map(|c| c.id().to_string())
        .map_err(|_| format!("Not a commit this repository knows: {rev:?}"))
}

fn resolve_commit(repo: &Repository, rev: &str) -> Option<CommitInfo> {
    let commit = repo.revparse_single(rev).ok()?.peel_to_commit().ok()?;
    Some(CommitInfo {
        sha: short(&commit.id().to_string()),
        subject: commit.summary().unwrap_or("").to_string(),
    })
}

fn read_log(path: &str) -> Vec<String> {
    match git(path, &["bisect", "log"]) {
        Ok(o) if o.ok => o.stdout.lines().map(|l| l.to_string()).collect(),
        _ => Vec::new(),
    }
}

fn revs_in(tail: &str) -> Vec<String> {
    tail.split_whitespace()
        .filter(|t| !t.starts_with('-'))
        .map(|t| t.trim_matches('\'').to_string())
        .filter(|t| !t.is_empty())
        .collect()
}

/// From the log's `# first bad commit: [<sha>] <subject>` line, extract the sha.
fn parse_first_bad(log: &[String]) -> Option<String> {
    for line in log {
        let l = line.trim_start();
        if let Some(rest) = l.strip_prefix("# first bad commit:") {
            let start = rest.find('[')?;
            let end = rest[start..].find(']')? + start;
            let sha = rest[start + 1..end].trim();
            if !sha.is_empty() {
                return Some(sha.to_string());
            }
        }
    }
    None
}

/// badRef = FIRST recorded bad (original boundary); goodRefs = every good mark.
fn parse_marks(log: &[String]) -> (Option<String>, Vec<String>) {
    let mut bad: Option<String> = None;
    let mut goods: Vec<String> = Vec::new();
    for line in log {
        let l = line.trim();
        if l.starts_with('#') {
            continue;
        }
        if let Some(rest) = l.strip_prefix("git bisect bad") {
            if let Some(sha) = revs_in(rest).into_iter().next() {
                if bad.is_none() {
                    bad = Some(sha);
                }
            }
        } else if let Some(rest) = l.strip_prefix("git bisect good") {
            goods.extend(revs_in(rest));
        } else if let Some(rest) = l.strip_prefix("git bisect start") {
            let mut it = revs_in(rest).into_iter();
            if let Some(b) = it.next() {
                if bad.is_none() {
                    bad = Some(b);
                }
            }
            goods.extend(it);
        }
    }
    (bad.map(|s| short(&s)), goods.iter().map(|s| short(s)).collect())
}

/// Machine-readable counts (revs-left-after-this, est-steps) via
/// `git rev-list --bisect-vars refs/bisect/bad ^<good>…`. The third field
/// (bisect_rev) is intentionally DISCARDED — it ignores skips and must never
/// drive the current-commit decision. Returns (0,0) until both boundaries exist.
fn bisect_vars(path: &str) -> (usize, usize) {
    let goods: Vec<String> = match git(
        path,
        &["for-each-ref", "--format=%(objectname)", "refs/bisect/good-*"],
    ) {
        Ok(o) if o.ok => o
            .stdout
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| format!("^{l}"))
            .collect(),
        _ => Vec::new(),
    };
    if goods.is_empty() {
        return (0, 0);
    }
    let mut args: Vec<String> = vec![
        "rev-list".into(),
        "--bisect-vars".into(),
        "refs/bisect/bad".into(),
    ];
    args.extend(goods);
    let argrefs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = match git(path, &argrefs) {
        Ok(o) if o.ok => o,
        _ => return (0, 0),
    };
    let (mut nr, mut steps) = (0usize, 0usize);
    for line in out.stdout.lines() {
        if let Some(v) = line.strip_prefix("bisect_nr=") {
            nr = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("bisect_steps=") {
            steps = v.trim().parse().unwrap_or(0);
        }
    }
    (nr, steps)
}

/// Assemble a BisectStatus purely from repo state (no mutation). The single
/// reader every command funnels through; mutating commands overlay
/// ok/message/backup_ref afterward.
fn read_status(repo: &Repository, path: &str) -> BisectStatus {
    if !in_progress(repo) {
        return BisectStatus::idle("No bisect in progress.");
    }

    let log = read_log(path);
    let (bad_ref, good_refs) = parse_marks(&log);
    // COUNTS ONLY — bisect_vars' bisect_rev ignores skips, so it must NOT drive `current`.
    let (remaining_revs, est_steps) = bisect_vars(path);

    let first_bad = parse_first_bad(&log).and_then(|sha| resolve_commit(repo, &sha));

    // `current` = the commit to test = the detached HEAD, which git records in
    // .git/BISECT_EXPECTED_REV. This stays correct after a `skip` (bisect_rev
    // does not). None once converged.
    let current = if first_bad.is_some() {
        None
    } else {
        fs::read_to_string(repo.path().join("BISECT_EXPECTED_REV"))
            .ok()
            .and_then(|s| resolve_commit(repo, s.trim()))
            .or_else(|| resolve_commit(repo, "HEAD"))
    };

    let message = if let Some(fb) = &first_bad {
        format!("Found the first bad commit: {} — {}.", fb.sha, fb.subject)
    } else if let Some(c) = &current {
        format!(
            "Testing {} — {}. {} revision(s) left (~{} steps).",
            c.sha, c.subject, remaining_revs, est_steps
        )
    } else {
        "Bisect in progress — mark the current commit good, bad, or skip.".to_string()
    };

    BisectStatus {
        ok: true,
        in_progress: true,
        current,
        bad_ref,
        good_refs,
        remaining_revs,
        est_steps,
        first_bad,
        log,
        message,
        backup_ref: None,
    }
}

/// Start a bisect between a known-bad and one-or-more known-good commits.
/// Snapshots FIRST. JS: invoke("bisect_start", { path, bad, good: [sha,…] }).
///
/// Opens the repo with git2, takes a full safety snapshot, then shells out
/// several `git bisect start/bad/good` invocations in sequence — as a plain
/// sync command every one of those steps ran inline on Tauri's main thread,
/// freezing the whole app window (not just the bisect panel) until the last
/// one finished. `async fn` + `run_blocking` moves the whole sequence onto
/// Tauri's blocking-task thread pool instead.
#[tauri::command]
#[specta::specta]
pub async fn bisect_start(path: String, bad: String, good: Vec<String>) -> BisectStatus {
    crate::blocking::run_blocking(move || {
        let repo = match crate::trust::open_repo(&path) {
            Ok(r) => r,
            Err(e) => return BisectStatus::refused(format!("Cannot open repository: {}", e.message())),
        };

        if in_progress(&repo) {
            let mut s = read_status(&repo, &path);
            s.ok = false;
            s.message = "A bisect is already in progress — reset it before starting a new one.".into();
            return s;
        }
        if good.is_empty() {
            return BisectStatus::refused("Select at least one known-good commit to bisect between.");
        }

        match git(&path, &["status", "--porcelain"]) {
            Ok(o) if !o.ok => {
                return BisectStatus::refused(format!(
                    "Cannot verify the working tree is clean, refusing to bisect: {}",
                    o.stderr
                ))
            }
            Ok(o) if !o.stdout.is_empty() => {
                return BisectStatus::refused(
                    "Working tree has uncommitted changes — commit or stash before bisecting.",
                )
            }
            Ok(_) => {}
            Err(e) => return BisectStatus::refused(e),
        }

        let bad_oid = match canonical_oid(&repo, &bad) {
            Ok(o) => o,
            Err(e) => return BisectStatus::refused(e),
        };
        let mut good_oids: Vec<String> = Vec::with_capacity(good.len());
        for g in &good {
            match canonical_oid(&repo, g) {
                Ok(o) => good_oids.push(o),
                Err(e) => return BisectStatus::refused(e),
            }
        }

        // Snapshot FIRST — never mutate without a pre-op backup. Abort if it fails.
        let backup = match crate::safety::snapshot(&repo) {
            Ok(b) => b,
            Err(e) => return BisectStatus::refused(format!("Safety snapshot failed, aborting: {e}")),
        };

        match git(&path, &["bisect", "start"]) {
            Ok(o) if o.ok => {}
            Ok(o) => return BisectStatus::refused(git_msg(&o)),
            Err(e) => return BisectStatus::refused(e),
        }
        match git(&path, &["bisect", "bad", &bad_oid]) {
            Ok(o) if o.ok => {}
            Ok(o) => {
                let _ = git(&path, &["bisect", "reset"]);
                return BisectStatus::refused(git_msg(&o));
            }
            Err(e) => {
                let _ = git(&path, &["bisect", "reset"]);
                return BisectStatus::refused(e);
            }
        }
        for oid in &good_oids {
            match git(&path, &["bisect", "good", oid]) {
                Ok(o) if o.ok => {}
                Ok(o) => {
                    let _ = git(&path, &["bisect", "reset"]);
                    return BisectStatus::refused(git_msg(&o));
                }
                Err(e) => {
                    let _ = git(&path, &["bisect", "reset"]);
                    return BisectStatus::refused(e);
                }
            }
        }

        let mut status = read_status(&repo, &path);
        status.backup_ref = Some(backup.clone());
        status.message = format!(
            "{} · snapshot {}.",
            status.message.trim_end_matches('.'),
            short_backup(&backup)
        );
        status
    })
    .await
}

/// Apply one good/bad/skip determination to the currently checked-out
/// commit and return the resulting status. The SINGLE place either
/// `bisect_mark` or the automated `bisect_run_start` loop shells out
/// `git bisect good|bad|skip` — neither reimplements the other's logic.
/// Caller must have already verified `in_progress(repo)`.
fn apply_mark(repo: &Repository, path: &str, subcmd: &str) -> BisectStatus {
    match git(path, &["bisect", subcmd]) {
        Ok(o) if o.ok => read_status(repo, path),
        Ok(o) => {
            let mut s = read_status(repo, path);
            s.ok = false;
            s.message = git_msg(&o);
            s
        }
        Err(e) => {
            let mut s = read_status(repo, path);
            s.ok = false;
            s.message = e;
            s
        }
    }
}

/// Mark the checked-out midpoint (HEAD) good/bad/skip. No snapshot.
/// JS: invoke("bisect_mark", { path, term }) where term ∈ {good,bad,skip}.
///
/// Opens the repo with git2 and shells out `git bisect good|bad|skip`, which
/// also checks out the next midpoint — a real checkout, not just a ref
/// update. As a plain sync command that checkout ran on Tauri's main thread,
/// so every mark click froze the whole window for as long as it took.
/// `async fn` + `run_blocking` moves it onto Tauri's blocking-task pool.
#[tauri::command]
#[specta::specta]
pub async fn bisect_mark(path: String, term: String) -> BisectStatus {
    crate::blocking::run_blocking(move || {
        let subcmd = match term.as_str() {
            "good" | "bad" | "skip" => term.as_str(),
            other => {
                return BisectStatus::refused(format!(
                    "Unknown mark {other:?} (expected \"good\", \"bad\", or \"skip\")."
                ))
            }
        };
        let repo = match crate::trust::open_repo(&path) {
            Ok(r) => r,
            Err(e) => return BisectStatus::refused(format!("Cannot open repository: {}", e.message())),
        };
        if !in_progress(&repo) {
            return BisectStatus::refused("No bisect in progress — start one first.");
        }

        apply_mark(&repo, &path, subcmd)
    })
    .await
}

/// Read-only bisect status (also serves as `bisect log`). Never mutates.
/// JS: invoke("bisect_status", { path }).
///
/// `read_status` opens the repo with git2 and shells out several `git bisect
/// log`/`for-each-ref`/`rev-list` calls to assemble it. This command is
/// polled by the UI after every action, so as a plain sync fn each poll ran
/// inline on Tauri's main thread — `async fn` + `run_blocking` keeps those
/// repeated subprocess calls off it.
#[tauri::command]
#[specta::specta]
pub async fn bisect_status(path: String) -> BisectStatus {
    crate::blocking::run_blocking(move || match crate::trust::open_repo(&path) {
        Ok(repo) => read_status(&repo, &path),
        Err(e) => BisectStatus::refused(format!("Cannot open repository: {}", e.message())),
    })
    .await
}

/// End the bisect and restore the original HEAD/branch. Escape hatch: NO
/// snapshot; idempotent. JS: invoke("bisect_reset", { path }).
///
/// Shells out `git bisect reset`, which checks out the original HEAD/branch
/// again — a real checkout of potentially any size, run inline on Tauri's
/// main thread as a plain sync fn and freezing the whole window for its
/// duration. `async fn` + `run_blocking` moves it to Tauri's blocking pool.
#[tauri::command]
#[specta::specta]
pub async fn bisect_reset(path: String) -> BisectStatus {
    crate::blocking::run_blocking(move || {
        let repo = match crate::trust::open_repo(&path) {
            Ok(r) => r,
            Err(e) => return BisectStatus::refused(format!("Cannot open repository: {}", e.message())),
        };
        if !in_progress(&repo) {
            return BisectStatus::idle("No bisect in progress.");
        }

        let restored = fs::read_to_string(repo.path().join("BISECT_START"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(|s| {
                if s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit()) {
                    short(&s)
                } else {
                    s
                }
            });

        match git(&path, &["bisect", "reset"]) {
            Ok(o) if o.ok => {
                let message = match restored {
                    Some(r) => format!("Bisect ended — back on {r}."),
                    None => "Bisect ended.".to_string(),
                };
                BisectStatus::idle(message)
            }
            Ok(o) => {
                let mut s = read_status(&repo, &path);
                s.ok = false;
                s.message = git_msg(&o);
                s
            }
            Err(e) => {
                let mut s = read_status(&repo, &path);
                s.ok = false;
                s.message = e;
                s
            }
        }
    })
    .await
}

// ---------------------------------------------------------------------------
// Automated mode: `bisect_run_start` == `git bisect run <command>`, but driven
// step-by-step from Rust so each determination can be pushed to the frontend
// as "bisect-run-progress" while it runs.
// ---------------------------------------------------------------------------

/// State for an in-flight automated bisect run, `app.manage()`d in lib.rs —
/// ONE per app, mirroring `watch::WatchState`'s "one repo watched at a time"
/// scope (this app never runs two bisect-run loops at once either). Two
/// independently-purposed flags:
///
///   * `cancel` — `bisect_run_cancel` sets it; the `run_bisect` loop polls it
///     between every step and `try_run_bisect` always clears it back to
///     `false` when the loop exits — converged, aborted, cancelled, or hard
///     error — so a later run always starts from a clean flag regardless of
///     how the previous one ended.
///   * `running` — the mutual-exclusion guard. Unlike `cancel` (a signal),
///     this is a STRUCTURALLY-enforced lock: `try_start`'s
///     `compare_exchange` lets exactly one caller claim it, so a second
///     `bisect_run_start` while one is already in flight (a double-click
///     race, or a direct/raw IPC call bypassing the frontend's own
///     `autoRunning` guard) refuses cleanly via `try_run_bisect` returning
///     `None`, rather than two `run_bisect` loops interleaving
///     `git bisect good/bad/skip` calls and checkouts against the same
///     on-disk sequencer state. Mirrors `watch::WatchState`'s single-watcher
///     invariant, which is likewise structurally enforced (a
///     `Mutex<Option<Debouncer>>`), not just documented as an assumption.
#[derive(Default)]
pub struct BisectRunState {
    cancel: AtomicBool,
    running: AtomicBool,
}

impl BisectRunState {
    fn request_cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }
    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
    fn clear_cancel(&self) {
        self.cancel.store(false, Ordering::SeqCst);
    }
    /// Atomically claim the "a run is in flight" guard. Returns `true` only
    /// for the one caller that successfully transitions `running` from
    /// `false` to `true` — if two threads race here at once, `compare_exchange`
    /// guarantees exactly one of them observes `Ok` (this is what makes the
    /// guard a REAL lock rather than a check-then-act race).
    fn try_start(&self) -> bool {
        self.running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
    /// Release the claim. Must run on every exit path out of a run that
    /// successfully claimed it — mirrors the existing discipline of always
    /// clearing `cancel` on every exit path, below.
    fn finish(&self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

/// One step's verdict, per `git bisect run`'s documented exit-code contract:
/// 0 = good; 125 = skip; any other code in 1..=127 (except 125) = bad; 126 or
/// 127 (the shell's own "found but not executable" / "command not found"
/// conventions) or anything outside 0..=127 means the command itself could
/// not be meaningfully run — abort rather than misread it as "bad".
///
/// KNOWN LIMITATION (Windows): 126/127 are a Unix `sh -c` convention. On
/// Windows, `run_test_command` shells out via `cmd.exe /C <command>`
/// instead, which has its own, DIFFERENT exit-code conventions for
/// "couldn't run the command at all" — e.g. ERRORLEVEL 9009 for "command not
/// found", which happens to still fall into the generic
/// out-of-range-abort case below since it's >127, but other Windows
/// failure modes that return a code in 1..=127 are NOT distinguished from a
/// genuine "bad" result here and will be misclassified as "bad" rather than
/// "abort". This is a documented, unaddressed gap (mirrors filter_repo.rs's
/// restore-scope caveat in spirit) rather than a silent one — fixing it
/// properly would need a way to verify actual `cmd.exe` behavior across
/// Windows versions, which this change does not attempt speculatively.
enum Step {
    Good,
    Bad,
    Skip,
    Abort(String),
}

fn classify_exit(status: &ExitStatus) -> Step {
    match status.code() {
        None => Step::Abort("the test command was killed by a signal".to_string()),
        Some(0) => Step::Good,
        Some(125) => Step::Skip,
        Some(126) => Step::Abort(
            "the test command exited 126 (found but not executable) — the command itself could not run".to_string(),
        ),
        Some(127) => Step::Abort(
            "the test command exited 127 (command not found) — the command itself could not run".to_string(),
        ),
        Some(c) if (1..=127).contains(&c) => Step::Bad,
        Some(c) => Step::Abort(format!("the test command exited with out-of-range status {c}")),
    }
}

/// Run `command` through a shell (`sh -c` on Unix, `cmd /C` on Windows — this
/// codebase has no existing shell-invocation helper to reuse, and the release
/// workflow ships Windows builds, so both are handled explicitly) with its
/// current working directory set to the repo's working tree, i.e. against
/// whatever commit is currently checked out. Returns `Err` only when the
/// shell itself could not be spawned (e.g. missing on the host) — NOT for a
/// nonzero exit, which is the normal, expected way a test command reports
/// good/bad/skip. See `classify_exit`'s doc comment for the Unix-derived
/// exit-code convention this result is fed into, and its documented gap on
/// Windows.
fn run_test_command(path: &str, command: &str) -> Result<ExitStatus, String> {
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(command);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(command);
        c
    };
    cmd.current_dir(path);
    cmd.status().map_err(|e| format!("Could not run the test command: {e}"))
}

/// The automated step loop itself, independent of any running Tauri app —
/// `should_cancel` is polled between every step, `on_progress` is called with
/// the resulting status after every step actually applied. Split out from the
/// `bisect_run_start` command so it's directly unit-testable (a
/// `#[tauri::command]` needing a real `AppHandle`/`State` isn't callable from
/// a plain integration test the way this codebase's other command functions
/// are — see watch.rs's `start_watching`/`watch_repo` split, and
/// tests/bisect.rs).
///
/// Preconditions/stop conditions mirror `bisect_mark`/its caller exactly:
/// refuses (does not loop at all) if no bisect is in progress; stops and
/// returns once `first_bad.is_some()` (the same convergence signal
/// `bisect_mark`'s caller already relies on), once the test command's exit
/// code signals an abort condition, or once `should_cancel()` returns true —
/// every stop path leaves an honest, distinguishable `message` behind.
pub fn run_bisect(
    path: &str,
    command: &str,
    should_cancel: impl Fn() -> bool,
    mut on_progress: impl FnMut(&BisectStatus),
) -> BisectStatus {
    let repo = match Repository::open(path) {
        Ok(r) => r,
        Err(e) => return BisectStatus::refused(format!("Cannot open repository: {}", e.message())),
    };
    if !in_progress(&repo) {
        return BisectStatus::refused("No bisect in progress — start one first.");
    }

    loop {
        if should_cancel() {
            let mut s = read_status(&repo, path);
            s.message = format!("Automated bisect run cancelled. {}", s.message);
            return s;
        }

        let exit = match run_test_command(path, command) {
            Ok(e) => e,
            Err(e) => {
                let mut s = read_status(&repo, path);
                s.ok = false;
                s.message = format!("Automated bisect run aborted — {e}.");
                return s;
            }
        };

        let subcmd = match classify_exit(&exit) {
            Step::Good => "good",
            Step::Bad => "bad",
            Step::Skip => "skip",
            Step::Abort(reason) => {
                let mut s = read_status(&repo, path);
                s.ok = false;
                s.message = format!("Automated bisect run aborted — {reason}.");
                return s;
            }
        };

        let mut s = apply_mark(&repo, path, subcmd);
        on_progress(&s);

        if s.first_bad.is_some() {
            s.message = format!("Automated bisect run converged. {}", s.message);
            return s;
        }
        if !s.ok {
            // `git bisect <mark>` itself failed (not a test-command problem) —
            // stop rather than loop forever; s.message already carries why.
            return s;
        }
    }
}

/// Claim `state`'s "already running" guard (see `BisectRunState::try_start`)
/// and, ONLY if the claim succeeds, run `run_bisect` to completion, always
/// releasing the guard afterward. Returns `None` — and does not call
/// `run_bisect` AT ALL — when another run is already in flight: this is
/// Bug 1's actual fix, a second concurrent `bisect_run_start` must refuse
/// cleanly rather than spinning up a second loop against the same on-disk
/// sequencer state. Split out from the `#[tauri::command]` so it's directly
/// unit-testable without a real AppHandle/State (mirrors `run_bisect`'s own
/// split from `bisect_run_start`; see tests/bisect.rs).
pub fn try_run_bisect(
    state: &BisectRunState,
    path: &str,
    command: &str,
    should_cancel: impl Fn() -> bool,
    on_progress: impl FnMut(&BisectStatus),
) -> Option<BisectStatus> {
    if !state.try_start() {
        return None;
    }
    state.clear_cancel(); // a stale cancel from a previous run must never leak into this one
    let result = run_bisect(path, command, should_cancel, on_progress);
    state.clear_cancel(); // always leave the flag clear on the way out, whatever the reason
    state.finish(); // release the run-in-progress claim on every exit path, mirroring the above
    Some(result)
}

/// Automate an already-started bisect: repeatedly run `command` against the
/// current checkout, mark good/bad/skip per its exit code, and keep going
/// until convergence, an abort condition, or cancellation. Does NOT call
/// `bisect_start` itself — matches the existing UI flow where the user has
/// already picked bad+good and clicked Start. Refuses cleanly (no run
/// attempted) if another automated run is already in flight for this app —
/// see `try_run_bisect`.
///
/// This is the worst offender of the plain-`fn`-blocks-the-main-thread bug in
/// this file: `run_bisect` loops running an arbitrary caller-supplied test
/// command and shelling out `git bisect good/bad/skip` after every run, for
/// as long as it takes to converge — real test suites can take minutes. As a
/// plain sync command, that whole loop ran inline on Tauri's main thread, so
/// the entire app window sat frozen for the full duration of an automated
/// run. `async fn` + `run_blocking` moves the loop onto Tauri's blocking-task
/// thread pool; `BisectRunState` is now looked up via `app.state()` from
/// inside that pool (mirrors `commands.rs`'s `stream_graph` doing the same
/// for `GraphLoadState`) rather than taken as a `State` parameter, since a
/// borrowed `State<'_, T>` can't be moved into the `'static` closure
/// `run_blocking` requires.
/// JS: invoke("bisect_run_start", { path, command }).
#[tauri::command]
#[specta::specta]
pub async fn bisect_run_start(app: AppHandle<Wry>, path: String, command: String) -> BisectStatus {
    crate::blocking::run_blocking(move || {
        let state = app.state::<BisectRunState>();
        let outcome = try_run_bisect(
            &state,
            &path,
            &command,
            || state.is_cancelled(),
            |status| {
                let _ = app.emit("bisect-run-progress", status);
            },
        );
        match outcome {
            Some(result) => result,
            None => match Repository::open(&path) {
                // Report the ACTUAL current status (mirrors bisect_start's own
                // already-in-progress handling) rather than a blank refusal, so
                // the frontend's canvas cues stay accurate even though this
                // particular call was refused.
                Ok(repo) => {
                    let mut s = read_status(&repo, &path);
                    s.ok = false;
                    s.message =
                        "An automated bisect run is already in progress — cancel it before starting another.".into();
                    s
                }
                Err(e) => BisectStatus::refused(format!("Cannot open repository: {}", e.message())),
            },
        }
    })
    .await
}

/// Request that an in-flight `bisect_run_start` loop stop before its next
/// step. Always callable (mirrors `bisect_reset`'s "must always be able to
/// run" escape-hatch spirit), though this only sets a flag rather than
/// mutating repo state. JS: invoke("bisect_run_cancel").
///
/// Deliberately left as a plain sync `fn`: it touches only an in-memory
/// `AtomicBool` on `BisectRunState`, with no git2/subprocess/filesystem
/// access, so there is nothing here that could block the main thread.
#[tauri::command]
#[specta::specta]
pub fn bisect_run_cancel(state: State<BisectRunState>) -> Result<(), String> {
    state.request_cancel();
    Ok(())
}
