//! Automated performance-regression guard, run on every PR/push (see
//! `.github/workflows/ci.yml`'s own "Performance regression tests" step) —
//! NOT `#[ignore]`'d, unlike `tests/wsl_live.rs`.
//!
//! Why this exists: a WSL-specific version of this exact bug class
//! (`git2::Repository::statuses()` stalling 185+ SECONDS, on every call, on
//! a repo containing a Linux symlink reached over the `\\wsl.localhost\`
//! bridge — see `src/wsl.rs`'s own doc comment for the full story) shipped
//! and went unnoticed until a large real-world repo (a CPython clone)
//! surfaced it in manual testing. That specific bug needs a real WSL
//! install to reproduce (`tests/wsl_live.rs`, opt-in/manual only, never runs
//! in CI), but the UNDERLYING risk it's an instance of — an accidentally
//! reintroduced O(n²) (or worse) cost, or a new blocking/synchronous call,
//! in one of these hot per-repo-open read paths — is NOT WSL-specific, and
//! CAN be caught on every PR against a large-but-synthetic LOCAL repo, no
//! WSL needed. This is that guard: not a replacement for `wsl_live.rs`'s
//! own WSL-specific coverage, a DIFFERENT, CI-reliable layer underneath it.
//!
//! Thresholds are deliberately generous — see each assertion's own comment
//! for the real number it's compared against — chosen to survive CI runner
//! speed variance without flaking, while still catching a genuine
//! regression (an order of magnitude slower, the shape every regression in
//! this class has actually taken so far), not chasing tight perf numbers.

mod common;

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use common::TempRepo;
use gitcat_lib::{dashboard, git_read, workdir};

const COMMIT_COUNT: usize = 5000;

/// Builds `COMMIT_COUNT` linear commits via `git fast-import` — looping
/// `COMMIT_COUNT` individual `git commit` invocations would dominate this
/// test's OWN runtime with process-spawn overhead having nothing to do with
/// the thing under test; fast-import bulk-creates the whole history in ONE
/// process, well under a second even at this size. Modifies one of 50
/// reused filenames per commit (`file{i%50}.txt`) rather than 5000 always-
/// new files — closer to a real repo's own churn pattern (a bounded set of
/// files edited repeatedly) than an ever-growing tree, and keeps the final
/// tree/working-directory small.
fn seed_large_history(repo: &TempRepo) {
    // `data <exact-byte-count>\n<raw bytes>` — fast-import's own documented
    // format for the `data` command; used here (not the newer `data
    // <<DELIM` heredoc form) to avoid depending on exactly which git
    // version/delimiter-quoting rules are in effect on whatever machine
    // runs this — an exact byte count is unambiguous on every git version
    // that has fast-import at all.
    //
    // No `mark`/`from` commands: EMPIRICALLY CONFIRMED unnecessary AND a
    // real pitfall here — every commit lands on the SAME branch
    // (`refs/heads/main`) in strict sequence, so fast-import already uses
    // that branch's own current tip as each next commit's implicit parent
    // with no `from` needed at all. Explicitly marking each commit and
    // chaining `from :<i-1>` seemed more "correct" at first, but starting
    // the mark numbering at `:0` reproducibly fails ("fatal: mark :0 not
    // declared" on the very next commit's `from :0`) — mark id 0 is treated
    // as a null/unset sentinel internally, not a real registered mark (only
    // discovered by bisecting a 2-commit repro down from the original
    // 5000-commit failure). Omitting both entirely sidesteps that pitfall
    // completely rather than just working around it (e.g. by starting marks
    // at 1) — this stream never needed marks in the first place.
    let mut stream = Vec::<u8>::new();
    for i in 0..COMMIT_COUNT {
        let ts = 1_700_000_000 + i;
        let msg = format!("commit {i}\n");
        let blob = format!("content for commit {i}\n");
        stream.extend_from_slice(b"commit refs/heads/main\n");
        stream.extend_from_slice(
            format!("author GitCat Test <test@gitcat.example> {ts} +0000\ncommitter GitCat Test <test@gitcat.example> {ts} +0000\n").as_bytes(),
        );
        stream.extend_from_slice(format!("data {}\n", msg.len()).as_bytes());
        stream.extend_from_slice(msg.as_bytes());
        stream.extend_from_slice(format!("M 100644 inline file{}.txt\n", i % 50).as_bytes());
        stream.extend_from_slice(format!("data {}\n", blob.len()).as_bytes());
        stream.extend_from_slice(blob.as_bytes());
        stream.push(b'\n');
    }

    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo.path())
        .arg("fast-import")
        .arg("--quiet")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn git fast-import");
    // A write error here (e.g. a broken pipe) means the child already died
    // reading a BAD stream, not that writing itself is what's wrong —
    // ignored so the real diagnostic (git's own stderr, read below via
    // wait_with_output) surfaces instead of a generic I/O error hiding it.
    let _ = child.stdin.take().unwrap().write_all(&stream);
    let output = child.wait_with_output().expect("failed to wait on git fast-import");
    assert!(output.status.success(), "git fast-import failed: {}", String::from_utf8_lossy(&output.stderr));

    // fast-import only writes objects/refs — it never touches the working
    // tree or index (there is no "current checkout" concept during an
    // import), so HEAD's own branch (already "main" per TempRepo::init) is
    // updated but the working directory still shows the ORIGINAL (empty)
    // state until this reset checks the final commit's tree out for real.
    repo.must(&["reset", "--hard"]);
}

