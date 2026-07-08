//! Safety Manager — the product differentiator.
//!
//! Before ANY mutation, [`snapshot`] pins the current HEAD commit under a backup
//! ref `refs/gitgui/backup/<secs>-<nanos>-<seq>` and appends a JSON line to
//! `<git-dir>/gitgui/oplog.jsonl`. Backup refs are NEVER auto-deleted in M2a.
//!
//! Read/write split: pinning a backup ref is metadata and uses git2 (explicitly
//! allowed by the design: "git update-ref, or git2 reference creation"). But the
//! actual HISTORY/WORKTREE mutation performed by [`undo`] (moving HEAD + the
//! current branch and updating the tree) shells out to the git CLI via
//! [`run_git`] — libgit2 and the CLI can diverge, and the CLI is the source of
//! truth for mutations.
//!
//! Global [`undo`] rewinds HEAD/the current branch to the newest snapshot — and
//! undo is itself undoable: it snapshots the CURRENT state BEFORE rewinding, so
//! it can never strand the user. Scope (M2a): HEAD / current-branch ref moves
//! (branch checkout, or a branch-position move). Full-repo ref restore is later.

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use git2::Repository;
use serde::Serialize;

const BACKUP_GLOB: &str = "refs/gitgui/backup/*";
const BACKUP_PREFIX: &str = "refs/gitgui/backup/";

/// Process-wide monotonic tie-breaker: two snapshots taken in the same
/// nanosecond still get distinct ref names.
static SNAP_SEQ: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// git CLI runner — the single choke point for MUTATIONS (undo's reset/set-head)
// ---------------------------------------------------------------------------

/// Raw result of one git CLI invocation.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitOut {
    pub ok: bool,       // process exited 0
    pub stdout: String, // captured stdout, trailing whitespace trimmed
    pub stderr: String, // captured stderr, trailing whitespace trimmed
    pub code: i32,      // exit code, or -1 if killed by a signal
}

/// Run `git -C <repo> <args…>` in the repo's workdir.
///
/// Returns `Err(String)` ONLY when git can't be spawned (not installed / not on
/// PATH); a non-zero git exit is a successful call yielding `Ok(GitOut{ok:false})`
/// so callers can surface git's own stderr instead of turning it into a panic.
pub fn run_git(repo: &str, args: &[&str]) -> Result<GitOut, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    Ok(GitOut {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).trim_end().to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).trim_end().to_string(),
        code: out.status.code().unwrap_or(-1),
    })
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// One backup snapshot, as shown in the ribbon / Snapshots group. `reference`
/// serializes as `"ref"` for the frontend.
#[derive(Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(rename = "ref")]
    pub reference: String, // full backup ref name
    pub ts: i64,           // unix seconds (parsed back from the ref name)
    pub sha: String,       // short sha of the pinned HEAD commit
    pub subject: String,   // that commit's subject line
}

/// Result of a global undo.
#[derive(Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    pub ok: bool,
    pub message: String,
    pub restored_to: Option<String>, // short sha HEAD was moved to
    pub sealed: Option<String>,      // backup ref of the pre-undo state
}

/// One op-log entry (JSON line). camelCase keys: `backupRef`, `headBefore`,
/// `headAfter`, `headRef`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpLog {
    ts: i64,
    op: String,          // "snapshot" | "undo" | (later: the write op name)
    backup_ref: String,  // the ref pinned by this op
    head_before: String, // HEAD sha before
    head_after: String,  // HEAD sha after
    head_ref: String,    // symbolic HEAD at op time ("refs/heads/…" or "" if detached)
    /// Full-repo snapshot of `refs/heads/<name>` -> tip sha, so undo can restore
    /// deleted/renamed/moved branches (not just HEAD). Empty for non-snapshot ops
    /// and pre-M2c op-log lines (undo then falls back to HEAD-only).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    refs: BTreeMap<String, String>,
    detail: String,
}

