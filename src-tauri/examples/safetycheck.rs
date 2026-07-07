//! M2c full-repo-ref-restore harness — THROWAWAY repos only (builds its own).
//! `cargo run --example safetycheck`
//!
//! Proves the Safety Manager's global Undo now restores the WHOLE local-branch
//! topology (delete / create / move / rename), never orphans a commit (at-risk
//! tips are pinned under refs/gitgui/deleted/*), and stays itself-undoable
//! (undo-of-undo re-applies). Each scenario runs in its own fresh temp repo and
//! mirrors reality: snapshot() BEFORE the mutation, then undo() rewinds to it.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use git2::Repository;
use gitcat_lib::safety::{snapshot, undo};

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

/// Full sha of a ref, or None if it does not resolve (branch absent).
fn rev(dir: &Path, r: &str) -> Option<String> {
    let (ok, so, _) = git(dir, &["rev-parse", "--verify", "-q", r]);
    if ok && !so.is_empty() { Some(so) } else { None }
}

fn obj_exists(dir: &Path, sha: &str) -> bool {
    git(dir, &["cat-file", "-e", sha]).0
}

fn deleted_shas(dir: &Path) -> Vec<String> {
    must(dir, &["for-each-ref", "--format=%(objectname)", "refs/gitgui/deleted/"])
        .lines()
        .map(|l| l.to_string())
        .collect()
}

fn clean(dir: &Path) -> bool {
    must(dir, &["status", "--porcelain"]).is_empty()
}

fn commit(dir: &Path, file: &str, content: &str, msg: &str) -> String {
    std::fs::write(dir.join(file), content).unwrap();
    must(dir, &["add", "-A"]);
    must(dir, &["commit", "-q", "--no-verify", "-m", msg]);
    must(dir, &["rev-parse", "HEAD"])
}

/// Fresh repo on `main` with three commits; returns (dir, [c0,c1,c2]).
fn setup(tag: &str) -> (PathBuf, [String; 3]) {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("gitcat-safetycheck-{tag}-{}-{}", std::process::id(), nanos));
    std::fs::create_dir_all(&dir).unwrap();
    must(&dir, &["init", "-q", "-b", "main"]);
    must(&dir, &["config", "commit.gpgsign", "false"]);
    let c0 = commit(&dir, "f.txt", "0\n", "c0");
    let c1 = commit(&dir, "f.txt", "1\n", "c1");
    let c2 = commit(&dir, "f.txt", "2\n", "c2");
    (dir, [c0, c1, c2])
}

fn open(dir: &Path) -> Repository {
    Repository::open(dir).expect("open temp repo")
}

fn pass(msg: &str) {
    eprintln!("PASS: {msg}");
}

