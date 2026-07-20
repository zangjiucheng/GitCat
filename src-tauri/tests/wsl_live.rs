//! Manual, opt-in end-to-end verification against a REAL WSL install.
//!
//! `tests/trust.rs`'s own doc comment explains why this can't be a normal
//! (always-on) test: there's no portable, CI-safe way to fabricate a real
//! WSL environment, so every test in this file is `#[ignore]`'d. Run them
//! explicitly, on a box that actually has WSL, with:
//!
//! ```text
//! cargo test --test wsl_live -- --ignored --test-threads=1
//! ```
//!
//! `--test-threads=1` matters: fixtures share one WSL distro's filesystem
//! under `/tmp`, and the routing test's whole POINT is a bare-Linux-path
//! remote no Windows `git.exe` could ever resolve — concurrent runs racing
//! the same distro would just make failures noisier, not different.
//!
//! Each test skips itself cleanly (prints why, returns before touching
//! anything) when this machine has no WSL install / no registered distro at
//! all, rather than failing — this suite verifies GitCat's OWN code, not
//! that the dev box happens to have WSL set up.
//!
//! What's covered, and why each one is here (see `src/wsl.rs`'s own module
//! doc comment for the full bug writeup):
//! - `trust_open_repo_auto_trusts_a_fresh_wsl_repo` — upgrades trust.rs's own
//!   documented gap ("manual end-to-end verification against a real WSL
//!   repo") into a real, runnable-on-demand test: a fresh WSL repo trips
//!   libgit2's "dubious ownership" refusal, `trust::open_repo` auto-trusts
//!   and retries, and a SECOND open on the now-trusted repo is a no-op
//!   passthrough.
//! - `git_remote_fetch_and_push_route_through_the_wsl_distros_own_git` — the
//!   DECISIVE routing test: the "remote" is a bare repo's own Linux path
//!   (e.g. `/tmp/gitcat-wsl-...bare`), which Windows' own `git.exe` could
//!   never resolve as a remote URL at all. `fetch`/`push` only succeed if
//!   `git_remote.rs` genuinely routed through `wsl.exe -e git`, not plain
//!   `git.exe` against the UNC mount.
//! - `push_branch_with_shell_metacharacters_is_not_reinterpreted_by_wsl_exe`
//!   — injection-safety regression: a branch literally named
//!   `safe$(whoami)-branch` must land on the remote with that exact literal
//!   name. `wsl.rs`'s own doc comment explains why `-e`/`--exec` (not the
//!   bare `--` separator) is load-bearing for this.
//! - `code_search_resolves_a_ref_not_just_a_sha_on_a_wsl_repo` — `at_commit`
//!   accepting `"main"` (not just a sha prefix) works the same over a WSL
//!   repo as it does locally (see `code_search.rs`'s own doc comment for the
//!   `revparse_single` fix this covers).
//! - `workdir_status_and_dashboard_status_stay_fast_on_a_repo_with_a_symlink`
//!   — regression test for the WORST bug this app has shipped with: a
//!   working tree containing even one Linux symlink made `workdir_status`/
//!   `dashboard_repo_status` (both built on `git2::Repository::statuses()`)
//!   stall for 185+ SECONDS, EVERY call, reached over the
//!   `\\wsl.localhost\` bridge — empirically measured against a real
//!   ~1000-commit repo (a fresh CPython clone) with 4 symlinks. See
//!   `src/wsl.rs`'s own `wsl_status` doc comment for the full writeup and
//!   the `git status --porcelain=v2` route around it.

use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use gitcat_lib::{code_search, dashboard, git_remote, trust, workdir};

