//! Partial-clone support: fetch missing blobs on demand before a git2 read.
//!
//! A partial clone (`git clone --filter=blob:none`) has every commit and tree
//! but only the blobs its checkout needed. The git CLI fills the gaps lazily,
//! fetching each missing object from the "promisor" remote the moment it is
//! read. libgit2 cannot do that: reading a missing blob just fails with
//! `object not found - ... (<oid>)`, so before this module a commit's diff, a
//! file preview, a blame or a range compare in such a repo failed outright.
//!
//! [`ensure_blobs`] is the fix. A caller that is about to read blobs through
//! git2 hands it the oids first. In an ordinary repo it returns after one
//! cached lookup. In a partial clone it checks which of those blobs the object
//! database lacks and fetches all of them with ONE `git fetch`, built exactly
//! the way git's own `promisor-remote.c` (`fetch_objects`) builds its lazy
//! fetch:
//!
//! ```text
//! git -c fetch.negotiationAlgorithm=noop fetch <remote> --no-tags
//!     --no-write-fetch-head --recurse-submodules=no --filter=blob:none --stdin
//! ```
//!
//! - `fetch.negotiationAlgorithm=noop`: send no "have" lines. We want specific
//!   objects, not "everything new since what I have", so negotiation would
//!   only cost round trips.
//! - `--no-tags`, `--no-write-fetch-head`, `--recurse-submodules=no`: touch no
//!   refs, no FETCH_HEAD and no submodule. The fetch must not change anything
//!   the user can see apart from the objects now being present.
//! - `--filter=blob:none`: keep the clone partial. The wants are the blobs
//!   themselves, so they are sent; nothing else is.
//! - `--stdin`: the oids go on stdin, one per line, so a commit touching
//!   thousands of files never runs into the Windows command-line length limit.
//!
//! It runs through [`crate::wsl::git_command_tagged`], so a WSL repo fetches inside
//! its distro and credentials, `GIT_TERMINAL_PROMPT=0` and the SSH askpass
//! wiring are the same as for an ordinary fetch, and under a timeout
//! ([`FETCH_TIMEOUT`]). A failure (offline, remote removed, auth refused)
//! becomes the translated `err_repo.partial_clone_fetch_failed` message rather
//! than libgit2's raw "object not found".
//!
//! For reads whose blob set can't be listed up front (libgit2's blame walk
//! follows renames on its own), [`retry_on_missing`] runs the read, and when it
//! fails on a missing object, fetches that object and runs it again.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use git2::{Diff, ErrorCode, FileMode, OdbLookupFlags, Oid, Repository};

use crate::i18n_err::{ierr, ierrp};
use crate::procutil::{run_with, RunOptions};

/// How long one on-demand fetch may run. Generous: it can carry many blobs
/// over a slow link, and the user asked for exactly this content. A hang (a
/// dead connection that never times out on its own) still ends.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(120);

/// How many missing-object round trips [`retry_on_missing`] will make for one
/// read before giving up with the last error.
const MAX_RETRY_ROUNDS: usize = 32;

/// What a repository's config says about partial cloning.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Partial {
    /// The promisor remote to fetch from: `extensions.partialClone`, else the
    /// first `remote.<name>.promisor = true`. `None` when the repo is plainly
    /// partial (it has `.promisor` packs) but no remote is configured any more.
    remote: Option<String>,
}

/// Per-repo cache, keyed by the common git dir. The value is remembered with
/// the mtime of that dir's `config` file: every way a repo becomes (or stops
/// being) partial rewrites config, so a changed mtime is the signal to look
/// again, and an unchanged one means a `stat` is all an ordinary repo pays.
type Cache = HashMap<PathBuf, (Option<SystemTime>, Option<Partial>)>;

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn config_mtime(common: &Path) -> Option<SystemTime> {
    std::fs::metadata(common.join("config")).and_then(|m| m.modified()).ok()
}

/// `Some` when `repo` is a partial clone. Cached; see [`Cache`].
fn partial_info(repo: &Repository) -> Option<Partial> {
    let common = repo.commondir().to_path_buf();
    let mtime = config_mtime(&common);
    if let Ok(map) = cache().lock() {
        if let Some((m, info)) = map.get(&common) {
            if *m == mtime {
                return info.clone();
            }
        }
    }
    let info = detect(repo, &common);
    if let Ok(mut map) = cache().lock() {
        map.insert(common, (mtime, info.clone()));
    }
    info
}

