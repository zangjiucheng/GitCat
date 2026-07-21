//! Filter-repo wizard (M5c) — the ONE remaining destructive/irreversible-by-
//! normal-Undo operation in GitCat. `git filter-repo` rewrites EVERY commit
//! hash in the selected history, and by its own design aggressively expires
//! the reflog and prunes unreachable objects — so the ordinary Safety Manager
//! model (`safety.rs`: pin a ref, `git reset --hard` back to it) does NOT
//! protect against it. A rewrite creates entirely new commit objects; the OLD
//! objects can become genuinely unreachable and gc'able.
//!
//! Because of that, this module keeps its OWN dedicated safety net, separate
//! from `safety.rs`'s oplog:
//!
//!   1. BACKUP (mandatory, before ever invoking filter-repo): a full
//!      `git bundle create --all`, immediately verified with
//!      `git bundle verify`. If EITHER step fails, we abort before running
//!      filter-repo at all — never rewrite history without a verified,
//!      independent copy of every reachable object already safely on disk.
//!   2. MANIFEST: a JSON line in `<git-dir>/gitgui/filter-repo-log.jsonl`
//!      recording not just HEAD but the FULL list of refs the bundle actually
//!      captured (`git bundle list-heads <bundle>` — exactly `<sha> <ref>` per
//!      line for every ref namespace the repo had: heads, tags, remotes,
//!      notes, whatever). This is what lets `filter_repo_restore` reconstruct
//!      every ref namespace, not just `refs/heads` + `refs/tags`.
//!   3. RESTORE: fetches every recorded ref back out of the bundle with a
//!      force-update refspec, pinning any at-risk CURRENT tip under
//!      `refs/gitgui/deleted/*` first (via `safety::pin_deleted_tip`, reused
//!      directly) so a restore can never silently orphan work either.
//!
//! Read/write split, as everywhere else in this codebase: mutations
//! (backup/run/restore) shell out to the git CLI (`git filter-repo` is a
//! Python script wrapping plumbing the CLI itself, and libgit2 has no
//! filter-repo porcelain at all); git2 is used only to open the repo and read
//! small bits of ref/HEAD identity.
//!
//! Failure model (mirrors `git_pick::PickResult` / `git_bisect::BisectStatus`,
//! NOT `safety::UndoResult`'s `Result<T,String>` shape): the two MUTATING
//! commands (`filter_repo_run`, `filter_repo_restore`) return a plain
//! `FilterRepoResult` struct — `ok:false` + a message, never a Rust `Err` /
//! JS promise rejection — because a failed filter-repo run or restore is an
//! expected, recoverable outcome the UI must render, not an exceptional one.
//! The two READ-ONLY commands (`filter_repo_preview`,
//! `filter_repo_list_backups`) return `Result<T, String>`, matching the
//! `conflict_status` / `list_refs` convention for pure reads.

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use git2::Repository;
use serde::{Deserialize, Serialize};

use crate::procutil::NoConsoleWindowExt;

/// Process-wide monotonic tie-breaker, mirrors `safety.rs`'s `SNAP_SEQ`: two
/// backups taken in the same nanosecond still get distinct ids.
static SEQ: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// git CLI runner (own copy — same shape as safety::run_git / git_bisect::git)
// ---------------------------------------------------------------------------

struct Out {
    ok: bool,
    stdout: String,
    stderr: String,
}

/// Run `git -C <path> <args…>`. `Err` only when git itself can't be spawned
/// (not installed / not on PATH); a non-zero git exit is `Ok(Out{ok:false})`.
fn git(path: &str, args: &[&str]) -> Result<Out, String> {
    let o = Command::new("git")
        .no_console_window()
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    Ok(Out {
        ok: o.status.success(),
        stdout: String::from_utf8_lossy(&o.stdout).trim_end().to_string(),
        stderr: String::from_utf8_lossy(&o.stderr).trim_end().to_string(),
    })
}

fn git_msg(o: &Out) -> String {
    if !o.stderr.is_empty() {
        o.stderr.clone()
    } else if !o.stdout.is_empty() {
        o.stdout.clone()
    } else {
        "git exited with a non-zero status".to_string()
    }
}

fn open(path: &str) -> Result<Repository, String> {
    crate::trust::open_repo(path).map_err(|e| format!("cannot open repository: {}", e.message()))
}

