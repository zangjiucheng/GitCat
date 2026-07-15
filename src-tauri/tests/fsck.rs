//! fsck-based dangling-object recovery (backlog #13): a hard-reset-discarded
//! commit is found via `git fsck --dangling --no-reflogs`, a still-reachable
//! commit is correctly excluded, a clean repo returns an empty (not
//! erroring) list, the DTO fields are populated correctly, and an
//! end-to-end recovery (`dangling_commits` -> `create_branch` ->
//! `dangling_commits` again) makes the sha disappear from the list once a
//! real ref points at it.

mod common;

use common::TempRepo;
use gitcat_lib::fsck::dangling_commits;
use gitcat_lib::git_write::create_branch;

#[test]
fn hard_reset_discarded_commit_is_found_as_dangling() {
    let repo = TempRepo::init("fsck_hard_reset");
    let _c1 = repo.commit("f.txt", "1\n", "c1: seed");
    let c2 = repo.commit("f.txt", "2\n", "c2: keep");
    let c3 = repo.commit("f.txt", "3\n", "c3: discarded by hard reset");

    // The "oops": hard reset back to c2, stranding c3.
    repo.must(&["reset", "--hard", &c2]);
    assert_eq!(repo.rev("HEAD").as_deref(), Some(c2.as_str()));
    assert!(repo.obj_exists(&c3), "the object must still exist in the odb");

    let r = dangling_commits(repo.path()).expect("dangling_commits should succeed");
    assert!(!r.truncated);
    assert!(
        r.commits.iter().any(|c| c.sha == c3),
        "expected discarded commit {c3} to show up as dangling, got: {:?}",
        r.commits.iter().map(|c| &c.sha).collect::<Vec<_>>()
    );
}

#[test]
fn still_reachable_commit_is_never_reported_as_dangling() {
    let repo = TempRepo::init("fsck_reachable");
    let c1 = repo.commit("f.txt", "1\n", "c1: seed");
    let c2 = repo.commit("f.txt", "2\n", "c2: tip, still on main");

    let r = dangling_commits(repo.path()).expect("dangling_commits should succeed");
    assert!(
        !r.commits.iter().any(|c| c.sha == c1 || c.sha == c2),
        "commits still reachable from a live branch must never be reported as dangling: {:?}",
        r.commits.iter().map(|c| &c.sha).collect::<Vec<_>>()
    );
}

#[test]
fn repo_with_no_dangling_commits_returns_a_clean_empty_list_not_an_error() {
    let repo = TempRepo::init("fsck_empty");
    let _c1 = repo.commit("f.txt", "1\n", "only commit, nothing ever stranded");

    let r = dangling_commits(repo.path()).expect("dangling_commits should succeed even with nothing dangling");
    assert!(r.commits.is_empty(), "expected an empty list, got: {:?}", r.commits.iter().map(|c| &c.sha).collect::<Vec<_>>());
    assert!(!r.truncated);
}

#[test]
fn dto_fields_are_correctly_populated_for_a_found_dangling_commit() {
    let repo = TempRepo::init("fsck_dto_fields");
    let c1 = repo.commit("f.txt", "1\n", "c1: seed");
    let c2 = repo.commit("f.txt", "2\n", "c2: subject line to check\n\nbody that should not appear in subject");

    repo.must(&["reset", "--hard", &c1]);

    let r = dangling_commits(repo.path()).expect("dangling_commits should succeed");
    let found = r.commits.iter().find(|c| c.sha == c2).unwrap_or_else(|| {
        panic!("expected {c2} in dangling list, got: {:?}", r.commits.iter().map(|c| &c.sha).collect::<Vec<_>>())
    });

    assert_eq!(found.sha, c2, "sha should be the full 40-char oid");
    assert_eq!(found.sha.len(), 40);
    assert_eq!(found.short_sha, common::short(&c2));
    assert_eq!(found.subject, "c2: subject line to check", "subject must be first line only, no body");

    // TempRepo::git() pins author identity/date for reproducibility (see
    // tests/common/mod.rs) — cross-check against those exact fixed values.
    assert_eq!(found.an.n, "GitCat Test");
    assert_eq!(found.an.e, "test@gitcat.example");
    let expected_ts: i64 = repo
        .must(&["show", "-s", "--format=%at", &c2])
        .parse()
        .expect("git show %at should be a parseable integer");
    assert_eq!(found.an.t, expected_ts);
}

