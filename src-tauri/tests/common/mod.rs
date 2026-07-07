//! Shared test boilerplate for the integration suite: a throwaway temp-repo
//! builder + a `git` CLI wrapper, mirroring the pattern already used by the
//! manual harnesses in `examples/` (graphcheck.rs / m2check.rs / pickcheck.rs /
//! bisectcheck.rs / safetycheck.rs).
//!
//! CRITICAL SAFETY: every repo built here lives under `std::env::temp_dir()`
//! with a name unique per process+time, and `commit.gpgsign` is forced off
//! immediately after `git init` — without that a commit would hang forever on
//! a GPG passphrase prompt (and hang the whole test run / CI). NEVER point
//! this at a real repo. Cleanup is best-effort (`Drop` -> `remove_dir_all`,
//! errors ignored) so a failed assertion still cleans up the temp dir.
//!
//! `tests/common/mod.rs` is a normal module (NOT its own test binary) because
//! it lives one directory below `tests/` — that's the Cargo convention that
//! lets every `tests/*.rs` file `mod common;` it without Cargo trying to run
//! `common.rs` itself as a suite.

#![allow(dead_code)] // not every test file exercises every helper

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Process-wide monotonic tie-breaker: several tests (or several #[test] fns
/// within one test binary, which cargo runs concurrently on threads) can hit
/// `SystemTime::now()` within the same clock tick, so pid+nanos alone is not
/// always unique — this closes that race deterministically.
static SEQ: AtomicU64 = AtomicU64::new(0);

/// A disposable git repository under the OS temp dir. Auto-removed on `Drop`.
pub struct TempRepo {
    pub dir: PathBuf,
}

impl TempRepo {
    /// `git init -q -b main` a fresh, uniquely-named temp dir and disable
    /// GPG signing. `tag` is just a human-readable label folded into the dir
    /// name (e.g. the test/scenario name) to make stray leftovers legible.
    pub fn init(tag: &str) -> Self {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join(format!("gitcat-test-{tag}-{}-{}-{}", std::process::id(), nanos, seq));
        std::fs::create_dir_all(&dir).expect("mkdir temp repo");
        let repo = TempRepo { dir };
        repo.must(&["init", "-q", "-b", "main"]);
        // CRITICAL: without this, a commit hangs forever on a GPG passphrase prompt.
        repo.must(&["config", "commit.gpgsign", "false"]);
        repo
    }

    /// The repo path as a String (what every Tauri command signature wants).
    pub fn path(&self) -> String {
        self.dir.to_string_lossy().to_string()
    }

    /// Run `git -C <dir> <args…>` with reproducible author/committer identity
    /// and dates, capturing (exit-ok, trimmed stdout, trimmed stderr).
    pub fn git(&self, args: &[&str]) -> (bool, String, String) {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "GitCat Test")
            .env("GIT_AUTHOR_EMAIL", "test@gitcat.example")
            .env("GIT_COMMITTER_NAME", "GitCat Test")
            .env("GIT_COMMITTER_EMAIL", "test@gitcat.example")
            .env("GIT_AUTHOR_DATE", "2026-01-01T00:00:00Z")
            .env("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z")
            .output()
            .expect("failed to spawn git");
        (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        )
    }

    /// Like `git`, but asserts success and returns stdout.
    pub fn must(&self, args: &[&str]) -> String {
        let (ok, so, se) = self.git(args);
        assert!(ok, "git {args:?} failed: {se}{so}");
        so
    }

    /// Write `file` with `content`, stage everything, commit with `msg`
    /// (`--no-verify` so a stray local hook can't block the test); returns the
    /// new commit's full sha.
    pub fn commit(&self, file: &str, content: &str, msg: &str) -> String {
        std::fs::write(self.dir.join(file), content).expect("write file");
        self.must(&["add", "-A"]);
        self.must(&["commit", "-q", "--no-verify", "-m", msg]);
        self.must(&["rev-parse", "HEAD"])
    }

    /// Full sha a ref/revision resolves to, or `None` if it doesn't resolve.
    pub fn rev(&self, r: &str) -> Option<String> {
        let (ok, so, _) = self.git(&["rev-parse", "--verify", "-q", r]);
        if ok && !so.is_empty() {
            Some(so)
        } else {
            None
        }
    }

    /// True if the object `sha` still exists in the object database.
    pub fn obj_exists(&self, sha: &str) -> bool {
        self.git(&["cat-file", "-e", sha]).0
    }

    /// True if the working tree has no uncommitted changes.
    pub fn is_clean(&self) -> bool {
        self.must(&["status", "--porcelain"]).is_empty()
    }

    /// Current branch shorthand (e.g. "main"), or "" when HEAD is detached.
    pub fn current_branch(&self) -> String {
        let (ok, so, _) = self.git(&["symbolic-ref", "--short", "-q", "HEAD"]);
        if ok {
            so
        } else {
            String::new()
        }
    }

    /// Content of `file` in the working tree.
    pub fn read(&self, file: &str) -> String {
        std::fs::read_to_string(self.dir.join(file)).expect("read file")
    }

    /// Open a git2 handle onto this temp repo (for read-only inspection in
    /// tests, e.g. asserting `RepositoryState` or walking ancestry).
    pub fn open(&self) -> git2::Repository {
        git2::Repository::open(&self.dir).expect("open temp repo")
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Shorten a full sha to 7 chars — matches GitCat's short-sha convention
/// (`CommitMeta.sha`, `Snapshot.sha`, `CommitInfo.sha`, …).
pub fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}
