//! M3 bisect harness — THROWAWAY repos only (it builds its own temp repo).
//! `cargo run --example bisectcheck`          # good/bad convergence
//! `cargo run --example bisectcheck -- skip`  # also exercise the `skip` term
//!
//! Builds a fresh disposable 15-commit linear repo (commit #7 / index 6 = K adds
//! bug.txt), drives bisect_start/status/mark/reset programmatically with a pure
//! git2-ancestry oracle, ASSERTS the converged first-bad == K, then resets and
//! ASSERTS HEAD/branch/tree/RepositoryState are fully restored. Prints each
//! BisectStatus as JSON (like pickcheck). Never touches a real repo.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{Oid, Repository, RepositoryState};

use gitcat_lib::git_bisect::{bisect_mark, bisect_reset, bisect_start, bisect_status, BisectStatus};

const N: usize = 15;
const K_IDX: usize = 6;

fn j<T: serde::Serialize>(t: &T) -> String {
    serde_json::to_string(t).unwrap()
}

fn short(oid: Oid) -> String {
    oid.to_string().chars().take(7).collect()
}

fn git(dir: &Path, args: &[&str]) -> (bool, String, String) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
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

fn must(dir: &Path, args: &[&str]) -> String {
    let (ok, so, se) = git(dir, args);
    assert!(ok, "git {args:?} failed: {se}{so}");
    so
}

/// Returns (repo dir, original branch, root oid = good, K oid = first bad, head oid = bad).
fn build_repo() -> (PathBuf, String, Oid, Oid, Oid) {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("gitcat-bisectcheck-{}-{}", std::process::id(), nanos));
    std::fs::create_dir_all(&dir).expect("mkdir temp repo");

    let (ok, _, se) = git(&dir, &["init", "-q", "-b", "main"]);
    assert!(ok, "git init failed: {se}");
    must(&dir, &["config", "commit.gpgsign", "false"]);

    let (mut root, mut k, mut head) = (Oid::zero(), Oid::zero(), Oid::zero());
    for i in 0..N {
        std::fs::write(dir.join("history.txt"), format!("line {i}\n")).unwrap();
        if i == K_IDX {
            std::fs::write(dir.join("bug.txt"), "BUG: regression introduced here\n").unwrap();
        }
        must(&dir, &["add", "-A"]);
        let msg = format!("c{i}");
        must(&dir, &["commit", "-q", "--no-verify", "-m", &msg]);
        let oid = Oid::from_str(&must(&dir, &["rev-parse", "HEAD"])).unwrap();
        if i == 0 {
            root = oid;
        }
        if i == K_IDX {
            k = oid;
        }
        if i == N - 1 {
            head = oid;
        }
    }
    let branch = must(&dir, &["symbolic-ref", "--short", "HEAD"]);
    (dir, branch, root, k, head)
}

/// Ground truth: `cur` is bad iff it IS K or K is an ancestor of it.
fn is_bad(repo: &Repository, cur: Oid, k: Oid) -> bool {
    cur == k || repo.graph_descendant_of(cur, k).unwrap_or(false)
}

fn head_oid(dir: &Path) -> Oid {
    Repository::open(dir).unwrap().head().unwrap().peel_to_commit().unwrap().id()
}