#[test]
fn end_to_end_recovery_via_create_branch_removes_it_from_the_dangling_list() {
    let repo = TempRepo::init("fsck_recover_e2e");
    let path = repo.path();
    let c1 = repo.commit("f.txt", "1\n", "c1: seed");
    let c2 = repo.commit("f.txt", "2\n", "c2: to be recovered");

    repo.must(&["reset", "--hard", &c1]);

    let before = dangling_commits(path.clone()).expect("dangling_commits should succeed");
    assert!(before.commits.iter().any(|c| c.sha == c2), "c2 should be dangling before recovery");

    // Recover exactly as the frontend would: create_branch with the
    // dangling sha as start_point, no checkout (mirrors the design's
    // checkout:false shape verification).
    let recovered = tauri::async_runtime::block_on(create_branch(path.clone(), "recovered-c2".into(), Some(c2.clone()), Some(false)));
    assert!(recovered.ok, "create_branch should succeed recovering a real dangling sha: {}", recovered.message);
    assert_eq!(repo.rev("refs/heads/recovered-c2").as_deref(), Some(c2.as_str()));

    let after = dangling_commits(path).expect("dangling_commits should succeed");
    assert!(
        !after.commits.iter().any(|c| c.sha == c2),
        "c2 must no longer be dangling once a real branch points at it: {:?}",
        after.commits.iter().map(|c| &c.sha).collect::<Vec<_>>()
    );

    // current branch (main) must not have moved — recovery never touches HEAD.
    assert_eq!(repo.current_branch(), "main");
    assert_eq!(repo.rev("HEAD").as_deref(), Some(c1.as_str()));
}

/// Regression test for a real bug an adversarial review found: this
/// feature's OWN module doc names "a commit created via plumbing, with no
/// ref/reflog ever touching it" as one of its two headline unique-value
/// cases — but `create_branch` used to refuse unconditionally on an unborn
/// HEAD (no commit yet on the current branch), because its snapshot-first
/// step (`safety::snapshot`) has nothing to snapshot there, even though the
/// underlying `git branch <name> <sha>` call is completely safe (it never
/// touches HEAD/the working tree). Fixed by only snapshotting when
/// `checkout:true` actually would move HEAD.
#[test]
fn recovery_works_on_an_unborn_head_repo_with_a_plumbing_only_dangling_commit() {
    let repo = TempRepo::init("fsck_unborn_head");
    let path = repo.path();
    assert!(repo.rev("HEAD").is_none(), "HEAD must be genuinely unborn — no commit made yet");

    // Build a commit entirely via plumbing — no ref/reflog anywhere ever
    // touches it, exactly the scenario fsck.rs's own doc comment names.
    std::fs::write(repo.dir.join("f.txt"), "plumbing content\n").unwrap();
    let blob = repo.must(&["hash-object", "-w", "f.txt"]);
    let tree_entry = format!("100644 blob {}\tf.txt", blob.trim());
    let mktree_out = std::process::Command::new("git")
        .arg("-C")
        .arg(&repo.dir)
        .arg("mktree")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            child.stdin.take().unwrap().write_all(tree_entry.as_bytes())?;
            child.wait_with_output()
        })
        .expect("git mktree failed to run");
    assert!(mktree_out.status.success(), "git mktree failed: {}", String::from_utf8_lossy(&mktree_out.stderr));
    let tree = String::from_utf8_lossy(&mktree_out.stdout).trim().to_string();
    let commit_sha = repo.must(&[
        "commit-tree",
        &tree,
        "-m",
        "plumbing-only commit, no ref ever points at it",
    ]);
    let commit_sha = commit_sha.trim().to_string();
    assert!(repo.rev("HEAD").is_none(), "HEAD must still be unborn — commit-tree alone moves no ref");

    let found = dangling_commits(path.clone()).expect("dangling_commits should succeed on an unborn-HEAD repo");
    assert!(
        found.commits.iter().any(|c| c.sha == commit_sha),
        "the plumbing-only commit should be listed as dangling: {:?}",
        found.commits.iter().map(|c| &c.sha).collect::<Vec<_>>()
    );

    // The actual regression: recovering it must succeed even though HEAD has
    // no commit to snapshot.
    let recovered = tauri::async_runtime::block_on(create_branch(path, "recovered-plumbing".into(), Some(commit_sha.clone()), Some(false)));
    assert!(recovered.ok, "recovery must succeed on an unborn-HEAD repo: {}", recovered.message);
    assert!(recovered.backup_ref.is_none(), "checkout:false should never snapshot — nothing local changes");
    assert_eq!(repo.rev("refs/heads/recovered-plumbing").as_deref(), Some(commit_sha.as_str()));
}
