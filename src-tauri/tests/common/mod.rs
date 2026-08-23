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
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Process-wide monotonic tie-breaker: several tests (or several #[test] fns
/// within one test binary, which cargo runs concurrently on threads) can hit
/// `SystemTime::now()` within the same clock tick, so pid+nanos alone is not
/// always unique — this closes that race deterministically.
static SEQ: AtomicU64 = AtomicU64::new(0);

/// A git config file this test binary owns, pointed at by `GIT_CONFIG_GLOBAL`
/// for the WHOLE PROCESS — so that every `git` run during the test run reads
/// it, including the ones the code under test spawns for itself.
///
/// Repo-local config cannot cover those. `git submodule add` clones the child
/// into an independent repository, and it does so *inside* the call under
/// test, so there is no moment for a test to configure that repo before its
/// working tree is written. On a host with Git for Windows' default
/// `core.autocrlf=true`, nine `tests/submodule.rs` assertions then compared
/// `"hello\n"` against the `"hello\r\n"` git had just legitimately written.
///
/// This also subsumes the `/dev/null` the `git()` helper used to point at: an
/// empty-but-for-our-own-keys file blocks the host's `rerere.autoupdate` and
/// friends exactly as well, and now there is one answer to "which global
/// config does a test see" rather than two.
///
/// Named per-pid rather than uniquely: it is a ~40-byte file, one per test
/// binary, overwritten on pid reuse. Nothing owns it to clean it up, which is
/// a deliberate trade for a fixed-size file — unlike a leaked repo tree, it
/// cannot poison a later run.
fn global_git_config() -> &'static PathBuf {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let path = std::env::temp_dir().join(format!("gitcat-test-gitconfig-{}", std::process::id()));
        std::fs::write(
            &path,
            // autocrlf off so nothing is rewritten on checkout; eol=lf because
            // autocrlf alone leaves `eol` (default: native) to decide the
            // checkout form for paths a .gitattributes marks as `text`.
            "[core]\n\tautocrlf = false\n\teol = lf\n",
        )
        .expect("write the test-run git config");
        // Set for the process, not per-command: the whole point is to reach
        // git invocations this fixture never makes, so there is no command
        // line to put it on.
        //
        // `set_var` in a multi-threaded process is the known-sharp part. It is
        // mitigated rather than eliminated: OnceLock makes it happen exactly
        // once, and every test's first act is building a TempRepo, so the
        // write lands before that thread spawns any git. A thread already
        // mid-spawn when the very first test initializes could in principle
        // miss it — in practice the first TempRepo is constructed before any
        // test has reached the code under test. If this ever does flake, the
        // fix is to hoist it into a `#[ctor]`-style pre-main rather than to
        // paper over it here.
        std::env::set_var("GIT_CONFIG_GLOBAL", &path);
        std::env::set_var("GIT_CONFIG_SYSTEM", &path);
        path
    })
}

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
        global_git_config(); // before the first git of the run — see its doc
        let repo = TempRepo { dir };
        repo.must(&["init", "-q", "-b", "main"]);
        repo.apply_test_config();
        repo
    }

    /// The repo-LOCAL config every throwaway working-tree repo needs, in one
    /// place because there is more than one way a test builds one: `init`
    /// above, and `patch.rs`'s `clone_of`, which used to hand-copy a subset of
    /// this list and drifted out of sync with it.
    ///
    /// Everything here is set LOCALLY on purpose: these are per-repo facts
    /// (this repo's identity, this repo's gc policy), not properties of the
    /// test run. Settings that must hold for EVERY git in the run — including
    /// the ones the code under test spawns, and the ones inside submodule
    /// clones no test ever gets to configure — belong in the run's own global
    /// config instead; see `global_git_config`.
    pub fn apply_test_config(&self) {
        // CRITICAL: without this, a commit hangs forever on a GPG passphrase prompt.
        self.must(&["config", "commit.gpgsign", "false"]);
        // Separate config key from commit.gpgsign — needed once a test creates
        // an annotated tag (`git tag -a`, e.g. tests/plumbing.rs); without this,
        // a host with tag signing defaulted on would hang the ENTIRE shared
        // test binary (this file is `mod common`'d by every tests/*.rs file).
        self.must(&["config", "tag.gpgsign", "false"]);
        // CRITICAL: repo-LOCAL identity, independent of any GIT_AUTHOR_*/GIT_COMMITTER_*
        // env vars (see `git()` below) or the machine's global/system git config. Code
        // under test (e.g. git_pick::cherry_pick_continue) shells out to git directly
        // and sets no identity env vars of its own — in real usage that's fine, because
        // a real user's global config already has one. But on a bare CI runner there is
        // no global config, and git's last-resort GECOS-based fallback can itself resolve
        // to an EMPTY name (observed on a GitHub Actions runner), which git hard-rejects:
        // "Committer identity unknown ... fatal: empty ident name ... not allowed". Local
        // config sits above that fallback and below explicit env vars in git's identity
        // resolution, so this makes every throwaway repo self-sufficient regardless of
        // the host's global config or GECOS data.
        self.must(&["config", "user.name", "GitCat Test"]);
        self.must(&["config", "user.email", "test@gitcat.example"]);
        // Disable background auto-gc/maintenance: a test that creates MANY commits
        // rapidly (dashboard's `stays_cheap_…` runs a 300-commit loop) otherwise
        // intermittently trips `git gc --auto` repacking behind the next commit —
        // observed as a flaky CI failure "error: bad tree object HEAD" mid-loop.
        // No test needs gc, so turn it off outright for every throwaway repo.
        self.must(&["config", "gc.auto", "0"]);
        self.must(&["config", "maintenance.auto", "false"]);
    }

    /// A bare repo (no working tree) — stands in for a real remote in
    /// fetch/pull/push tests: a plain filesystem path is a perfectly valid
    /// git remote URL, no network needed, and bare accepts a push to any
    /// branch without `receive.denyCurrentBranch` getting in the way (there
    /// is no checked-out branch to collide with).
    pub fn init_bare(tag: &str) -> Self {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join(format!("gitcat-test-{tag}-{}-{}-{}", std::process::id(), nanos, seq));
        std::fs::create_dir_all(&dir).expect("mkdir temp bare repo");
        global_git_config();
        let repo = TempRepo { dir };
        repo.must(&["init", "-q", "--bare", "-b", "main"]);
        repo
    }

    /// The repo path as a String (what every Tauri command signature wants).
    pub fn path(&self) -> String {
        self.dir.to_string_lossy().to_string()
    }

    /// Run `git -C <dir> <args…>` with reproducible author/committer identity
    /// and dates, capturing (exit-ok, trimmed stdout, trimmed stderr).
    /// Isolates every invocation from the HOST's own global/system git config
    /// (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`, git >=2.32) — fixes a real
    /// blocking bug: `rerere.autoupdate`, `rerere.enabled`, or any other
    /// setting a developer's or CI runner's own dotfiles happen to set would
    /// otherwise silently leak into every test repo and make assertions
    /// machine-dependent (verified: a personal `~/.config/git/config` with
    /// `rerere.autoupdate=true` made an M5a rerere replay assertion pass
    /// locally while it would fail on a clean runner with no such config).
    /// Local (repo) config, set explicitly via `must` calls below, is
    /// completely unaffected — only the global/system fallback layers are
    /// replaced.
    ///
    /// These used to point at `/dev/null`. They now point at the run's own
    /// config file (see `global_git_config`), which blocks the host's settings
    /// just as well and additionally carries the line-ending keys — so a git
    /// the fixture runs and a git the code under test runs see the SAME global
    /// config, rather than one seeing none and the other seeing the host's.
    /// Setting them here as well as process-wide is redundant by design: it
    /// keeps the guarantee visible at the call site, where the comment above
    /// explains why it matters.
    pub fn git(&self, args: &[&str]) -> (bool, String, String) {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", global_git_config())
            .env("GIT_CONFIG_SYSTEM", global_git_config())
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
