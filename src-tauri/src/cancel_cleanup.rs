//! What a cancelled git op may leave behind, and how to clean only OUR part
//! of it up (#133).
//!
//! A cancel kills the whole git process tree (see `procutil::run_with`). On
//! Unix git gets a SIGTERM first and its sigchain removes its own `.lock`
//! files; on Windows there is no soft stop, and a killed git can leave
//! `index.lock` / a `refs/...lock` behind, which then makes every later git
//! command in that repo fail with "Unable to create '…/index.lock': File
//! exists". A killed `pull` can also be caught mid-merge/rebase.
//!
//! The rule is narrow on purpose: a lock is removed only if it was NOT there
//! before the op started (`pre_op` snapshots the existing ones) and its mtime
//! falls inside the op's window — a lock the user's own terminal git, or an
//! earlier crash, left behind is never touched. A merge/rebase/… state is
//! aborted only if the repo was clean before the op. The caller also skips the
//! lock step entirely while another registered job is live on the same repo
//! (`JobRegistry::others_on_repo`).
//!
//! Residual case, documented rather than solved: a lock created DURING our op
//! by an unregistered git (the user's terminal, or one of GitCat's own
//! short-lived status reads) passes both tests and would be removed. The
//! window is the op's own duration, and such a git would itself have failed
//! or finished by the time a cancel completes, in the common case.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use git2::RepositoryState;

use crate::procutil::{output_with_timeout, LOCAL_OP_TIMEOUT};

/// A lock's mtime may predate `PreOp::started` by this much and still count
/// as ours — filesystem timestamps are coarse (FAT, SMB, the WSL 9P bridge).
const MTIME_SLACK: Duration = Duration::from_secs(5);
const MAX_REFS_DEPTH: usize = 8;
const MAX_REFS_ENTRIES: usize = 10_000;

/// Taken right before the op spawns.
pub struct PreOp {
    locks: HashSet<PathBuf>,
    state: RepositoryState,
    started: SystemTime,
}

#[derive(Debug, Default)]
pub struct CleanupReport {
    /// Removed lock files, relative to the git dir, `/`-separated.
    pub removed_locks: Vec<String>,
    /// The op that was `--abort`ed: "merge" | "rebase" | "am" | "cherry-pick" | "revert".
    pub aborted: Option<&'static str>,
}

/// Every lock file git may hold that we know how to look for. In the
/// (per-worktree) git dir: index/HEAD/ORIG_HEAD/config/FETCH_HEAD. In the
/// common dir: packed-refs, shallow, config, and every `*.lock` under `refs/`
/// (a bounded walk).
fn scan_locks(git_dir: &Path, common_dir: &Path) -> HashSet<PathBuf> {
    let mut found = HashSet::new();
    for name in ["index.lock", "HEAD.lock", "ORIG_HEAD.lock", "config.lock", "FETCH_HEAD.lock"] {
        let p = git_dir.join(name);
        if p.is_file() {
            found.insert(p);
        }
    }
    for name in ["packed-refs.lock", "shallow.lock", "config.lock"] {
        let p = common_dir.join(name);
        if p.is_file() {
            found.insert(p);
        }
    }
    let mut budget = MAX_REFS_ENTRIES;
    walk_ref_locks(&common_dir.join("refs"), 0, &mut budget, &mut found);
    if git_dir != common_dir {
        // A linked worktree's own refs (refs/bisect, refs/worktree, …).
        walk_ref_locks(&git_dir.join("refs"), 0, &mut budget, &mut found);
    }
    found
}

fn walk_ref_locks(dir: &Path, depth: usize, budget: &mut usize, found: &mut HashSet<PathBuf>) {
    if depth > MAX_REFS_DEPTH {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        if *budget == 0 {
            return;
        }
        *budget -= 1;
        let Ok(ft) = entry.file_type() else { continue };
        let p = entry.path();
        if ft.is_dir() {
            walk_ref_locks(&p, depth + 1, budget, found);
        } else if ft.is_file() && p.extension().is_some_and(|e| e == "lock") {
            found.insert(p);
        }
    }
}

pub fn pre_op(repo: &git2::Repository) -> PreOp {
    PreOp {
        locks: scan_locks(repo.path(), repo.commondir()),
        state: repo.state(),
        started: SystemTime::now(),
    }
}

