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
//! aborted only for an op that can create one (pull; never fetch or push,
//! where such a state can only be someone else's) and only if the repo was
//! clean before the op. The caller also skips both steps entirely while
//! another registered job is live on the same repo
//! (`JobRegistry::others_on_repo`), since the lock or state may be its.
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
    locks: Locks,
    state: RepositoryState,
    started: SystemTime,
}

/// The lock files one scan found: the fixed-name ones, and those from the
/// bounded `refs/` walk, kept apart so a truncated walk can be accounted for.
#[derive(Default)]
struct Locks {
    fixed: HashSet<PathBuf>,
    refs: HashSet<PathBuf>,
    /// The `refs/` walk stopped early. Which entries it reached depends on
    /// `read_dir` order and on what the op itself added or pruned, so a later
    /// walk may reach a pre-existing lock this one never saw.
    refs_truncated: bool,
}

#[derive(Debug, Default)]
pub struct CleanupReport {
    /// Removed lock files, relative to the git dir, `/`-separated.
    pub removed_locks: Vec<String>,
    /// The op that was `--abort`ed: "merge" | "rebase" | "am" | "cherry-pick" | "revert".
    pub aborted: Option<&'static str>,
    /// A half-applied merge/cherry-pick/revert (no MERGE_HEAD etc. to abort)
    /// was put back with `git reset --merge HEAD` (see `Cancellable::arm_tree_op`).
    pub reset_tree: bool,
}

/// Every lock file git may hold that we know how to look for. In the
/// (per-worktree) git dir: index/HEAD/ORIG_HEAD/config/FETCH_HEAD. In the
/// common dir: packed-refs, shallow, config, and every `*.lock` under `refs/`
/// (a bounded walk).
fn scan_locks(git_dir: &Path, common_dir: &Path, max_refs_entries: usize) -> Locks {
    let mut found = Locks::default();
    for name in ["index.lock", "HEAD.lock", "ORIG_HEAD.lock", "config.lock", "FETCH_HEAD.lock"] {
        let p = git_dir.join(name);
        if p.is_file() {
            found.fixed.insert(p);
        }
    }
    for name in ["packed-refs.lock", "shallow.lock", "config.lock"] {
        let p = common_dir.join(name);
        if p.is_file() {
            found.fixed.insert(p);
        }
    }
    let mut budget = max_refs_entries;
    let mut complete = walk_ref_locks(&common_dir.join("refs"), 0, &mut budget, &mut found.refs);
    if git_dir != common_dir {
        // A linked worktree's own refs (refs/bisect, refs/worktree, …).
        complete &= walk_ref_locks(&git_dir.join("refs"), 0, &mut budget, &mut found.refs);
    }
    found.refs_truncated = !complete;
    found
}

/// False when the walk stopped early (out of budget, or too deep), i.e. part
/// of `dir` was never looked at.
fn walk_ref_locks(dir: &Path, depth: usize, budget: &mut usize, found: &mut HashSet<PathBuf>) -> bool {
    if depth > MAX_REFS_DEPTH {
        return false;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return true };
    let mut complete = true;
    for entry in rd.flatten() {
        if *budget == 0 {
            return false;
        }
        *budget -= 1;
        let Ok(ft) = entry.file_type() else { continue };
        let p = entry.path();
        if ft.is_dir() {
            complete &= walk_ref_locks(&p, depth + 1, budget, found);
        } else if ft.is_file() && p.extension().is_some_and(|e| e == "lock") {
            found.insert(p);
        }
    }
    complete
}

/// A local history op (commit, merge, cherry-pick, revert, rebase, am, the
/// merge tool) made cancellable through the current job (`jobs::current`).
/// `arm` right before git runs — after the op's own safety snapshot, whose
/// ref write must not count as the op's — and, if git came back cancelled,
/// `finish` cleans up and builds the message. Outside a job it is inert: no
/// token, no pre-op scan, nothing to clean.
pub struct Cancellable {
    job: Option<crate::jobs::CurrentJob>,
    pre: Option<PreOp>,
    /// `arm_tree_op` only: HEAD, and whether the index matched it.
    tree_mark: Option<(git2::Oid, bool)>,
}

impl Cancellable {
    pub fn arm(path: &str) -> Self {
        let job = crate::jobs::current();
        let pre = job.as_ref().and_then(|_| crate::trust::open_repo(path).ok()).map(|r| pre_op(&r));
        Self { job, pre, tree_mark: None }
    }