fn main() {
    // ---- S1: delete a non-current branch -> undo restores it -------------
    {
        let (dir, [_c0, c1, c2]) = setup("del");
        must(&dir, &["branch", "feature", &c1]); // feature @ c1, HEAD on main @ c2
        let r = snapshot(&open(&dir)).expect("snapshot");
        eprintln!("S1 snapshot {}", r.rsplit('/').next().unwrap());
        must(&dir, &["update-ref", "-d", "refs/heads/feature"]); // simulate delete_branch
        assert!(rev(&dir, "refs/heads/feature").is_none(), "precondition: feature deleted");

        let u = undo(&open(&dir)).expect("undo");
        eprintln!("S1 undo -> ok={} {}", u.ok, u.message);
        assert!(u.ok, "undo failed: {}", u.message);
        assert_eq!(rev(&dir, "refs/heads/feature").as_deref(), Some(c1.as_str()), "feature not restored to c1");
        assert_eq!(rev(&dir, "refs/heads/main").as_deref(), Some(c2.as_str()), "main moved");
        assert_eq!(must(&dir, &["symbolic-ref", "--short", "HEAD"]), "main", "HEAD not on main");
        assert!(clean(&dir), "tree dirty after undo");
        pass("S1 delete: undo recreated the non-current branch, main & HEAD intact");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- S2: create a branch (unique commit) -> undo removes it & PINS tip
    //      S2b: undo-of-undo brings it back --------------------------------
    {
        let (dir, [_c0, _c1, c2]) = setup("new");
        let s2 = snapshot(&open(&dir)).expect("snapshot"); // captures {main:c2} — no tmpwork yet
        eprintln!("S2 snapshot {}", s2.rsplit('/').next().unwrap());
        // Create tmpwork with a UNIQUE commit U (child of c2), leave HEAD on main.
        must(&dir, &["checkout", "-q", "-b", "tmpwork"]);
        let u_sha = commit(&dir, "new.txt", "unique\n", "U (only on tmpwork)");
        must(&dir, &["checkout", "-q", "main"]);
        assert_eq!(rev(&dir, "refs/heads/tmpwork").as_deref(), Some(u_sha.as_str()), "precondition tmpwork@U");

        let u = undo(&open(&dir)).expect("undo");
        eprintln!("S2 undo -> ok={} {}", u.ok, u.message);
        assert!(u.ok, "undo failed: {}", u.message);
        assert!(rev(&dir, "refs/heads/tmpwork").is_none(), "tmpwork (created after snapshot) not removed");
        assert_eq!(rev(&dir, "refs/heads/main").as_deref(), Some(c2.as_str()), "main moved");
        // DATA-SAFETY: U must NOT be orphaned — object still present AND pinned.
        assert!(obj_exists(&dir, &u_sha), "unique commit U was orphaned (object gone)!");
        assert!(deleted_shas(&dir).contains(&u_sha), "unique commit U not pinned under refs/gitgui/deleted/*");
        pass("S2 create: undo removed the new branch AND pinned its unique tip (no orphan)");

        // S2b: undo again -> the sealed snapshot from S2's undo restores tmpwork@U.
        let u2 = undo(&open(&dir)).expect("undo-of-undo");
        eprintln!("S2b undo-of-undo -> ok={} {}", u2.ok, u2.message);
        assert!(u2.ok, "undo-of-undo failed: {}", u2.message);
        assert_eq!(rev(&dir, "refs/heads/tmpwork").as_deref(), Some(u_sha.as_str()), "undo-of-undo did not restore tmpwork@U");
        pass("S2b undo-of-undo: the removed branch came back (undo is itself undoable at ref level)");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- S3: move a non-current branch -> undo restores its position ------
    {
        let (dir, [_c0, c1, c2]) = setup("move");
        must(&dir, &["branch", "feature", &c1]); // feature @ c1
        let s = snapshot(&open(&dir)).expect("snapshot");
        eprintln!("S3 snapshot {}", s.rsplit('/').next().unwrap());
        must(&dir, &["update-ref", "refs/heads/feature", &c2]); // move feature c1 -> c2
        assert_eq!(rev(&dir, "refs/heads/feature").as_deref(), Some(c2.as_str()), "precondition feature@c2");

        let u = undo(&open(&dir)).expect("undo");
        eprintln!("S3 undo -> ok={} {}", u.ok, u.message);
        assert!(u.ok, "undo failed: {}", u.message);
        assert_eq!(rev(&dir, "refs/heads/feature").as_deref(), Some(c1.as_str()), "feature not moved back to c1");
        assert_eq!(rev(&dir, "refs/heads/main").as_deref(), Some(c2.as_str()), "main moved");
        pass("S3 move: undo returned the non-current branch to its snapshot position");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- S4: rename a branch -> undo restores old name, drops new ---------
    {
        let (dir, [_c0, c1, _c2]) = setup("rename");
        must(&dir, &["branch", "feature", &c1]);
        let s = snapshot(&open(&dir)).expect("snapshot");
        eprintln!("S4 snapshot {}", s.rsplit('/').next().unwrap());
        must(&dir, &["branch", "-m", "feature", "feat2"]); // rename feature -> feat2
        assert!(rev(&dir, "refs/heads/feature").is_none() && rev(&dir, "refs/heads/feat2").is_some(), "precondition renamed");

        let u = undo(&open(&dir)).expect("undo");
        eprintln!("S4 undo -> ok={} {}", u.ok, u.message);
        assert!(u.ok, "undo failed: {}", u.message);
        assert_eq!(rev(&dir, "refs/heads/feature").as_deref(), Some(c1.as_str()), "old name 'feature' not restored");
        assert!(rev(&dir, "refs/heads/feat2").is_none(), "renamed 'feat2' not removed");
        pass("S4 rename: undo restored the original name and dropped the renamed branch");
        let _ = std::fs::remove_dir_all(&dir);
    }

    eprintln!("ALL GOOD (full-repo ref restore)");
}