// ---------------------------------------------------------------------------
// core — snapshot / snapshots / undo (take a &Repository so git_write.rs can
// call `crate::safety::snapshot(&repo)` right before it mutates)
// ---------------------------------------------------------------------------

/// Pin the current HEAD commit under a fresh unique backup ref, append an
/// op-log line, and return the ref name. `Err` if there is no HEAD to pin
/// (unborn branch / empty repo).
pub fn snapshot(repo: &Repository) -> Result<String, String> {
    let head_commit = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| format!("no commit to snapshot: {}", e.message()))?;
    let oid = head_commit.id();
    let sha = oid.to_string();

    let (ref_name, ts) = new_backup_ref();
    // force=false => git2 errors if the ref already exists, so a unique name can
    // never clobber a prior snapshot.
    repo.reference(&ref_name, oid, false, "gitcat safety snapshot")
        .map_err(|e| format!("could not create backup ref: {}", e.message()))?;

    // Which branch (if any) is HEAD on? Recorded so undo can restore identity.
    let head_ref = current_symref(repo);
    // Whole-branch topology at snapshot time, so undo can restore branches that
    // are later deleted, renamed, or moved — not just HEAD.
    let refs = head_refs_map(repo);

    append_oplog(
        repo,
        &OpLog {
            ts,
            op: "snapshot".to_string(),
            backup_ref: ref_name.clone(),
            head_before: sha.clone(),
            head_after: sha,
            head_ref,
            refs,
            detail: String::new(),
        },
    );

    Ok(ref_name)
}

/// All backup snapshots, newest first (by ts, then the monotonic seq suffix).
/// Pin a deleted branch's tip under a SEPARATE namespace so its commits stay
/// reachable (recoverable by sha) but it is never a snapshots()/undo() target.
pub fn pin_deleted_tip(repo: &Repository, oid: git2::Oid, branch: &str) -> Result<String, String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let seq = SNAP_SEQ.fetch_add(1, Ordering::SeqCst);
    let ref_name = format!("refs/gitgui/deleted/{}-{}-{}", now.as_secs(), now.subsec_nanos(), seq);
    repo.reference(&ref_name, oid, false, &format!("gitcat pin deleted {branch}"))
        .map_err(|e| format!("could not pin deleted tip: {}", e.message()))?;
    append_oplog(repo, &OpLog {
        ts: now.as_secs() as i64,
        op: "pin-deleted".to_string(),
        backup_ref: ref_name.clone(),
        head_before: oid.to_string(),
        head_after: oid.to_string(),
        head_ref: current_symref(repo),
        refs: BTreeMap::new(),
        detail: format!("branch {branch}"),
    });
    Ok(ref_name)
}

/// Numeric sort key from a `refs/gitgui/backup/<secs>-<nanos>-<seq>` name.
/// (Lexical compare on the un-padded suffix mis-orders within one second.)
fn sort_key(refname: &str) -> (i64, u64, u64) {
    let tail = refname.rsplit('/').next().unwrap_or("");
    let mut it = tail.split('-');
    let secs = it.next().unwrap_or("").parse().unwrap_or(0i64);
    let nanos = it.next().unwrap_or("").parse().unwrap_or(0u64);
    let seq = it.next().unwrap_or("").parse().unwrap_or(0u64);
    (secs, nanos, seq)
}

pub fn snapshots(repo: &Repository) -> Result<Vec<Snapshot>, String> {
    let globs = repo
        .references_glob(BACKUP_GLOB)
        .map_err(|e| e.message().to_string())?;
    let mut snaps: Vec<Snapshot> = Vec::new();
    for r in globs.flatten() {
        let name = match r.name() {
            Some(n) => n.to_string(),
            None => continue,
        };
        let commit = match r.peel_to_commit() {
            Ok(c) => c,
            Err(_) => continue,
        };
        let sha = commit.id().to_string();
        snaps.push(Snapshot {
            ts: parse_ts(&name),
            reference: name,
            sha: short(&sha),
            subject: commit.summary().unwrap_or("").to_string(),
        });
    }
    // newest first, by the parsed numeric (secs, nanos, seq) tuple.
    snaps.sort_by(|a, b| sort_key(&b.reference).cmp(&sort_key(&a.reference)));
    Ok(snaps)
}

