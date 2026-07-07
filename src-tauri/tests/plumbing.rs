//! Plumbing playground (M5b): build a small throwaway repo with a root commit,
//! a second commit that adds a nested subdirectory AND a binary blob, and an
//! annotated tag on HEAD — then inspect each of the four object kinds by full
//! sha and by a friendly rev, asserting the returned fields against what we
//! know we committed. Also covers: invalid rev -> clean `Err`, never a panic.

mod common;

use common::TempRepo;
use git2::Repository;
use gitcat_lib::plumbing::{plumbing_inspect, PlumbingObject};

/// (repo, root commit sha, head commit sha).
fn build_repo(tag: &str) -> (TempRepo, String, String) {
    let repo = TempRepo::init(tag);

    // Root commit: a single top-level file.
    let root_sha = repo.commit("root.txt", "root\n", "root commit");

    // Second commit: a nested subdirectory (tree-within-tree) + a binary blob,
    // so tree-entry `kind` covers both "blob" and "tree", and blob covers both
    // text and binary.
    std::fs::create_dir_all(repo.dir.join("dir/sub")).expect("mkdir nested");
    std::fs::write(repo.dir.join("dir/sub/nested.txt"), "nested content\nline2\n")
        .expect("write nested file");
    std::fs::write(repo.dir.join("bin.dat"), [0u8, 1, 2, 3, 0, 255, 254, 0])
        .expect("write binary file");
    repo.must(&["add", "-A"]);
    repo.must(&["commit", "-q", "--no-verify", "-m", "add nested dir + binary blob"]);
    let head_sha = repo.must(&["rev-parse", "HEAD"]);

    // Annotated tag on HEAD (uses the same GIT_COMMITTER_* identity `git()` sets).
    repo.must(&["tag", "-a", "v1.0", "-m", "Release v1.0\n\nSee CHANGELOG.\n", "HEAD"]);

    (repo, root_sha, head_sha)
}

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

#[test]
fn inspect_commit_by_full_sha_and_by_head() {
    let (repo, root_sha, head_sha) = build_repo("plumb_commit");
    let path = repo.path();
    let git2repo = repo.open();

    // Ground truth straight from git2, so this test isn't just re-asserting
    // hardcoded literals against itself.
    let head_commit = git2repo.find_commit(git2::Oid::from_str(&head_sha).unwrap()).unwrap();
    let expected_tree = head_commit.tree_id().to_string();
    let expected_author_time = head_commit.author().when().seconds();

    for rev in [head_sha.as_str(), "HEAD"] {
        let obj = plumbing_inspect(path.clone(), rev.to_string())
            .unwrap_or_else(|e| panic!("plumbing_inspect({rev:?}) failed: {e}"));
        match obj {
            PlumbingObject::Commit(c) => {
                assert_eq!(c.sha, head_sha, "rev {rev:?}: sha mismatch");
                assert_eq!(c.short_sha, short(&head_sha));
                assert_eq!(c.parents, vec![root_sha.clone()], "rev {rev:?}: parents");
                assert_eq!(c.tree, expected_tree, "rev {rev:?}: tree");
                assert_eq!(c.author.name, "GitCat Test");
                assert_eq!(c.author.email, "test@gitcat.example");
                assert_eq!(c.author.time, expected_author_time);
                assert_eq!(c.committer.name, "GitCat Test");
                assert!(c.message.starts_with("add nested dir + binary blob"));
            }
            other => panic!("rev {rev:?}: expected Commit, got {other:?}"),
        }
    }
}