    /// [`arm`](Self::arm) for `merge`/`cherry-pick`/`revert`, which also
    /// records HEAD and whether the index matched it. These write their result
    /// to the index and working tree before the commit, but MERGE_HEAD (and
    /// CHERRY_PICK_HEAD, REVERT_HEAD) only when they stop on a conflict — so
    /// one killed in between (e.g. while the pre-merge-commit hook runs) looks
    /// like a clean repo with the other side's changes staged, and `--abort`
    /// finds nothing. `finish` puts that back with `git reset --merge HEAD`,
    /// which keeps unrelated local changes, like `--abort` does.
    pub fn arm_tree_op(path: &str) -> Self {
        let mut c = Self::arm(path);
        if c.job.is_some() {
            c.tree_mark = crate::trust::open_repo(path).ok().and_then(|r| {
                let head = r.head().ok()?.peel_to_commit().ok()?;
                let clean = index_matches(&r, &head)?;
                Some((head.id(), clean))
            });
        }
        c
    }

    pub fn token(&self) -> Option<crate::procutil::CancelToken> {
        self.job.as_ref().map(crate::jobs::CurrentJob::token)
    }

    /// After a cancel: remove the lock files the killed git created and, when
    /// `abort` and the op left a merge/rebase/am/cherry-pick/revert in a repo
    /// that was clean before, run its `--abort` (a `--continue` started
    /// mid-op, so it never aborts the user's own operation). Skipped while
    /// another job is live on the repo. The message: `op_key`'s sentence,
    /// then what was cleaned up, then how to undo when there is a snapshot
    /// (`snapshot` is the backup ref; it is shown without its namespace).
    pub fn finish(&self, path: &str, op_key: &str, abort: bool, snapshot: Option<&str>) -> String {
        let skip = self.job.as_ref().is_some_and(crate::jobs::CurrentJob::others_on_repo);
        let mut report = match &self.pre {
            Some(pre) => after_cancel(path, pre, skip, abort),
            None => CleanupReport::default(),
        };
        if abort && !skip && report.aborted.is_none() && self.reset_half_applied(path) {
            report.reset_tree = true;
        }
        cancelled_message(op_key, &report, snapshot.map(|r| r.trim_start_matches("refs/gitgui/backup/")))
    }

    /// See [`arm_tree_op`](Self::arm_tree_op): only when HEAD hasn't moved, the
    /// repo is not mid-op, the index matched HEAD before and doesn't now.
    fn reset_half_applied(&self, path: &str) -> bool {
        let Some((head_before, was_clean)) = self.tree_mark else { return false };
        if !was_clean {
            return false;
        }
        let Ok(repo) = crate::trust::open_repo(path) else { return false };
        let Some(head) = repo.head().ok().and_then(|h| h.peel_to_commit().ok()) else { return false };
        if head.id() != head_before || repo.state() != RepositoryState::Clean || index_matches(&repo, &head) != Some(false) {
            return false;
        }
        crate::safety::run_git_worktree(path, &["reset", "--merge", "HEAD"]).is_ok_and(|o| o.ok)
    }
}

/// Whether the index holds exactly `head`'s tree.
fn index_matches(repo: &git2::Repository, head: &git2::Commit<'_>) -> Option<bool> {
    let tree = head.tree().ok()?;
    let diff = repo.diff_tree_to_index(Some(&tree), None, None).ok()?;
    Some(diff.deltas().len() == 0)
}

/// `op_key`'s "X cancelled." plus the optional sentences, joined for `be()`.
pub fn cancelled_message(op_key: &str, report: &CleanupReport, snapshot: Option<&str>) -> String {
    use crate::i18n_err::{ierr, ierrp, ijoin};
    let mut parts = vec![ierr(op_key)];
    if !report.removed_locks.is_empty() {
        parts.push(ierrp("err_history.cancel_removed_locks", &[("locks", &report.removed_locks.join(", "))]));
    }
    if let Some(op) = report.aborted {
        parts.push(ierrp("err_history.cancel_aborted", &[("op", op)]));
    }
    if report.reset_tree {
        parts.push(ierr("err_history.cancel_reset_tree"));
    }
    if let Some(snapshot) = snapshot {
        parts.push(ierrp("err_history.cancel_undo", &[("snapshot", snapshot)]));
    }
    ijoin(&parts)
}

pub fn pre_op(repo: &git2::Repository) -> PreOp {
    pre_op_bounded(repo, MAX_REFS_ENTRIES)
}