#[test]
fn read_repo_stays_fast_on_a_large_synthetic_history() {
    let repo = TempRepo::init("perf-read");
    seed_large_history(&repo);

    let t0 = Instant::now();
    let result = git_read::read_repo(&repo.path(), COMMIT_COUNT, None, None).expect("read_repo should succeed");
    let elapsed = t0.elapsed();

    assert_eq!(result.commits.len(), COMMIT_COUNT);
    // Empirically ~4s for 5000 commits against a WSL-mounted repo over the
    // \\wsl.localhost\ bridge (src/wsl.rs's own doc comment) — a plain
    // local temp-dir repo (what this test uses) has no such bridge and is
    // faster still. 15s leaves a wide margin over that for CI runner
    // variance while still catching a genuine regression by a wide margin,
    // not just brushing past it.
    assert!(elapsed < Duration::from_secs(15), "read_repo took {elapsed:?} for {COMMIT_COUNT} commits — possible performance regression");
    eprintln!("[perf] read_repo: {elapsed:?} for {COMMIT_COUNT} commits");
}

#[test]
fn workdir_status_stays_fast_on_a_large_synthetic_history() {
    let repo = TempRepo::init("perf-workdir");
    seed_large_history(&repo);

    let t0 = Instant::now();
    let status = tauri::async_runtime::block_on(workdir::workdir_status(repo.path())).expect("workdir_status should succeed");
    let elapsed = t0.elapsed();

    assert!(status.staged.is_empty(), "freshly checked-out history should be clean: {} staged entries", status.staged.len());
    assert!(status.unstaged.is_empty(), "freshly checked-out history should be clean: {} unstaged entries", status.unstaged.len());
    assert_eq!(status.conflicted, 0);
    // Empirically ~200ms on a WSL repo via the wsl_status fast path
    // (src/wsl.rs) — this test exercises the git2 path instead (a local,
    // non-WSL temp dir never takes that branch), which was already fast
    // before this bug existed; 10s is a wide margin, not a tuned number.
    assert!(elapsed < Duration::from_secs(10), "workdir_status took {elapsed:?} on a {COMMIT_COUNT}-commit repo — possible performance regression");
    eprintln!("[perf] workdir_status: {elapsed:?} on a {COMMIT_COUNT}-commit repo");
}

#[test]
fn dashboard_repo_status_stays_fast_on_a_large_synthetic_history() {
    let repo = TempRepo::init("perf-dashboard");
    seed_large_history(&repo);

    let t0 = Instant::now();
    let status =
        tauri::async_runtime::block_on(dashboard::dashboard_repo_status(repo.path())).expect("dashboard_repo_status should succeed");
    let elapsed = t0.elapsed();

    assert!(!status.dirty, "freshly checked-out history should be clean");
    assert_eq!(status.conflicted, 0);
    assert!(elapsed < Duration::from_secs(10), "dashboard_repo_status took {elapsed:?} on a {COMMIT_COUNT}-commit repo — possible performance regression");
    eprintln!("[perf] dashboard_repo_status: {elapsed:?} on a {COMMIT_COUNT}-commit repo");
}