#[test]
fn inspect_root_commit_has_no_parents() {
    let (repo, root_sha, _head_sha) = build_repo("plumb_root");
    let obj = plumbing_inspect(repo.path(), root_sha.clone()).expect("inspect root commit");
    match obj {
        PlumbingObject::Commit(c) => {
            assert_eq!(c.sha, root_sha);
            assert!(c.parents.is_empty(), "root commit must have no parents");
            assert!(c.message.starts_with("root commit"));
        }
        other => panic!("expected Commit, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

#[test]
fn inspect_tree_top_level_and_nested_subdirectory() {
    let (repo, _root_sha, head_sha) = build_repo("plumb_tree");
    let path = repo.path();

    // Top-level tree via the friendly `HEAD^{tree}` rev syntax.
    let obj = plumbing_inspect(path.clone(), "HEAD^{tree}".to_string())
        .expect("inspect HEAD^{tree}");
    let top = match obj {
        PlumbingObject::Tree(t) => t,
        other => panic!("expected Tree, got {other:?}"),
    };
    let by_name = |n: &str| top.entries.iter().find(|e| e.name == n).unwrap_or_else(|| {
        panic!("entry {n:?} missing from top-level tree: {:?}", top.entries.iter().map(|e| &e.name).collect::<Vec<_>>())
    });
    assert_eq!(by_name("root.txt").mode, "100644");
    assert_eq!(by_name("root.txt").kind, "blob");
    assert_eq!(by_name("bin.dat").kind, "blob");
    assert_eq!(by_name("dir").kind, "tree");
    assert_eq!(by_name("dir").mode, "040000");

    // Nested subdirectory tree, resolved via the `HEAD:dir/sub` colon syntax
    // (also double-checks the tree's own sha against a direct sha lookup).
    let nested = plumbing_inspect(path.clone(), "HEAD:dir/sub".to_string())
        .expect("inspect HEAD:dir/sub");
    let nested = match nested {
        PlumbingObject::Tree(t) => t,
        other => panic!("expected Tree, got {other:?}"),
    };
    assert_eq!(nested.entries.len(), 1);
    assert_eq!(nested.entries[0].name, "nested.txt");
    assert_eq!(nested.entries[0].kind, "blob");
    assert_eq!(nested.entries[0].mode, "100644");

    let by_sha = plumbing_inspect(path, nested.sha.clone()).expect("inspect tree by its own sha");
    match by_sha {
        PlumbingObject::Tree(t2) => assert_eq!(t2.entries.len(), 1),
        other => panic!("expected Tree, got {other:?}"),
    }
    let _ = head_sha;
}

// ---------------------------------------------------------------------------
// Blob
// ---------------------------------------------------------------------------

#[test]
fn inspect_text_blob_by_path_rev() {
    let (repo, _root_sha, _head_sha) = build_repo("plumb_blob_text");
    let obj = plumbing_inspect(repo.path(), "HEAD:root.txt".to_string()).expect("inspect blob");
    match obj {
        PlumbingObject::Blob(b) => {
            assert!(!b.is_binary);
            assert_eq!(b.size, "root\n".len());
            // cap_lines (mirrors conflict.rs) rejoins on "\n" without a
            // trailing newline — the raw blob size still reports the real
            // byte count above.
            assert_eq!(b.content.as_deref(), Some("root"));
            assert!(!b.truncated);
        }
        other => panic!("expected Blob, got {other:?}"),
    }
}

#[test]
fn inspect_binary_blob_omits_content() {
    let (repo, _root_sha, _head_sha) = build_repo("plumb_blob_bin");
    let obj = plumbing_inspect(repo.path(), "HEAD:bin.dat".to_string()).expect("inspect blob");
    match obj {
        PlumbingObject::Blob(b) => {
            assert!(b.is_binary, "a blob containing NUL bytes must be detected as binary");
            assert_eq!(b.size, 8);
            assert!(b.content.is_none(), "binary content must be omitted");
        }
        other => panic!("expected Blob, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Tag (annotated)
// ---------------------------------------------------------------------------

#[test]
fn inspect_annotated_tag_by_name_and_by_sha() {
    let (repo, _root_sha, head_sha) = build_repo("plumb_tag");
    let path = repo.path();
    let tag_sha = repo.rev("v1.0").expect("v1.0 should resolve (unpeeled tag oid)");

    for rev in ["v1.0", tag_sha.as_str()] {
        let obj = plumbing_inspect(path.clone(), rev.to_string())
            .unwrap_or_else(|e| panic!("plumbing_inspect({rev:?}) failed: {e}"));
        match obj {
            PlumbingObject::Tag(t) => {
                assert_eq!(t.sha, tag_sha, "rev {rev:?}: tag sha");
                assert_eq!(t.name, "v1.0");
                let tagger = t.tagger.as_ref().unwrap_or_else(|| panic!("rev {rev:?}: missing tagger"));
                assert_eq!(tagger.name, "GitCat Test");
                assert_eq!(tagger.email, "test@gitcat.example");
                assert!(t.message.starts_with("Release v1.0"));
                assert_eq!(t.target_oid, head_sha, "rev {rev:?}: target_oid");
                assert_eq!(t.target_kind, "commit");
            }
            other => panic!("rev {rev:?}: expected Tag, got {other:?}"),
        }
    }

    // Sanity: the tag object's sha must differ from the commit it targets
    // (an annotated tag is its own object, unlike a lightweight tag).
    assert_ne!(tag_sha, head_sha);
}

// ---------------------------------------------------------------------------
// Invalid rev
// ---------------------------------------------------------------------------

#[test]
fn invalid_rev_is_a_clean_err_not_a_panic() {
    let (repo, _root_sha, _head_sha) = build_repo("plumb_invalid");
    let path = repo.path();

    let err = plumbing_inspect(path.clone(), "not-a-real-rev-zzz".to_string())
        .expect_err("bogus rev must be Err");
    assert!(!err.is_empty());

    let err2 = plumbing_inspect(path.clone(), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef".to_string())
        .expect_err("well-formed but nonexistent sha must be Err");
    assert!(!err2.is_empty());

    let err3 = plumbing_inspect(path, String::new()).expect_err("empty rev must be Err");
    assert!(!err3.is_empty());
}

#[test]
fn invalid_repo_path_is_a_clean_err() {
    let err = plumbing_inspect("/no/such/path/at/all".to_string(), "HEAD".to_string())
        .expect_err("nonexistent repo path must be Err");
    assert!(!err.is_empty());
}

/// Silence an unused-import lint if `Repository` becomes only referenced via
/// `common::TempRepo::open` in some configurations.
#[allow(dead_code)]
fn _uses(_: &Repository) {}