fn pre_op_bounded(repo: &git2::Repository, max_refs_entries: usize) -> PreOp {
    PreOp {
        locks: scan_locks(repo.path(), repo.commondir(), max_refs_entries),
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
/// `skip` is set while another registered job is live on the same repo: the
/// leftovers may then be ITS, so neither step runs.
///
/// 1. Remove lock files that are new since `pre_op` AND whose mtime is no
///    older than `started - MTIME_SLACK`. Never a pre-existing one. If
///    `pre_op`'s `refs/` walk was truncated, `refs/**.lock` is left alone:
///    there "new" can't be told from "beyond the first walk's cutoff".
/// 2. Then, only if `abort` (the op can itself leave such a state: pull, not
///    fetch or push), the repo was clean before and is now mid-merge/rebase/
///    am/cherry-pick/revert, run the matching `git <op> --abort`.
///
/// Locks go first because `--abort` itself needs `index.lock`.
pub fn after_cancel(path: &str, pre: &PreOp, skip: bool, abort: bool) -> CleanupReport {
    let mut report = CleanupReport::default();
    if skip {
        return report;
    }
    let Ok(repo) = crate::trust::open_repo(path) else { return report };
    let git_dir = repo.path().to_path_buf();
    let common_dir = repo.commondir().to_path_buf();

    {
        let floor = pre.started.checked_sub(MTIME_SLACK).unwrap_or(pre.started);
        let scan = scan_locks(&git_dir, &common_dir, MAX_REFS_ENTRIES);
        let refs = if pre.locks.refs_truncated { HashSet::new() } else { scan.refs };
        let mut now: Vec<PathBuf> = scan
            .fixed
            .into_iter()
            .filter(|p| !pre.locks.fixed.contains(p))
            .chain(refs.into_iter().filter(|p| !pre.locks.refs.contains(p)))
            .collect();
        now.sort();
        for p in now {
            let fresh = std::fs::metadata(&p).and_then(|m| m.modified()).map(|t| t >= floor).unwrap_or(false);
            if fresh && std::fs::remove_file(&p).is_ok() {
                report.removed_locks.push(rel_to_git_dir(&p, &git_dir, &common_dir));
            }
        }
    }

    if abort && pre.state == RepositoryState::Clean {
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

        let rep = after_cancel(&r.path(), &pre, false, true);
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

        let rep = after_cancel(&r.path(), &pre, true, true);
        assert!(index_lock.exists());
        assert!(rep.removed_locks.is_empty());
    }

    #[test]
    fn skip_also_skips_the_abort() {
        let r = Repo::new("skipabort");
        r.with_conflicting_branch();
        let pre = pre_op(&r.open());
        assert!(!r.git(&["merge", "other"]));

        let rep = after_cancel(&r.path(), &pre, true, true);
        assert_eq!(rep.aborted, None, "another live job on the repo may own this merge");
        assert_eq!(r.open().state(), RepositoryState::Merge);
    }

    #[test]
    fn merge_state_is_left_alone_without_abort() {
        // A fetch/push never creates a merge; one that appears while it runs
        // is the user's (a terminal `git merge`), so cancelling must keep it.
        let r = Repo::new("noabort");
        r.with_conflicting_branch();
        let pre = pre_op(&r.open());
        assert!(!r.git(&["merge", "other"]));
        assert_eq!(r.open().state(), RepositoryState::Merge);

        let rep = after_cancel(&r.path(), &pre, false, false);
        assert_eq!(rep.aborted, None);
        assert_eq!(r.open().state(), RepositoryState::Merge);
    }

    #[test]
    fn truncated_refs_walk_keeps_ref_locks_but_cleans_fixed_ones() {
        let r = Repo::new("truncated");
        r.commit("f.txt", "0\n", "c0");
        // A budget of 1 can't cover refs/ (heads, tags, …), so the walk is
        // truncated and a refs/**.lock can no longer be judged new.
        let pre = pre_op_bounded(&r.open(), 1);
        assert!(pre.locks.refs_truncated);

        let index_lock = r.git_dir().join("index.lock");
        let ref_lock = r.git_dir().join("refs/heads/beyond-cutoff.lock");
        std::fs::write(&index_lock, "").unwrap();
        std::fs::write(&ref_lock, "").unwrap();

        let rep = after_cancel(&r.path(), &pre, false, false);
        assert_eq!(rep.removed_locks, vec!["index.lock".to_string()]);
        assert!(!index_lock.exists());
        assert!(ref_lock.exists(), "a refs/ lock the first walk may never have reached is not ours to remove");
    }

    #[test]
    fn merge_in_progress_created_by_op_is_aborted() {
        let r = Repo::new("merge");
        r.with_conflicting_branch();
        let pre = pre_op(&r.open());
        assert!(!r.git(&["merge", "other"]), "the fixture must conflict");
        assert_eq!(r.open().state(), RepositoryState::Merge);

        let rep = after_cancel(&r.path(), &pre, false, true);
        assert_eq!(rep.aborted, Some("merge"));
        assert_eq!(r.open().state(), RepositoryState::Clean);
    }

    #[test]
    fn preexisting_merge_state_is_not_aborted() {
        let r = Repo::new("premerge");
        r.with_conflicting_branch();
        assert!(!r.git(&["merge", "other"]));
        let pre = pre_op(&r.open());

        let rep = after_cancel(&r.path(), &pre, false, true);
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

        let rep = after_cancel(&r.path(), &pre, false, true);
        assert_eq!(rep.removed_locks, vec!["index.lock".to_string()]);
        assert_eq!(rep.aborted, Some("merge"));
        assert_eq!(r.open().state(), RepositoryState::Clean);
        assert!(!index_lock.exists());
    }
}