/// Rewind HEAD/current branch to the newest snapshot, after snapshotting the
/// current state (undo-is-undoable). Refuses on a dirty tree (never force).
pub fn undo(repo: &Repository) -> Result<UndoResult, String> {
    // Capture the newest EXISTING snapshot before we add the undo-seal.
    let target = match snapshots(repo)?.into_iter().next() {
        Some(s) => s,
        None => {
            return Ok(UndoResult {
                ok: false,
                message: "Nothing to undo — no snapshots yet.".to_string(),
                restored_to: None,
                sealed: None,
            })
        }
    };

    let workdir = repo
        .workdir()
        .and_then(|p| p.to_str())
        .ok_or_else(|| "undo needs a working tree (bare repo not supported)".to_string())?;

    // A dirty tree would be silently discarded by `reset --hard`, and the backup
    // only preserves committed history — so refuse and surface it, don't force.
    let dirty = run_git(workdir, &["status", "--porcelain"])?;
    if !dirty.ok {
        return Ok(UndoResult {
            ok: false,
            message: format!("Cannot verify the working tree is clean, refusing undo: {}", dirty.stderr),
            restored_to: None,
            sealed: None,
        });
    }
    if !dirty.stdout.is_empty() {
        return Ok(UndoResult {
            ok: false,
            message: "Working tree has uncommitted changes — commit or stash before undo.".to_string(),
            restored_to: None,
            sealed: None,
        });
    }

    // Undo-is-undoable: pin the CURRENT state before moving anything. If that
    // fails, abort — never reset --hard with no backup of the current state.
    let sealed = match snapshot(repo) {
        Ok(r) => Some(r),
        Err(e) => {
            return Ok(UndoResult {
                ok: false,
                message: format!("Undo aborted — could not snapshot current state first: {e}"),
                restored_to: None,
                sealed: None,
            })
        }
    };

    // Recover the branch identity that was current when `target` was pinned, and
    // resolve the target ref to a full sha.
    let head_ref = oplog_head_ref(repo, &target.reference);
    let target_sha = repo
        .revparse_single(&target.reference)
        .and_then(|o| o.peel_to_commit())
        .map(|c| c.id().to_string())
        .map_err(|e| e.message().to_string())?;

    // ---- Full-repo ref restore (M2c) --------------------------------------
    // The snapshot recorded every local branch tip; restore the WHOLE set, not
    // just HEAD. A pre-M2c snapshot has no `refs` map, so `target_refs` is empty
    // and we fall back to the HEAD-only path — an empty map must NEVER be read as
    // "delete every branch".
    let target_refs = oplog_refs(repo, &target.reference);
    let sym = head_ref.as_deref().unwrap_or("");
    let mut branch_note = String::new();

    if !target_refs.is_empty() {
        let current_refs = head_refs_map(repo);

        // Data-safety FIRST: pin every current tip undo is about to MOVE or
        // DELETE, so no commit can be orphaned. The sealed snapshot only pinned
        // HEAD; this covers the rest before any ref is rewritten.
        for (name, cur_sha) in &current_refs {
            let will_change = target_refs.get(name).map(|t| t != cur_sha).unwrap_or(true);
            if will_change {
                if let Ok(oid) = git2::Oid::from_str(cur_sha) {
                    let _ = pin_deleted_tip(repo, oid, name);
                }
            }
        }

        // (1) Restore/move every snapshot branch (incl. the current one; the
        // reset below re-syncs its worktree). `update-ref` may write the
        // checked-out branch, which `branch -f` refuses. Best-effort: a single
        // stubborn ref must not abort the whole undo.
        let mut restored = 0usize;
        for (name, sha) in &target_refs {
            if current_refs.get(name).map(|c| c == sha).unwrap_or(false) {
                continue; // already correct
            }
            if run_git(workdir, &["update-ref", name, sha])?.ok {
                restored += 1;
            }
        }

        // (2) Point HEAD at the snapshot's branch (or detach) and sync the tree.
        // This is the critical step — hard-fail if it can't complete.
        if !sym.is_empty() {
            let sr = run_git(workdir, &["symbolic-ref", "HEAD", sym])?;
            if !sr.ok {
                return Ok(UndoResult { ok: false,
                    message: format!("Undo failed restoring HEAD: {}", sr.stderr),
                    restored_to: None, sealed });
            }
            let reset = run_git(workdir, &["reset", "--hard", target_sha.as_str()])?;
            if !reset.ok {
                return Ok(UndoResult { ok: false,
                    message: format!("Undo failed: {}", reset.stderr),
                    restored_to: None, sealed });
            }
        } else {
            let co = run_git(workdir, &["checkout", "-q", "--detach", target_sha.as_str()])?;
            if !co.ok {
                return Ok(UndoResult { ok: false,
                    message: format!("Undo failed detaching HEAD: {}", co.stderr),
                    restored_to: None, sealed });
            }
        }

        // (3) Delete branches created AFTER the snapshot (not in the map). Safe
        // now: HEAD was moved off any of them in (2), and their tips are pinned.
        // Pass the old sha so a racing change can't be silently clobbered.
        let mut removed = 0usize;
        for (name, cur_sha) in &current_refs {
            if target_refs.contains_key(name) || name == sym {
                continue;
            }
            if run_git(workdir, &["update-ref", "-d", name, cur_sha])?.ok {
                removed += 1;
            }
        }
        if restored > 0 || removed > 0 {
            branch_note = format!(" · {restored} branch(es) restored, {removed} removed");
        }
    } else {
        // Legacy HEAD-only path (pre-M2c snapshot with no recorded ref map).
        if !sym.is_empty() {
            let sr = run_git(workdir, &["symbolic-ref", "HEAD", sym])?;
            if !sr.ok {
                return Ok(UndoResult { ok: false,
                    message: format!("Undo failed restoring HEAD: {}", sr.stderr),
                    restored_to: None, sealed });
            }
        }
        let reset = run_git(workdir, &["reset", "--hard", target_sha.as_str()])?;
        if !reset.ok {
            return Ok(UndoResult { ok: false,
                message: format!("Undo failed: {}", reset.stderr),
                restored_to: None, sealed });
        }
    }

    append_oplog(
        repo,
        &OpLog {
            ts: now_secs(),
            op: "undo".to_string(),
            backup_ref: sealed.clone().unwrap_or_default(),
            head_before: sealed.clone().unwrap_or_default(),
            head_after: target_sha.clone(),
            head_ref: head_ref.unwrap_or_default(),
            refs: BTreeMap::new(),
            detail: format!("restore {}", target.reference),
        },
    );

    Ok(UndoResult {
        ok: true,
        message: format!("Rewound to {}{}.", short(&target_sha), branch_note),
        restored_to: Some(short(&target_sha)),
        sealed,
    })
}