/// The `git <op> --abort` that backs out `state`, if it is one we abort.
///
/// `ApplyMailboxOrRebase` is a `rebase-apply/` dir git2 can't attribute; the
/// only thing here that creates one is `pull` with a rebase config, so it is a
/// rebase.
fn abort_op_for(state: RepositoryState) -> Option<&'static str> {
    use RepositoryState::*;
    match state {
        Merge => Some("merge"),
        Rebase | RebaseInteractive | RebaseMerge | ApplyMailboxOrRebase => Some("rebase"),
        ApplyMailbox => Some("am"),
        CherryPick | CherryPickSequence => Some("cherry-pick"),
        Revert | RevertSequence => Some("revert"),
        Clean | Bisect => None,
    }
}

fn rel_to_git_dir(p: &Path, git_dir: &Path, common_dir: &Path) -> String {
    let rel = p.strip_prefix(git_dir).or_else(|_| p.strip_prefix(common_dir)).unwrap_or(p);
    rel.to_string_lossy().replace('\\', "/")
}

/// Call only AFTER `run_with` returned `Cancelled` — the tree is dead by then,
/// the WSL in-distro sweep included, so nothing of ours still holds a lock.
///
/// 1. Unless `skip_locks`: remove lock files that are new since `pre_op` AND
///    whose mtime is no older than `started - MTIME_SLACK`. Never a
///    pre-existing one.
/// 2. Then, if the repo was clean before and is now mid-merge/rebase/am/
///    cherry-pick/revert, run the matching `git <op> --abort`.
///
/// Locks go first because `--abort` itself needs `index.lock`.
pub fn after_cancel(path: &str, pre: &PreOp, skip_locks: bool) -> CleanupReport {
    let mut report = CleanupReport::default();
    let Ok(repo) = crate::trust::open_repo(path) else { return report };
    let git_dir = repo.path().to_path_buf();
    let common_dir = repo.commondir().to_path_buf();

    if !skip_locks {
        let floor = pre.started.checked_sub(MTIME_SLACK).unwrap_or(pre.started);
        let mut now: Vec<PathBuf> =
            scan_locks(&git_dir, &common_dir).into_iter().filter(|p| !pre.locks.contains(p)).collect();
        now.sort();
        for p in now {
            let fresh = std::fs::metadata(&p).and_then(|m| m.modified()).map(|t| t >= floor).unwrap_or(false);
            if fresh && std::fs::remove_file(&p).is_ok() {
                report.removed_locks.push(rel_to_git_dir(&p, &git_dir, &common_dir));
            }
        }
    }

    if pre.state == RepositoryState::Clean {
        // Re-open: git2 caches nothing about the state, but the first handle
        // predates the lock removal above and a fresh one costs nothing here.
        let state = crate::trust::open_repo(path).map(|r| r.state()).unwrap_or(RepositoryState::Clean);
        if let Some(op) = abort_op_for(state) {
            let cmd = crate::wsl::git_command_env(
                path,
                &[op, "--abort"],
                &[("GIT_EDITOR", "true"), ("GIT_SEQUENCE_EDITOR", "true"), ("LC_ALL", "C")],
            );
            if output_with_timeout(cmd, LOCAL_OP_TIMEOUT).is_ok_and(|o| o.status.success()) {
                report.aborted = Some(op);
            }
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// A throwaway repo under the OS temp dir (the integration suite's
    /// `TempRepo` lives in tests/common and isn't reachable from a unit test).
    struct Repo {
        dir: PathBuf,
    }

    impl Repo {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "gitcat-cancel-cleanup-{tag}-{}-{nanos}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let r = Repo { dir };
            r.git(&["init", "-q", "-b", "main"]);
            for (k, v) in [
                ("commit.gpgsign", "false"),
                ("user.name", "GitCat Test"),
                ("user.email", "test@gitcat.example"),
                ("core.autocrlf", "false"),
                ("gc.auto", "0"),
            ] {
                r.git(&["config", k, v]);
            }
            r
        }

        fn path(&self) -> String {
            self.dir.to_string_lossy().into_owned()
        }

        fn git(&self, args: &[&str]) -> bool {
            Command::new("git")
                .arg("-C")
                .arg(&self.dir)
                .args(args)
                .env("GIT_EDITOR", "true")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }

        fn commit(&self, file: &str, content: &str, msg: &str) {
            std::fs::write(self.dir.join(file), content).unwrap();
            assert!(self.git(&["add", file]));
            assert!(self.git(&["commit", "-q", "-m", msg]));
        }

        fn open(&self) -> git2::Repository {
            git2::Repository::open(&self.dir).unwrap()
        }

        fn git_dir(&self) -> PathBuf {
            self.dir.join(".git")
        }

        /// main and `other` both change f.txt, so `git merge other` conflicts.
        fn with_conflicting_branch(&self) {
            self.commit("f.txt", "base\n", "base");
            assert!(self.git(&["checkout", "-q", "-b", "other"]));
            self.commit("f.txt", "theirs\n", "theirs");
            assert!(self.git(&["checkout", "-q", "main"]));
            self.commit("f.txt", "ours\n", "ours");
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn new_lock_removed_old_lock_kept() {
        let r = Repo::new("locks");
        r.commit("f.txt", "0\n", "c0");
        let old = r.git_dir().join("refs/heads/old.lock");
        std::fs::write(&old, "").unwrap();
        let pre = pre_op(&r.open());

        let index_lock = r.git_dir().join("index.lock");
        let ref_lock = r.git_dir().join("refs/remotes/origin/main.lock");
        std::fs::create_dir_all(ref_lock.parent().unwrap()).unwrap();
        std::fs::write(&index_lock, "").unwrap();
        std::fs::write(&ref_lock, "").unwrap();

        let rep = after_cancel(&r.path(), &pre, false);
        assert!(!index_lock.exists());
        assert!(!ref_lock.exists());
        assert!(old.exists(), "a lock that predates the op is never ours");
        assert_eq!(rep.removed_locks, vec!["index.lock".to_string(), "refs/remotes/origin/main.lock".to_string()]);
        assert_eq!(rep.aborted, None);
    }

    #[test]
    fn skip_locks_removes_nothing() {
        let r = Repo::new("skip");
        r.commit("f.txt", "0\n", "c0");
        let pre = pre_op(&r.open());
        let index_lock = r.git_dir().join("index.lock");
        std::fs::write(&index_lock, "").unwrap();

        let rep = after_cancel(&r.path(), &pre, true);
        assert!(index_lock.exists());
        assert!(rep.removed_locks.is_empty());
    }

    #[test]
    fn merge_in_progress_created_by_op_is_aborted() {
        let r = Repo::new("merge");
        r.with_conflicting_branch();
        let pre = pre_op(&r.open());
        assert!(!r.git(&["merge", "other"]), "the fixture must conflict");
        assert_eq!(r.open().state(), RepositoryState::Merge);

        let rep = after_cancel(&r.path(), &pre, false);
        assert_eq!(rep.aborted, Some("merge"));
        assert_eq!(r.open().state(), RepositoryState::Clean);
    }

    #[test]
    fn preexisting_merge_state_is_not_aborted() {
        let r = Repo::new("premerge");
        r.with_conflicting_branch();
        assert!(!r.git(&["merge", "other"]));
        let pre = pre_op(&r.open());

        let rep = after_cancel(&r.path(), &pre, false);
        assert_eq!(rep.aborted, None, "the user's own merge is theirs to finish");
        assert_eq!(r.open().state(), RepositoryState::Merge);
    }

    #[test]
    fn locks_removed_before_abort() {
        let r = Repo::new("lockabort");
        r.with_conflicting_branch();
        let pre = pre_op(&r.open());
        assert!(!r.git(&["merge", "other"]));
        // What a hard-killed git can leave: the merge state AND its index.lock,
        // which on its own would make `git merge --abort` fail.
        let index_lock = r.git_dir().join("index.lock");
        std::fs::write(&index_lock, "").unwrap();

        let rep = after_cancel(&r.path(), &pre, false);
        assert_eq!(rep.removed_locks, vec!["index.lock".to_string()]);
        assert_eq!(rep.aborted, Some("merge"));
        assert_eq!(r.open().state(), RepositoryState::Clean);
        assert!(!index_lock.exists());
    }
}