/// The first registered WSL distro's name, or `None` if WSL isn't installed
/// / no distro is registered at all. `wsl.exe -l -q` (quiet: names only, one
/// per line) — EMPIRICALLY CONFIRMED its stdout is UTF-16LE even when piped
/// (not a real console): decoding it as UTF-8 (lossy or otherwise)
/// interleaves a NUL byte after every character instead of the real text, so
/// this decodes as UTF-16LE explicitly rather than
/// `String::from_utf8_lossy`. WSL always lists the default distro first —
/// EMPIRICALLY CONFIRMED against this dev box's own `wsl -l -v` (`*`-marked
/// default matches the first `-l -q` line) — so the first line is used
/// as-is rather than re-parsing `-l -v`'s fixed-width, also-UTF-16LE table.
fn first_wsl_distro() -> Option<String> {
    let out = Command::new("wsl.exe").arg("-l").arg("-q").output().ok()?;
    if !out.status.success() || out.stdout.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = out.stdout.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    let text = String::from_utf16_lossy(&units);
    let name = text.lines().next()?.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Prints why, for a test that's about to skip itself.
macro_rules! skip_without_wsl {
    () => {
        match first_wsl_distro() {
            Some(d) => d,
            None => {
                eprintln!("SKIPPED — no WSL install / no registered distro found on this machine");
                return;
            }
        }
    };
}

static SEQ: AtomicU64 = AtomicU64::new(0);

/// A disposable git repository living INSIDE a WSL distro's own filesystem
/// (under `/tmp`), reached from Windows/Rust via its `\\wsl.localhost\...`
/// UNC path. Auto-removed (best-effort, WSL-side `rm -rf`) on `Drop` — same
/// "cleanup errors are ignored so a failed assertion still cleans up"
/// convention as `tests/common::TempRepo`.
struct WslTempRepo {
    distro: String,
    linux_path: String,
}

impl WslTempRepo {
    /// Runs `wsl.exe -d <distro> -e bash -c "<script>"` for FIXTURE SETUP
    /// only — going through a real, well-understood `bash -c` on purpose
    /// (the script string is a hardcoded template here, never user input),
    /// deliberately different from `-e git ...`'s direct-exec-no-shell
    /// invocation, which is what the actual code under test
    /// (`src/wsl.rs::git_command`) uses and what
    /// `push_branch_with_shell_metacharacters_is_not_reinterpreted_by_wsl_exe`
    /// below specifically checks.
    fn wsl_setup(distro: &str, script: &str) {
        let out = Command::new("wsl.exe")
            .arg("-d")
            .arg(distro)
            .arg("-e")
            .arg("bash")
            .arg("-c")
            .arg(script)
            .output()
            .expect("failed to spawn wsl.exe for fixture setup");
        assert!(out.status.success(), "WSL fixture setup failed: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn unique_linux_path(tag: &str) -> String {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::SeqCst);
        format!("/tmp/gitcat-wsl-test-{tag}-{}-{}-{}", std::process::id(), nanos, seq)
    }

    /// A normal (non-bare) repo with one commit (`f.txt` containing `hello`
    /// — matches `code_search`'s own fixture convention elsewhere).
    fn init(distro: &str, tag: &str) -> Self {
        let linux_path = Self::unique_linux_path(tag);
        Self::wsl_setup(
            distro,
            &format!(
                "set -e; mkdir -p '{p}'; cd '{p}'; git init -q -b main; \
                 git config commit.gpgsign false; git config user.email test@gitcat.example; \
                 git config user.name 'GitCat Test'; echo hello > f.txt; git add f.txt; \
                 git commit -q -m c0",
                p = linux_path
            ),
        );
        WslTempRepo { distro: distro.to_string(), linux_path }
    }

    /// A bare repo — stands in for a real remote, same rationale as
    /// `TempRepo::init_bare`: a plain path is a valid git remote URL, no
    /// network needed. Reached via its OWN Linux path (not translated to a
    /// Windows UNC form) — see `git_remote_fetch_and_push_route_through_...`
    /// below for why that's the decisive part of that test.
    fn init_bare(distro: &str, tag: &str) -> Self {
        let linux_path = Self::unique_linux_path(tag);
        Self::wsl_setup(distro, &format!("set -e; git init -q --bare -b main '{linux_path}'"));
        WslTempRepo { distro: distro.to_string(), linux_path }
    }

    /// The Windows-native UNC path (backslash form — what a real Explorer
    /// file-picker hands the app) `gitcat_lib`'s Tauri commands expect.
    fn unc_path(&self) -> String {
        format!(r"\\wsl.localhost\{}\{}", self.distro, self.linux_path.trim_start_matches('/').replace('/', "\\"))
    }

    /// `wsl.exe -d <distro> -e git -C <linux_path> <args>` — direct exec, no
    /// shell, for ASSERTIONS about WSL-side state after an operation. This
    /// is the exact same invocation shape `src/wsl.rs::git_command` uses for
    /// the real code path, not a shortcut.
    fn wsl_git(&self, args: &[&str]) -> (bool, String, String) {
        let out = Command::new("wsl.exe")
            .arg("-d")
            .arg(&self.distro)
            .arg("-e")
            .arg("git")
            .arg("-C")
            .arg(&self.linux_path)
            .args(args)
            .output()
            .expect("failed to spawn wsl.exe");
        (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        )
    }
}

impl Drop for WslTempRepo {
    fn drop(&mut self) {
        let _ = Command::new("wsl.exe")
            .arg("-d")
            .arg(&self.distro)
            .arg("-e")
            .arg("rm")
            .arg("-rf")
            .arg(&self.linux_path)
            .output();
    }
}

/// Best-effort: remove BOTH `safe.directory` forms `trust::open_repo`'s
/// auto-trust retry writes (see its own doc comment) for `path`, so a run of
/// this suite doesn't leave the dev box's global git config accumulating
/// throwaway entries. Never asserted on — a leftover `safe.directory` entry
/// for an already-deleted path is inert, just untidy.
fn untrust(path: &str) {
    let forward = path.replace('\\', "/");
    let prefixed = format!("%(prefix)/{forward}");
    let _ = Command::new("git").args(["config", "--global", "--unset-all", "safe.directory", &forward]).output();
    let _ = Command::new("git").args(["config", "--global", "--unset-all", "safe.directory", &prefixed]).output();
}

#[test]
#[ignore]
fn trust_open_repo_auto_trusts_a_fresh_wsl_repo() {
    let distro = skip_without_wsl!();
    let repo = WslTempRepo::init(&distro, "trust");
    let path = repo.unc_path();

    let e = match git2::Repository::open(&path) {
        Err(e) => e,
        Ok(_) => panic!("a FRESH wsl repo should trip libgit2's dubious-ownership refusal before any trust step"),
    };
    assert_eq!(e.class(), git2::ErrorClass::Config);
    assert_eq!(e.code(), git2::ErrorCode::Owner);

    let opened = trust::open_repo(&path);
    assert!(opened.is_ok(), "trust::open_repo must auto-trust and retry: {:?}", opened.err().map(|e| e.message().to_string()));

    // A second call is a passthrough — no error, nothing left to retry.
    assert!(trust::open_repo(&path).is_ok(), "a second open on an already-trusted wsl repo must also succeed");

    untrust(&path);
}

#[test]
#[ignore]
fn git_remote_fetch_and_push_route_through_the_wsl_distros_own_git() {
    let distro = skip_without_wsl!();
    let repo = WslTempRepo::init(&distro, "remote-work");
    let bare = WslTempRepo::init_bare(&distro, "remote-bare");
    let path = repo.unc_path();

    // The decisive part: `bare.linux_path` (e.g. "/tmp/gitcat-wsl-...") is a
    // remote URL Windows' own git.exe could never resolve — there is no such
    // path from Windows' point of view. `fetch`/`push` below can only
    // succeed if git_remote.rs genuinely routed through `wsl.exe -e git`.
    let (ok, _, err) = repo.wsl_git(&["remote", "add", "origin", &bare.linux_path]);
    assert!(ok, "fixture setup (remote add) failed: {err}");

    let fetch_result = git_remote::fetch(path.clone(), Some("origin".to_string()));
    assert!(fetch_result.ok, "fetch should route through wsl and succeed: {}", fetch_result.message);

    let push_result = git_remote::push(path.clone());
    assert!(push_result.ok, "push should route through wsl and succeed: {}", push_result.message);

    // Prove it actually landed on the "remote" (not a silent success).
    let (ok, out, err) = bare.wsl_git(&["log", "--oneline", "-1"]);
    assert!(ok, "reading bare repo's log failed: {err}");
    assert!(out.contains("c0"), "pushed commit should be visible in the bare repo, got: {out:?}");

    untrust(&path);
}

#[test]
#[ignore]
fn push_branch_with_shell_metacharacters_is_not_reinterpreted_by_wsl_exe() {
    let distro = skip_without_wsl!();
    let repo = WslTempRepo::init(&distro, "inject-work");
    let bare = WslTempRepo::init_bare(&distro, "inject-bare");
    let path = repo.unc_path();

    let (ok, _, err) = repo.wsl_git(&["remote", "add", "origin", &bare.linux_path]);
    assert!(ok, "fixture setup (remote add) failed: {err}");

    let branch = "safe$(whoami)-branch";
    let (ok, _, err) = repo.wsl_git(&["branch", branch]);
    assert!(ok, "fixture setup (branch create) failed: {err}");

    let result = git_remote::push_branch(path.clone(), branch.to_string(), None, None);
    assert!(result.ok, "push_branch should succeed: {}", result.message);

    let (ok, out, err) = bare.wsl_git(&["branch", "-a"]);
    assert!(ok, "reading bare repo's branches failed: {err}");
    assert!(
        out.contains("safe$(whoami)-branch"),
        "the branch must land with its EXACT literal name — if `-e`/`--exec` had NOT \
         avoided WSL's shell reinterpretation, `$(whoami)` would have been expanded \
         and this substring wouldn't appear at all. Got: {out:?}"
    );

    untrust(&path);
}

#[test]
#[ignore]
fn code_search_resolves_a_ref_not_just_a_sha_on_a_wsl_repo() {
    let distro = skip_without_wsl!();
    let repo = WslTempRepo::init(&distro, "search");
    let path = repo.unc_path();

    for rev in ["HEAD", "main", "HEAD~0"] {
        let result = code_search::code_search(path.clone(), "hello".to_string(), false, Some(rev.to_string()));
        match result {
            Ok(res) => {
                assert_eq!(res.matches.len(), 1, "expected exactly 1 match searching at {rev:?}, got {} matches", res.matches.len())
            }
            Err(e) => panic!("code_search at {rev:?} should resolve on a wsl repo, got error: {e}"),
        }
    }

    let bad = code_search::code_search(path.clone(), "hello".to_string(), false, Some("not-a-real-ref".to_string()));
    assert!(bad.is_err(), "a genuinely invalid ref must still error cleanly, not panic or silently succeed");

    untrust(&path);
}

#[test]
#[ignore]
fn workdir_status_and_dashboard_status_stay_fast_on_a_repo_with_a_symlink() {
    let distro = skip_without_wsl!();
    let repo = WslTempRepo::init(&distro, "symlink");
    let path = repo.unc_path();

    // The one thing this test exists to add: a real Linux symlink, committed
    // (not just working-tree-only) so BOTH the head-to-index and
    // index-to-workdir sides of a status scan have to walk past it — exactly
    // what made the original git2-based scan stall for 185+ seconds.
    WslTempRepo::wsl_setup(
        &distro,
        &format!(
            "set -e; cd '{p}'; ln -s f.txt link.txt; git add link.txt; git commit -q -m 'add a symlink'",
            p = repo.linux_path
        ),
    );

    // Generous relative to the sub-2-second times actually measured (see
    // src/wsl.rs's wsl_status doc comment) but still two orders of magnitude
    // under the 185-second bug this guards against -- a real hang/stall
    // trips this long before anyone's patience does.
    const MAX: std::time::Duration = std::time::Duration::from_secs(30);

    // Both commands are `async fn` (run off the main thread via
    // crate::blocking::run_blocking — see their own doc comments for the
    // separate main-thread-freeze bug that fixed) — block_on here is this
    // codebase's own established way to drive one synchronously from a
    // plain #[test] fn, same as e.g. tests/branch_ops.rs's own calls.
    let t0 = std::time::Instant::now();
    let status = tauri::async_runtime::block_on(workdir::workdir_status(path.clone()))
        .expect("workdir_status must succeed on a repo containing a symlink, not hang or error");
    assert!(t0.elapsed() < MAX, "workdir_status took {:?} (>= {MAX:?}) on a repo with one symlink -- the bug this test guards against", t0.elapsed());
    assert!(status.staged.is_empty(), "freshly committed, working tree should be clean: {} staged entries", status.staged.len());
    assert!(status.unstaged.is_empty(), "freshly committed, working tree should be clean: {} unstaged entries", status.unstaged.len());
    assert_eq!(status.conflicted, 0);

    let t1 = std::time::Instant::now();
    let dash = tauri::async_runtime::block_on(dashboard::dashboard_repo_status(path.clone()))
        .expect("dashboard_repo_status must succeed on a repo containing a symlink, not hang or error");
    assert!(t1.elapsed() < MAX, "dashboard_repo_status took {:?} (>= {MAX:?}) on a repo with one symlink -- the bug this test guards against", t1.elapsed());
    assert!(!dash.dirty, "freshly committed, working tree should be clean");
    assert_eq!(dash.conflicted, 0);

    untrust(&path);
}