/// The full symbolic HEAD ("refs/heads/…") when on a branch, else "" (detached).
/// Small private mirror of `safety::current_symref` (not `pub` there).
fn current_symref(repo: &Repository) -> String {
    match repo.head() {
        Ok(h) if h.is_branch() => h.name().unwrap_or("").to_string(),
        _ => String::new(),
    }
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// Result of `filter_repo_run` / `filter_repo_restore`. Plain struct (never a
/// Rust `Err`) — see module docs on the failure model.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FilterRepoResult {
    pub ok: bool,
    pub message: String,
    pub backup_bundle: Option<String>,
    pub commits_before: Option<usize>,
    pub commits_after: Option<usize>,
}

impl FilterRepoResult {
    fn error(message: impl Into<String>) -> Self {
        Self { ok: false, message: message.into(), backup_bundle: None, commits_before: None, commits_after: None }
    }
}

/// Read-only preview shown BEFORE the user commits to running filter-repo.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FilterRepoPreview {
    /// Whether the `git-filter-repo` binary is available at all, so the
    /// wizard's final confirm step can be disabled/greyed cleanly.
    pub available: bool,
    pub current_branch: String,
    pub total_commits: usize,
    /// `git rev-list --count HEAD -- <paths...>` — how many commits on the
    /// current branch touch the requested scope.
    pub touched_commits: usize,
}

/// One backup entry as shown in a "restore from a previous backup" list.
#[derive(Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FilterRepoBackupInfo {
    /// Opaque id passed back into `filter_repo_restore`.
    pub id: String,
    pub bundle_path: String,
    pub ts: i64,
    /// Symbolic HEAD ref at backup time ("refs/heads/main"), "" if detached.
    pub head_branch: String,
    pub head_sha: String,
    pub ref_count: usize,
    pub description: String,
}

/// One line of `<git-dir>/gitgui/filter-repo-log.jsonl`. Deliberately
/// separate from `safety.rs`'s `oplog.jsonl` — restore semantics here cover
/// every ref namespace the bundle captured, not just local branches.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    id: String,
    ts: i64,
    bundle_path: String,
    /// Symbolic HEAD ref name at backup time ("refs/heads/main"), "" if detached.
    head_branch: String,
    head_sha: String,
    /// EVERY ref the bundle actually captured: full ref name -> sha, straight
    /// from `git bundle list-heads` — may include refs/heads/*, refs/tags/*,
    /// refs/remotes/*, refs/notes/*, whatever the repo actually had.
    refs: Vec<(String, String)>,
    description: String,
}

// ---------------------------------------------------------------------------
// paths / log helpers
// ---------------------------------------------------------------------------

fn backups_dir(repo: &Repository) -> PathBuf {
    repo.path().join("gitgui").join("filter-repo-backups")
}

fn log_path(repo: &Repository) -> PathBuf {
    repo.path().join("gitgui").join("filter-repo-log.jsonl")
}

fn new_backup_id() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let seq = SEQ.fetch_add(1, Ordering::SeqCst);
    format!("{}-{}-{}", now.as_secs(), now.subsec_nanos(), seq)
}

fn append_manifest(repo: &Repository, m: &BackupManifest) {
    let p = log_path(repo);
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(line) = serde_json::to_string(m) {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&p) {
            let _ = writeln!(f, "{line}");
        }
    }
}

