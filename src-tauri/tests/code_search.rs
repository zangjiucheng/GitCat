//! Search Code (`git grep`-based full-text search): working-tree search sees
//! uncommitted edits AND brand-new untracked files, a historical-commit
//! search is correctly scoped to that commit's own tree, case sensitivity,
//! binary files are skipped, empty query / invalid path / invalid rev are
//! refused cleanly, and the truncation cap.
//!
//! Mirrors `tests/pickaxe.rs`'s structure/conventions (`TempRepo` from
//! `tests/common`, a `must_err` helper).

mod common;

use common::TempRepo;
use gitcat_lib::code_search::{code_search, CodeSearchMatch};

fn must_err<T>(r: Result<T, String>, ctx: &str) -> String {
    match r {
        Ok(_) => panic!("{ctx}: expected Err, got Ok"),
        Err(e) => e,
    }
}

fn find<'a>(matches: &'a [CodeSearchMatch], path: &str) -> Option<&'a CodeSearchMatch> {
    matches.iter().find(|m| m.path == path)
}

#[test]
fn working_tree_search_finds_an_uncommitted_edit() {
    let repo = TempRepo::init("codesearch_uncommitted_edit");
    repo.commit("a.txt", "original content\n", "seed");

    // An UNCOMMITTED edit — never `git add`ed/committed.
    std::fs::write(repo.dir.join("a.txt"), "line one\nUNCOMMITTED_TOKEN here\nline three\n").expect("write edit");

    let r = tauri::async_runtime::block_on(code_search(repo.path(), "UNCOMMITTED_TOKEN".to_string(), true, None))
        .expect("search should succeed");
    assert!(!r.truncated);
    let m = find(&r.matches, "a.txt").expect("expected a.txt to match");
    assert_eq!(m.line, 2);
    assert!(m.text.contains("UNCOMMITTED_TOKEN"));
}

#[test]
fn working_tree_search_finds_a_brand_new_untracked_file() {
    let repo = TempRepo::init("codesearch_untracked_file");
    repo.commit("seed.txt", "seed\n", "seed"); // at least one commit so HEAD/rev machinery has something to resolve against

    // Never `git add`ed at all.
    std::fs::write(repo.dir.join("new_file.txt"), "BRAND_NEW_UNTRACKED_TOKEN\n").expect("write untracked file");

    let r = tauri::async_runtime::block_on(code_search(repo.path(), "BRAND_NEW_UNTRACKED_TOKEN".to_string(), true, None))
        .expect("search should succeed");
    let m = find(&r.matches, "new_file.txt").expect("expected the untracked file to be found");
    assert_eq!(m.line, 1);
}

#[test]
fn historical_commit_search_is_scoped_to_that_commits_own_tree() {
    let repo = TempRepo::init("codesearch_historical");
    repo.commit("a.txt", "OLDTOKEN is here\n", "c1: old content");
    let old_sha = repo.rev("HEAD").unwrap();
    repo.commit("a.txt", "NEWTOKEN is here\n", "c2: replace content");

    // At the OLD commit: finds OLDTOKEN, never NEWTOKEN (which didn't exist yet).
    let old_search = tauri::async_runtime::block_on(code_search(repo.path(), "OLDTOKEN".to_string(), true, Some(old_sha.clone())))
        .expect("search should succeed");
    assert!(find(&old_search.matches, "a.txt").is_some(), "OLDTOKEN must be found at the old commit");

    let old_search_new_token = tauri::async_runtime::block_on(code_search(repo.path(), "NEWTOKEN".to_string(), true, Some(old_sha)))
        .expect("search should succeed");
    assert!(old_search_new_token.matches.is_empty(), "NEWTOKEN must NOT be visible at the old commit");

    // Unscoped (working tree / current HEAD content): finds NEWTOKEN.
    let head_search = tauri::async_runtime::block_on(code_search(repo.path(), "NEWTOKEN".to_string(), true, None))
        .expect("search should succeed");
    assert!(find(&head_search.matches, "a.txt").is_some(), "NEWTOKEN must be found in the current checkout");
}

