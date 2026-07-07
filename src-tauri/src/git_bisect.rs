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

use std::fs;
use std::process::Command;

use git2::Repository;
use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub sha: String,
    pub subject: String,
}

#[derive(Serialize)]
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
#[tauri::command]
pub fn bisect_start(path: String, bad: String, good: Vec<String>) -> BisectStatus {
    let repo = match Repository::open(&path) {
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
}

/// Mark the checked-out midpoint (HEAD) good/bad/skip. No snapshot.
/// JS: invoke("bisect_mark", { path, term }) where term ∈ {good,bad,skip}.
#[tauri::command]
pub fn bisect_mark(path: String, term: String) -> BisectStatus {
    let subcmd = match term.as_str() {
        "good" | "bad" | "skip" => term.as_str(),
        other => {
            return BisectStatus::refused(format!(
                "Unknown mark {other:?} (expected \"good\", \"bad\", or \"skip\")."
            ))
        }
    };
    let repo = match Repository::open(&path) {
        Ok(r) => r,
        Err(e) => return BisectStatus::refused(format!("Cannot open repository: {}", e.message())),
    };
    if !in_progress(&repo) {
        return BisectStatus::refused("No bisect in progress — start one first.");
    }

    match git(&path, &["bisect", subcmd]) {
        Ok(o) if o.ok => read_status(&repo, &path),
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
}

/// Read-only bisect status (also serves as `bisect log`). Never mutates.
/// JS: invoke("bisect_status", { path }).
#[tauri::command]
pub fn bisect_status(path: String) -> BisectStatus {
    match Repository::open(&path) {
        Ok(repo) => read_status(&repo, &path),
        Err(e) => BisectStatus::refused(format!("Cannot open repository: {}", e.message())),
    }
}

/// End the bisect and restore the original HEAD/branch. Escape hatch: NO
/// snapshot; idempotent. JS: invoke("bisect_reset", { path }).
#[tauri::command]
pub fn bisect_reset(path: String) -> BisectStatus {
    let repo = match Repository::open(&path) {
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
}