fn detect(repo: &Repository, common: &Path) -> Option<Partial> {
    let mut remote: Option<String> = None;
    let mut config_says_partial = false;
    if let Ok(cfg) = repo.config() {
        // Config keys are case-insensitive; git2 lowercases section and key.
        if let Ok(name) = cfg.get_string("extensions.partialclone") {
            config_says_partial = true;
            if !name.trim().is_empty() {
                remote = Some(name.trim().to_string());
            }
        }
        if remote.is_none() {
            if let Ok(mut entries) = cfg.entries(Some(r"^remote\..*\.promisor$")) {
                while let Some(Ok(entry)) = entries.next() {
                    // A bare `promisor` key with no `= value` means true.
                    let truthy = match entry.value() {
                        None => true,
                        Some(v) => matches!(v.trim().to_ascii_lowercase().as_str(), "true" | "yes" | "on" | "1" | ""),
                    };
                    if !truthy {
                        continue;
                    }
                    if let Some(name) = entry
                        .name()
                        .and_then(|n| n.strip_prefix("remote."))
                        .and_then(|n| n.strip_suffix(".promisor"))
                    {
                        config_says_partial = true;
                        remote = Some(name.to_string());
                        break;
                    }
                }
            }
        }
    }
    // A remote that config names but that no longer exists (removed with `git
    // remote remove`) still counts as partial: the fetch will fail and say so.
    if config_says_partial || has_promisor_pack(common) {
        Some(Partial { remote })
    } else {
        None
    }
}

/// git marks every pack fetched from a promisor remote with a sibling
/// `pack-<hash>.promisor` file. Present even when config was edited away.
fn has_promisor_pack(common: &Path) -> bool {
    std::fs::read_dir(common.join("objects").join("pack"))
        .map(|rd| {
            rd.flatten()
                .any(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("promisor")))
        })
        .unwrap_or(false)
}

/// True when `repo` is a partial clone. Cheap after the first call per repo.
pub fn is_partial_clone(repo: &Repository) -> bool {
    partial_info(repo).is_some()
}

/// Make sure every blob in `oids` is in `repo`'s object database, fetching the
/// missing ones from the promisor remote in one `git fetch` (see module doc).
///
/// A no-op (one cached `stat`) unless `repo` is a partial clone. Zero oids are
/// ignored. `Err` is an `i18n:` string ready to return to the frontend.
pub fn ensure_blobs(repo: &Repository, oids: impl IntoIterator<Item = Oid>) -> Result<(), String> {
    let Some(info) = partial_info(repo) else {
        return Ok(());
    };
    let odb = repo.odb().map_err(|e| e.message().to_string())?;
    let mut seen = HashSet::new();
    // NO_REFRESH: a miss is expected here, and the default refresh would
    // rescan the pack directory once per missing blob.
    let missing: Vec<Oid> = oids
        .into_iter()
        .filter(|o| !o.is_zero() && seen.insert(*o))
        .filter(|o| !odb.exists_ext(*o, OdbLookupFlags::NO_REFRESH))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    // A pack written since this handle last looked (another fetch, a git
    // command in a terminal) may already hold them.
    let _ = odb.refresh();
    let missing: Vec<Oid> = missing.into_iter().filter(|o| !odb.exists_ext(*o, OdbLookupFlags::NO_REFRESH)).collect();
    if missing.is_empty() {
        return Ok(());
    }
    let Some(remote) = info.remote else {
        return Err(ierr("err_repo.partial_clone_no_remote"));
    };
    fetch(repo, &remote, &missing)?;
    let _ = odb.refresh();
    if let Some(still) = missing.iter().find(|o| !odb.exists(**o)) {
        return Err(fetch_failed(&remote, &format!("the remote did not send object {still}")));
    }
    Ok(())
}

/// [`ensure_blobs`] for a `git2::Error`-returning caller: the i18n message
/// travels as the error's message, which every such caller already forwards
/// to the frontend with `e.message()`.
pub fn ensure_blobs_git2(repo: &Repository, oids: impl IntoIterator<Item = Oid>) -> Result<(), git2::Error> {
    ensure_blobs(repo, oids).map_err(|m| git2::Error::from_str(&m))
}

/// Every blob either side of `diff` refers to, for [`ensure_blobs`]. Reads
/// only the delta list a tree-to-tree diff already holds — no blob content.
/// Gitlinks (submodule commits) and trees are skipped: they are not blobs and
/// are never fetched as such.
pub fn diff_blob_oids(diff: &Diff<'_>) -> Vec<Oid> {
    let mut out = Vec::new();
    for delta in diff.deltas() {
        if delta.status() == git2::Delta::Unmodified {
            continue;
        }
        for file in [delta.old_file(), delta.new_file()] {
            let is_blob = matches!(
                file.mode(),
                FileMode::Blob | FileMode::BlobExecutable | FileMode::BlobGroupWritable | FileMode::Link
            );
            if is_blob && !file.id().is_zero() {
                out.push(file.id());
            }
        }
    }
    out
}