fn main() {
    // Force stable English so the engine's inherited git subprocesses parse the
    // convergence prose regardless of the dev's locale.
    std::env::set_var("LC_ALL", "C");

    let skip_mode = std::env::args().nth(1).as_deref() == Some("skip");

    let (dir, branch, root, k, head) = build_repo();
    let path = dir.to_string_lossy().to_string();
    let repo = Repository::open(&dir).expect("open temp repo");
    let orig_head = repo.head().unwrap().peel_to_commit().unwrap().id();
    assert_eq!(orig_head, head, "sanity: HEAD should be the final commit");
    let k_short = short(k);

    eprintln!("repo          {path}");
    eprintln!("branch        {branch}");
    eprintln!("good (root)   {}", short(root));
    eprintln!("bad  (head)   {}", short(head));
    eprintln!("K  first-bad  {k_short}  (commit #{}, adds bug.txt)", K_IDX + 1);
    eprintln!("mode          {}", if skip_mode { "skip" } else { "good/bad" });

    // ---- start: bad = HEAD, good = [root] ----
    let start: BisectStatus = bisect_start(path.clone(), head.to_string(), vec![root.to_string()]);
    println!("bisect_start  -> {}", j(&start));
    assert!(start.ok, "bisect_start failed: {}", start.message);
    assert!(start.in_progress, "start should leave us in-progress");
    assert!(start.first_bad.is_none(), "start should not already be converged");
    assert!(start.backup_ref.is_some(), "bisect_start MUST snapshot first (backupRef present)");
    assert_eq!(repo.state(), RepositoryState::Bisect, "repo should be mid-bisect after start");
    let mp = head_oid(&dir);
    assert_eq!(start.current.as_ref().map(|c| c.sha.as_str()), Some(short(mp).as_str()), "start.current != HEAD");

    // ---- status -> decide -> mark, until it converges ----
    let mut did_skip = false;
    let mut first_bad: Option<String> = None;

    for step in 0..60 {
        let st: BisectStatus = bisect_status(path.clone());
        println!("bisect_status -> {}", j(&st));
        assert!(st.in_progress, "status should be in-progress at loop top: {}", st.message);
        assert!(st.first_bad.is_none(), "status should be running (no firstBad yet) at loop top");

        let cur = head_oid(&dir);
        let cur_short = short(cur);
        assert_eq!(
            st.current.as_ref().map(|c| c.sha.as_str()),
            Some(cur_short.as_str()),
            "status.current must equal the checked-out HEAD (skip-safe)"
        );

        let bad = is_bad(&repo, cur, k);
        let term = if skip_mode && !did_skip && bad && cur != k {
            did_skip = true;
            "skip"
        } else if bad {
            "bad"
        } else {
            "good"
        };
        eprintln!("  step {step}: current {cur_short} -> {term}");

        let m: BisectStatus = bisect_mark(path.clone(), term.to_string());
        println!("bisect_mark   -> {}", j(&m));
        assert!(m.ok, "bisect_mark {term} failed: {}", m.message);
        if let Some(fb) = m.first_bad {
            first_bad = Some(fb.sha);
            break;
        }
        assert!(m.in_progress, "mark should still be in-progress until converged");
    }

    let fb = first_bad.expect("bisect never converged within 60 steps");
    assert_eq!(fb, k_short, "FIRST-BAD MISMATCH: bisect reported {fb}, expected K {k_short}");
    eprintln!("PASS: first bad == K ({k_short})");

    // ---- reset: ASSERT full recovery ----
    let reset: BisectStatus = bisect_reset(path.clone());
    println!("bisect_reset  -> {}", j(&reset));
    assert!(reset.ok, "bisect_reset failed: {}", reset.message);
    assert!(!reset.in_progress, "reset should leave inProgress false");

    let repo2 = Repository::open(&dir).unwrap();
    assert_eq!(repo2.state(), RepositoryState::Clean, "repo not Clean after reset");
    let h = repo2.head().unwrap();
    assert!(h.is_branch(), "HEAD should be on a branch again (was detached during bisect)");
    assert_eq!(h.shorthand(), Some(branch.as_str()), "HEAD not back on original branch");
    assert_eq!(h.peel_to_commit().unwrap().id(), orig_head, "HEAD oid not restored");
    let porcelain = must(&dir, &["status", "--porcelain"]);
    assert!(porcelain.is_empty(), "working tree dirty after reset: {porcelain}");
    eprintln!("PASS: reset restored {branch} @ {} and the tree is clean", short(orig_head));

    let _ = std::fs::remove_dir_all(&dir);
    eprintln!("ALL GOOD ({} mode)", if skip_mode { "skip" } else { "good/bad" });
}