// ---------------------------------------------------------------------------
// Tauri commands (registered in lib.rs). Distinct names avoid colliding with
// the core fns above; each opens the repo from a path.
// ---------------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub fn create_snapshot(path: String) -> Result<Snapshot, String> {
    let repo = open(&path)?;
    let ref_name = snapshot(&repo)?;
    // Re-read so the UI gets ts/sha/subject for the ribbon in one round-trip.
    snapshots(&repo)?
        .into_iter()
        .find(|s| s.reference == ref_name)
        .ok_or_else(|| "snapshot created but not found".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn list_snapshots(path: String) -> Result<Vec<Snapshot>, String> {
    snapshots(&open(&path)?)
}

#[tauri::command]
#[specta::specta]
pub fn undo_last(path: String) -> Result<UndoResult, String> {
    undo(&open(&path)?)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn open(path: &str) -> Result<Repository, String> {
    crate::trust::open_repo(path).map_err(|e| format!("cannot open repository: {}", e.message()))
}

/// Unique backup ref: `refs/gitgui/backup/<secs>-<nanos>-<seq>`. `secs` is the
/// human-meaningful `ts`; `nanos` + the process-monotonic `seq` guarantee
/// uniqueness even under rapid-fire snapshots within the same second.
fn new_backup_ref() -> (String, i64) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs();
    let nanos = now.subsec_nanos();
    let seq = SNAP_SEQ.fetch_add(1, Ordering::SeqCst);
    (format!("{BACKUP_PREFIX}{secs}-{nanos}-{seq}"), secs as i64)
}

/// The full symbolic HEAD ("refs/heads/…") when on a branch, else "" (detached).
fn current_symref(repo: &Repository) -> String {
    match repo.head() {
        Ok(h) if h.is_branch() => h.name().unwrap_or("").to_string(),
        _ => String::new(),
    }
}

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// Leading integer of the ref's last path segment, e.g. `…/1720000000-42-3` -> 1720000000.
fn parse_ts(refname: &str) -> i64 {
    refname
        .rsplit('/')
        .next()
        .unwrap_or("")
        .split('-')
        .next()
        .unwrap_or("")
        .parse()
        .unwrap_or(0)
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `<git-dir>/gitgui/oplog.jsonl`. `repo.path()` is the git dir (handles
/// worktrees / non-standard layouts).
fn oplog_path(repo: &Repository) -> std::path::PathBuf {
    repo.path().join("gitgui").join("oplog.jsonl")
}

/// Append one op-log line. Best-effort: logging must never fail a mutation.
fn append_oplog(repo: &Repository, entry: &OpLog) {
    let p = oplog_path(repo);
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(line) = serde_json::to_string(entry) {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&p) {
            let _ = writeln!(f, "{line}");
        }
    }
}

/// Recover the `headRef` recorded when `backup_ref` was pinned (last match wins).
fn oplog_head_ref(repo: &Repository, backup_ref: &str) -> Option<String> {
    let data = fs::read_to_string(oplog_path(repo)).ok()?;
    let mut found = None;
    for line in data.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("backupRef").and_then(|x| x.as_str()) == Some(backup_ref) {
            if let Some(hr) = v.get("headRef").and_then(|x| x.as_str()) {
                found = Some(hr.to_string());
            }
        }
    }
    found
}

/// Every local branch (`refs/heads/<name>` full refname) -> its tip's full sha.
/// The whole-branch topology snapshot() records so undo() can restore branches
/// that are later deleted, renamed, or moved — not just HEAD.
fn head_refs_map(repo: &Repository) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    if let Ok(globs) = repo.references_glob("refs/heads/*") {
        for r in globs.flatten() {
            if let (Some(name), Ok(commit)) = (r.name().map(str::to_string), r.peel_to_commit()) {
                m.insert(name, commit.id().to_string());
            }
        }
    }
    m
}

/// The `refs` map recorded when `backup_ref` was pinned (last match wins).
/// Empty for pre-M2c snapshots (no `refs` key) — undo then restores HEAD only.
fn oplog_refs(repo: &Repository, backup_ref: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Ok(data) = fs::read_to_string(oplog_path(repo)) else {
        return out;
    };
    for line in data.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("backupRef").and_then(|x| x.as_str()) != Some(backup_ref) {
            continue;
        }
        if let Some(obj) = v.get("refs").and_then(|x| x.as_object()) {
            out = obj
                .iter()
                .filter_map(|(k, val)| val.as_str().map(|s| (k.clone(), s.to_string())))
                .collect();
        }
    }
    out
}