fn read_manifests(repo: &Repository) -> Vec<BackupManifest> {
    let Ok(data) = fs::read_to_string(log_path(repo)) else {
        return Vec::new();
    };
    data.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

fn find_manifest(repo: &Repository, backup_id: &str) -> Option<BackupManifest> {
    // Last match wins, mirroring safety.rs's oplog lookups (a later line for
    // the same id would only ever be a re-append of the same fixed content,
    // but this keeps the convention identical).
    read_manifests(repo).into_iter().rev().find(|m| m.id == backup_id)
}

fn commit_count(path: &str) -> usize {
    git(path, &["rev-list", "--all", "--count"])
        .ok()
        .filter(|o| o.ok)
        .and_then(|o| o.stdout.parse().ok())
        .unwrap_or(0)
}

fn filter_repo_available(path: &str) -> bool {
    git(path, &["filter-repo", "--version"]).map(|o| o.ok).unwrap_or(false)
}

// ---------------------------------------------------------------------------
// backup (step 1+2: bundle create, verify, list-heads, manifest)
// ---------------------------------------------------------------------------

/// Create + immediately verify a full-repo bundle backup, and record its
/// manifest (every ref the bundle captured). On ANY failure the partial
/// bundle file is removed and an error is returned — callers must treat this
/// as "do not proceed to filter-repo".
fn backup(repo: &Repository, path: &str) -> Result<BackupManifest, String> {
    let dir = backups_dir(repo);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create backup directory: {e}"))?;

    let id = new_backup_id();
    let bundle_path = dir.join(format!("{id}.bundle"));
    let bundle_str = bundle_path.to_string_lossy().to_string();

    let create = git(path, &["bundle", "create", &bundle_str, "--all"])?;
    if !create.ok {
        let _ = fs::remove_file(&bundle_path);
        return Err(format!("backup bundle creation failed: {}", git_msg(&create)));
    }

    let verify = git(path, &["bundle", "verify", &bundle_str])?;
    if !verify.ok {
        let _ = fs::remove_file(&bundle_path);
        return Err(format!("backup bundle failed verification, aborting: {}", git_msg(&verify)));
    }

    let heads = git(path, &["bundle", "list-heads", &bundle_str])?;
    if !heads.ok {
        let _ = fs::remove_file(&bundle_path);
        return Err(format!("could not enumerate the backup's refs, aborting: {}", git_msg(&heads)));
    }
    // `git bundle list-heads` always emits a synthetic bare `HEAD` pseudo-line
    // (unprefixed, no `refs/`) alongside the real refs — verified empirically.
    // MUST be filtered out here: HEAD restoration is handled separately and
    // correctly via `head_branch`/`head_sha` + the explicit `symbolic-ref` +
    // `reset --hard` steps in filter_repo_restore. If this pseudo-entry were
    // stored as a real ref, restore's generic per-ref loop would later run
    // `git update-ref HEAD <stale-sha>` — which DEREFERENCES symbolic HEAD and
    // silently force-moves whatever branch is CURRENTLY checked out, even one
    // that never existed at backup time. Only ever record real `refs/...` names.
    let mut refs: Vec<(String, String)> = Vec::new();
    for line in heads.stdout.lines() {
        let mut it = line.split_whitespace();
        if let (Some(sha), Some(name)) = (it.next(), it.next()) {
            if name.starts_with("refs/") {
                refs.push((name.to_string(), sha.to_string()));
            }
        }
    }
    if refs.is_empty() {
        let _ = fs::remove_file(&bundle_path);
        return Err("backup bundle captured no refs, aborting".to_string());
    }

    let head_branch = current_symref(repo);
    let head_sha = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| c.id().to_string())
        .unwrap_or_default();

    let manifest = BackupManifest {
        id,
        ts: now_secs(),
        bundle_path: bundle_str,
        head_branch,
        head_sha,
        description: format!("pre-filter-repo backup ({} refs)", refs.len()),
        refs,
    };
    append_manifest(repo, &manifest);
    Ok(manifest)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Read-only preview shown before the user commits to running filter-repo.
/// Its `commit_count`/`touched_commits` numbers come from `git rev-list
/// --count`, a full history walk shelled out via `Command::new`, so its cost
/// scales with total repo size just like the mutating commands below — run
/// as a plain sync fn this would freeze the whole window while the wizard's
/// preview step merely counts commits.
#[tauri::command]
#[specta::specta]
pub async fn filter_repo_preview(path: String, paths: Vec<String>, invert: bool) -> Result<FilterRepoPreview, String> {
    crate::blocking::run_blocking(move || filter_repo_preview_inner(path, paths, invert)).await
}

fn filter_repo_preview_inner(path: String, paths: Vec<String>, invert: bool) -> Result<FilterRepoPreview, String> {
    let repo = open(&path)?;
    let available = filter_repo_available(&path);
    let current_branch = {
        let sym = current_symref(&repo);
        sym.strip_prefix("refs/heads/").map(str::to_string).unwrap_or(sym)
    };
    let total_commits = commit_count(&path);

    // `invert` doesn't change WHICH commits touch the requested paths — it
    // only changes what filter-repo does with them (keep-only vs. strip) — so
    // the touched-commit count is the same either way; it's exactly the set
    // of commits the eventual `--path`/`--invert-paths` run will rewrite.
    let _ = invert;
    let touched_commits = if paths.is_empty() {
        0
    } else {
        let mut args: Vec<&str> = vec!["rev-list", "--count", "HEAD", "--"];
        args.extend(paths.iter().map(|s| s.as_str()));
        git(&path, &args).ok().filter(|o| o.ok).and_then(|o| o.stdout.parse().ok()).unwrap_or(0)
    };

    Ok(FilterRepoPreview { available, current_branch, total_commits, touched_commits })
}

/// List available backups (survives app restarts — reads the on-disk log).
#[tauri::command]
#[specta::specta]
pub fn filter_repo_list_backups(path: String) -> Result<Vec<FilterRepoBackupInfo>, String> {
    let repo = open(&path)?;
    let mut infos: Vec<FilterRepoBackupInfo> = read_manifests(&repo)
        .into_iter()
        .map(|m| FilterRepoBackupInfo {
            id: m.id,
            bundle_path: m.bundle_path,
            ts: m.ts,
            head_branch: m.head_branch,
            head_sha: m.head_sha,
            ref_count: m.refs.len(),
            description: m.description,
        })
        .collect();
    infos.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(infos)
}

/// Run `git filter-repo` against the given scope, after a mandatory verified
/// backup. Plain-struct failure model — see module docs. This is the single
/// most important conversion in this module: it shells out to `git bundle
/// create --all`/`bundle verify` and then `git filter-repo` itself, which
/// rewrites EVERY commit in the selected history — on a real repo that can
/// run for minutes, and as a plain sync fn it would freeze the entire GitCat
/// window, not just the wizard, for the whole duration.
#[tauri::command]
#[specta::specta]
pub async fn filter_repo_run(path: String, paths: Vec<String>, invert: bool) -> FilterRepoResult {
    crate::blocking::run_blocking(move || filter_repo_run_inner(path, paths, invert)).await
}

fn filter_repo_run_inner(path: String, paths: Vec<String>, invert: bool) -> FilterRepoResult {
    let repo = match open(&path) {
        Ok(r) => r,
        Err(e) => return FilterRepoResult::error(e),
    };

    // Precondition (a): git-filter-repo actually available.
    match git(&path, &["filter-repo", "--version"]) {
        Ok(o) if o.ok => {}
        Ok(o) => {
            return FilterRepoResult::error(format!(
                "git-filter-repo is not available ({}) — install with: pip install git-filter-repo",
                git_msg(&o)
            ))
        }
        Err(e) => return FilterRepoResult::error(e),
    }

    // Precondition (c): scope non-empty and validated (no empty strings).
    if paths.is_empty() {
        return FilterRepoResult::error("Select at least one path to filter.");
    }
    if paths.iter().any(|p| p.trim().is_empty()) {
        return FilterRepoResult::error("Path list contains an empty entry.");
    }

    // Precondition (b): working tree clean (fail-closed, mirrors bisect_start/undo).
    match git(&path, &["status", "--porcelain"]) {
        Ok(o) if !o.ok => {
            return FilterRepoResult::error(format!(
                "Cannot verify the working tree is clean, refusing: {}",
                git_msg(&o)
            ))
        }
        Ok(o) if !o.stdout.is_empty() => {
            return FilterRepoResult::error(
                "Working tree has uncommitted changes — commit or stash before rewriting history.",
            )
        }
        Ok(_) => {}
        Err(e) => return FilterRepoResult::error(e),
    }

    let commits_before = commit_count(&path);

    // BACKUP FIRST — mandatory. Abort before ever invoking filter-repo if
    // creation or verification fails for any reason.
    let manifest = match backup(&repo, &path) {
        Ok(m) => m,
        Err(e) => return FilterRepoResult::error(format!("Backup failed, aborting before touching history: {e}")),
    };

    let mut owned_args: Vec<String> = Vec::new();
    for p in &paths {
        owned_args.push("--path".to_string());
        owned_args.push(p.clone());
    }
    if invert {
        owned_args.push("--invert-paths".to_string());
    }
    owned_args.push("--force".to_string());

    let mut args: Vec<&str> = vec!["filter-repo"];
    args.extend(owned_args.iter().map(|s| s.as_str()));

    let run = match git(&path, &args) {
        Ok(o) => o,
        Err(e) => {
            return FilterRepoResult {
                ok: false,
                message: format!("Could not run git-filter-repo: {e}"),
                backup_bundle: Some(manifest.bundle_path),
                commits_before: Some(commits_before),
                commits_after: None,
            }
        }
    };
    if !run.ok {
        return FilterRepoResult {
            ok: false,
            message: format!("git-filter-repo failed: {}", git_msg(&run)),
            backup_bundle: Some(manifest.bundle_path),
            commits_before: Some(commits_before),
            commits_after: None,
        };
    }

    let commits_after = commit_count(&path);
    FilterRepoResult {
        ok: true,
        message: format!(
            "History rewritten ({commits_before} → {commits_after} commits). A verified backup was saved — use Restore if anything looks wrong."
        ),
        backup_bundle: Some(manifest.bundle_path),
        commits_before: Some(commits_before),
        commits_after: Some(commits_after),
    }
}

/// Restore every ref namespace a previous backup captured. Pins any
/// at-risk CURRENT tip under `refs/gitgui/deleted/*` first (data-safety,
/// mirrors safety::undo's pre-move pinning) so nothing is silently orphaned
/// even if the user regrets the restore itself. Restoring re-fetches every
/// recorded ref out of the backup bundle and runs `git reset --hard`, all via
/// `Command::new` — a cost that scales with repo/ref count, so this must stay
/// off the main thread exactly like `filter_repo_run`.
#[tauri::command]
#[specta::specta]
pub async fn filter_repo_restore(path: String, backup_id: String) -> FilterRepoResult {
    crate::blocking::run_blocking(move || filter_repo_restore_inner(path, backup_id)).await
}

fn filter_repo_restore_inner(path: String, backup_id: String) -> FilterRepoResult {
    let repo = match open(&path) {
        Ok(r) => r,
        Err(e) => return FilterRepoResult::error(e),
    };

    let manifest = match find_manifest(&repo, &backup_id) {
        Some(m) => m,
        None => return FilterRepoResult::error(format!("No backup found with id {backup_id:?}.")),
    };

    if !std::path::Path::new(&manifest.bundle_path).exists() {
        return FilterRepoResult::error(format!("Backup bundle is missing on disk: {}", manifest.bundle_path));
    }

    // Fail-closed on a dirty tree, same as safety::undo / bisect_start — a
    // `reset --hard` at the end would otherwise silently discard it.
    match git(&path, &["status", "--porcelain"]) {
        Ok(o) if !o.ok => {
            return FilterRepoResult::error(format!(
                "Cannot verify the working tree is clean, refusing restore: {}",
                git_msg(&o)
            ))
        }
        Ok(o) if !o.stdout.is_empty() => {
            return FilterRepoResult::error(
                "Working tree has uncommitted changes — commit or stash before restoring.",
            )
        }
        Ok(_) => {}
        Err(e) => return FilterRepoResult::error(e),
    }

    // Re-verify the bundle before trusting it (cheap, and the bundle could in
    // principle have rotted/been truncated since it was written).
    let verify = match git(&path, &["bundle", "verify", &manifest.bundle_path]) {
        Ok(o) => o,
        Err(e) => return FilterRepoResult::error(e),
    };
    if !verify.ok {
        return FilterRepoResult::error(format!("Backup bundle failed verification, refusing to restore: {}", git_msg(&verify)));
    }

    // Data-safety FIRST: pin every CURRENT ref this restore is about to move
    // or delete, so no post-filter-repo commit can be silently orphaned if
    // the user later regrets the restore. Best-effort per ref (mirrors
    // safety::undo) — one stubborn ref must not abort the whole restore.
    let current_refs = current_ref_shas(&path);
    let target_map: std::collections::BTreeMap<&str, &str> =
        manifest.refs.iter().map(|(n, s)| (n.as_str(), s.as_str())).collect();
    for (name, cur_sha) in &current_refs {
        let will_change = target_map.get(name.as_str()).map(|t| *t != cur_sha).unwrap_or(true);
        if will_change {
            if let Ok(oid) = git2::Oid::from_str(cur_sha) {
                let _ = crate::safety::pin_deleted_tip(&repo, oid, name);
            }
        }
    }

    // Fetch every recorded ref's object into the local odb under a SCRATCH ref
    // name first, then move the real ref with `update-ref` — NOT a direct
    // `git fetch <bundle> "+<sha>:<name>"` refspec. Verified empirically (see
    // tests/filter_repo.rs): git refuses a plain fetch straight into whichever
    // branch is currently checked out ("fatal: refusing to fetch into branch
    // 'refs/heads/main' checked out at ..."), which is exactly the common case
    // here (the branch you just ran filter-repo on is checked out). Fetching
    // into a disposable scratch ref sidesteps that refusal entirely (no
    // checked-out branch has that name), and unlike `git branch -f`,
    // `git update-ref` has no such restriction — it happily repoints the
    // checked-out branch's ref (the working tree is resynced by the
    // `reset --hard` below regardless).
    let mut restored = 0usize;
    let mut failures: Vec<String> = Vec::new();
    let mut scratch_refs: Vec<String> = Vec::new();
    for (i, (name, sha)) in manifest.refs.iter().enumerate() {
        let scratch = format!("refs/gitgui/filter-repo-restore-tmp/{i}");
        let refspec = format!("+{sha}:{scratch}");
        let fetch = git(&path, &["fetch", "--no-tags", manifest.bundle_path.as_str(), refspec.as_str()]);
        match fetch {
            Ok(o) if o.ok => {
                scratch_refs.push(scratch);
                match git(&path, &["update-ref", name, sha]) {
                    Ok(u) if u.ok => restored += 1,
                    Ok(u) => failures.push(format!("{name}: {}", git_msg(&u))),
                    Err(e) => failures.push(format!("{name}: {e}")),
                }
            }
            Ok(o) => failures.push(format!("{name}: fetch failed: {}", git_msg(&o))),
            Err(e) => failures.push(format!("{name}: fetch failed: {e}")),
        }
    }
    // Best-effort cleanup of the scratch refs — leaving one behind is harmless
    // (it's under GitCat's own namespace) but tidy is nicer.
    for s in &scratch_refs {
        let _ = git(&path, &["update-ref", "-d", s]);
    }

    // Restore the symbolic HEAD, then sync the working tree to the recorded
    // HEAD sha (mirrors safety::undo's HEAD-restoration step).
    if !manifest.head_branch.is_empty() {
        let sr = match git(&path, &["symbolic-ref", "HEAD", &manifest.head_branch]) {
            Ok(o) => o,
            Err(e) => return FilterRepoResult::error(format!("Restore failed setting HEAD: {e}")),
        };
        if !sr.ok {
            return FilterRepoResult::error(format!("Restore failed setting HEAD: {}", git_msg(&sr)));
        }
    }
    if !manifest.head_sha.is_empty() {
        let reset = match git(&path, &["reset", "--hard", &manifest.head_sha]) {
            Ok(o) => o,
            Err(e) => return FilterRepoResult::error(format!("Restore failed resetting the working tree: {e}")),
        };
        if !reset.ok {
            return FilterRepoResult::error(format!("Restore failed resetting the working tree: {}", git_msg(&reset)));
        }
    }

    let commits_after = commit_count(&path);
    let mut message = format!(
        "Restored {restored}/{} ref(s) from backup {backup_id}.",
        manifest.refs.len()
    );
    if !failures.is_empty() {
        message.push_str(&format!(" Failures: {}", failures.join("; ")));
    }

    FilterRepoResult {
        ok: failures.is_empty(),
        message,
        backup_bundle: Some(manifest.bundle_path),
        commits_before: None,
        commits_after: Some(commits_after),
    }
}

/// Every ref currently in the repo (heads/tags/remotes/notes/whatever exists)
/// -> its current sha, via `git for-each-ref` (CLI, so it sees exactly what a
/// subsequent `git fetch --force` refspec would clobber — no libgit2/CLI
/// divergence risk here since this is purely a read for the pin-before-move
/// safety step).
fn current_ref_shas(path: &str) -> std::collections::BTreeMap<String, String> {
    let mut m = std::collections::BTreeMap::new();
    if let Ok(o) = git(path, &["for-each-ref", "--format=%(refname) %(objectname)"]) {
        if o.ok {
            for line in o.stdout.lines() {
                let mut it = line.split_whitespace();
                if let (Some(name), Some(sha)) = (it.next(), it.next()) {
                    m.insert(name.to_string(), sha.to_string());
                }
            }
        }
    }
    m
}