/// Run `op`; if it fails because an object is missing from a partial clone,
/// fetch that object and run it again (up to [`MAX_RETRY_ROUNDS`] times). For
/// reads that discover what they need as they go — libgit2's blame walk, a
/// rev-spec that names a blob. In an ordinary repo, or on any other error,
/// the error is returned unchanged; a failed fetch replaces it with the i18n
/// message (see [`ensure_blobs_git2`]).
pub fn retry_on_missing<T>(repo: &Repository, mut op: impl FnMut() -> Result<T, git2::Error>) -> Result<T, git2::Error> {
    let mut fetched: HashSet<Oid> = HashSet::new();
    let mut rounds = 0;
    loop {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) => {
                if rounds >= MAX_RETRY_ROUNDS || e.code() != ErrorCode::NotFound || !is_partial_clone(repo) {
                    return Err(e);
                }
                let Some(oid) = missing_oid_in(e.message()) else {
                    return Err(e);
                };
                // The same oid again means the fetch "succeeded" but the read
                // still fails: stop instead of looping.
                if !fetched.insert(oid) {
                    return Err(e);
                }
                ensure_blobs_git2(repo, [oid])?;
                rounds += 1;
            }
        }
    }
}

/// The oid in libgit2's not-found message, `object not found - <why> (<hex>)`.
/// Only a full-length oid: an abbreviated one is a prefix lookup that failed,
/// not a known object to fetch.
pub fn missing_oid_in(message: &str) -> Option<Oid> {
    let open = message.rfind('(')?;
    let rest = &message[open + 1..];
    let hex = &rest[..rest.find(')')?];
    if (hex.len() == 40 || hex.len() == 64) && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Oid::from_str(hex).ok()
    } else {
        None
    }
}

/// The directory to run git in for `repo`: its working tree, or the git dir
/// itself for a bare repo. Either way `git -C` finds the same repository.
fn git_dir_arg(repo: &Repository) -> String {
    repo.workdir().unwrap_or_else(|| repo.path()).to_string_lossy().into_owned()
}

fn fetch(repo: &Repository, remote: &str, oids: &[Oid]) -> Result<(), String> {
    let path = git_dir_arg(repo);
    let (cmd, tag) = crate::wsl::git_command_tagged(
        &path,
        &[
            "-c",
            "fetch.negotiationAlgorithm=noop",
            "fetch",
            remote,
            "--no-tags",
            "--no-write-fetch-head",
            "--recurse-submodules=no",
            "--filter=blob:none",
            "--stdin",
        ],
        &[],
    );
    let mut input = String::with_capacity(oids.len() * 41);
    for o in oids {
        input.push_str(&o.to_string());
        input.push('\n');
    }
    log::info!("partial clone: fetching {} missing blob(s) from '{remote}' for {path}", oids.len());
    // A network op with a hard timeout, deliberately: it blocks diff, blame
    // and preview, and nothing in the UI can cancel it, so an unbounded wait
    // would turn a stuck remote into a permanently stuck pane. The WSL tag
    // makes a timeout kill the in-distro git (and its ssh) too.
    // FOLLOW-UP(jobs): register as a job so it can be cancelled from the UI,
    // then drop the hard timeout in favour of stall detection.
    let opts = RunOptions { stdin: Some(input.into_bytes()), timeout: Some(FETCH_TIMEOUT), wsl: tag, ..Default::default() };
    match run_with(cmd, opts) {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let detail = tail_lines(&stderr, 3);
            let detail = if detail.is_empty() { format!("git exited with status {:?}", out.status.code()) } else { detail };
            log::warn!("partial clone: fetch from '{remote}' failed: {detail}");
            Err(fetch_failed(remote, &detail))
        }
        Err(e) => {
            log::warn!("partial clone: could not run fetch from '{remote}': {e}");
            Err(fetch_failed(remote, &e.to_string()))
        }
    }
}

fn fetch_failed(remote: &str, detail: &str) -> String {
    ierrp("err_repo.partial_clone_fetch_failed", &[("remote", remote), ("detail", detail)])
}

/// The last `n` non-empty lines of git's stderr: the actual error, without a
/// screenful of progress output in front of it.
fn tail_lines(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join(" / ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_oid_is_parsed_from_libgit2s_not_found_message() {
        let hex = "0123456789abcdef0123456789abcdef01234567";
        let msg = format!("object not found - cannot read header for ({hex})");
        assert_eq!(missing_oid_in(&msg), Some(Oid::from_str(hex).unwrap()));
        let msg = format!("object not found - no match for id ({hex})");
        assert_eq!(missing_oid_in(&msg), Some(Oid::from_str(hex).unwrap()));
    }

    #[test]
    fn an_abbreviated_or_absent_oid_is_not_parsed() {
        assert_eq!(missing_oid_in("object not found - no match for id (0123456)"), None);
        assert_eq!(missing_oid_in("reference 'refs/heads/x' not found"), None);
        assert_eq!(missing_oid_in("weird (not hex at all, but forty chars long!!)"), None);
    }

    #[test]
    fn tail_lines_keeps_only_the_last_non_empty_lines() {
        assert_eq!(tail_lines("a\n\nb\nc\n  \nd\n", 2), "c / d");
        assert_eq!(tail_lines("", 3), "");
        assert_eq!(tail_lines("only\n", 3), "only");
    }
}