#[test]
fn case_sensitivity_toggle() {
    let repo = TempRepo::init("codesearch_case");
    repo.commit("a.txt", "Hello World\n", "seed");

    let insensitive = tauri::async_runtime::block_on(code_search(repo.path(), "hello".to_string(), false, None))
        .expect("search should succeed");
    assert!(find(&insensitive.matches, "a.txt").is_some(), "case-insensitive search must match despite case difference");

    let sensitive_wrong_case = tauri::async_runtime::block_on(code_search(repo.path(), "hello".to_string(), true, None))
        .expect("search should succeed");
    assert!(sensitive_wrong_case.matches.is_empty(), "case-sensitive search must NOT match the wrong case");

    let sensitive_right_case = tauri::async_runtime::block_on(code_search(repo.path(), "Hello".to_string(), true, None))
        .expect("search should succeed");
    assert!(find(&sensitive_right_case.matches, "a.txt").is_some(), "case-sensitive search must match the exact case");
}

#[test]
fn binary_file_is_not_matched() {
    let repo = TempRepo::init("codesearch_binary");
    repo.commit("seed.txt", "seed\n", "seed");

    // A "binary" file (embedded NUL byte) whose bytes otherwise contain the
    // query text — `-I` must skip it entirely rather than erroring or
    // returning a malformed row.
    let mut bytes = b"BINARY_TOKEN".to_vec();
    bytes.push(0);
    bytes.extend_from_slice(b"more binary data");
    std::fs::write(repo.dir.join("blob.bin"), &bytes).expect("write binary file");

    let r = tauri::async_runtime::block_on(code_search(repo.path(), "BINARY_TOKEN".to_string(), true, None))
        .expect("search should succeed");
    assert!(find(&r.matches, "blob.bin").is_none(), "a binary file must never be matched (-I)");
}

#[test]
fn empty_query_is_refused_cleanly() {
    let repo = TempRepo::init("codesearch_empty_query");
    repo.commit("a.txt", "content\n", "seed");

    let err = must_err(
        tauri::async_runtime::block_on(code_search(repo.path(), "".to_string(), true, None)),
        "an empty query must be a clean Err, not a silent match-everything Ok",
    );
    assert!(!err.is_empty());
}

#[test]
fn invalid_repo_path_is_a_clean_err() {
    let err = must_err(
        tauri::async_runtime::block_on(code_search("/no/such/path/at/all".to_string(), "hello".to_string(), true, None)),
        "nonexistent repo path must be Err",
    );
    assert!(!err.is_empty());
}

#[test]
fn invalid_at_commit_rev_is_a_clean_err() {
    let repo = TempRepo::init("codesearch_invalid_rev");
    repo.commit("a.txt", "content\n", "seed");

    let err = must_err(
        tauri::async_runtime::block_on(code_search(repo.path(), "content".to_string(), true, Some("not-a-real-rev".to_string()))),
        "an unresolvable at_commit must be a clean Err",
    );
    assert!(!err.is_empty());
}

#[test]
fn search_truncates_at_the_match_cap() {
    let repo = TempRepo::init("codesearch_truncation_cap");
    repo.commit("seed.txt", "seed\n", "seed");

    // One file with more matching LINES than the cap — cheap (no thousands of
    // commits needed, unlike pickaxe's/file_history's own truncation tests).
    let n = 2010;
    let mut content = String::new();
    for i in 0..n {
        content.push_str(&format!("needle line {i}\n"));
    }
    std::fs::write(repo.dir.join("many_matches.txt"), &content).expect("write many-match file");

    let r = tauri::async_runtime::block_on(code_search(repo.path(), "needle".to_string(), true, None))
        .expect("search should succeed even when capped");
    assert!(r.truncated, "expected truncated=true for a match count exceeding the cap");
    assert_eq!(r.matches.len(), 2000, "expected exactly MAX_CODE_SEARCH_MATCHES (2000) matches when capped");
}
