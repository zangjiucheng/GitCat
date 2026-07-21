//! Per-file history with rename-following (`git log --follow`): a rename
//! chain (entries continue past the rename with the OLD path), the rename
//! commit itself carries the right `renamed_from`, a never-renamed file
//! behaves like a plain log, an `at_commit` query against a file that no
//! longer exists at HEAD, and the `MAX_HISTORY_COMMITS` truncation cap.

mod common;

use common::TempRepo;
use gitcat_lib::file_history::{file_history, FileHistoryEntry};

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

fn fmt_entries(entries: &[FileHistoryEntry]) -> String {
    entries
        .iter()
        .map(|e| format!("[{} path={} renamed_from={:?} subject={:?}]", e.short_sha, e.path, e.renamed_from, e.subject))
        .collect::<Vec<_>>()
        .join(", ")
}

fn must_err<T>(r: Result<T, String>, ctx: &str) -> String {
    match r {
        Ok(_) => panic!("{ctx}: expected Err, got Ok"),
        Err(e) => e,
    }
}

/// `git mv` a tracked file, edit it, then commit — used by the rename tests.
/// Mirrors `tests/blame.rs`'s own `commit_rename_as` helper/rationale (a
/// dedicated shell-out helper rather than touching `tests/common/mod.rs`'s
/// shared, widely-depended-on `TempRepo::commit`, which can't express a
/// rename).
fn commit_rename(repo: &TempRepo, from: &str, to: &str, new_content: &str, msg: &str) -> String {
    repo.must(&["mv", from, to]);
    std::fs::write(repo.dir.join(to), new_content).expect("write renamed file");
    repo.must(&["add", "-A"]);
    repo.must(&["commit", "-q", "--no-verify", "-m", msg]);
    repo.must(&["rev-parse", "HEAD"])
}

// ---------------------------------------------------------------------------
// Rename-following: entries continue past the rename, with the OLD path pre-
// rename, and the rename commit itself is annotated.
// ---------------------------------------------------------------------------

#[test]
fn history_follows_a_rename_and_continues_with_the_old_path() {
    let repo = TempRepo::init("filehistory_rename");

    let c1 = repo.commit("old-name.txt", "line1\n", "c1: add old-name.txt");
    let c2 = repo.commit("old-name.txt", "line1\nline2\n", "c2: edit old-name.txt");
    let c3 = commit_rename(&repo, "old-name.txt", "new-name.txt", "line1\nline2\nline3\n", "c3: rename to new-name.txt");
    let c4 = repo.commit("new-name.txt", "line1\nline2\nline3\nline4\n", "c4: edit after rename");

    let fh = tauri::async_runtime::block_on(file_history(repo.path(), "new-name.txt".to_string(), None))
        .expect("history across a rename should succeed");

    assert_eq!(fh.file, "new-name.txt");
    assert_eq!(fh.at_sha, c4);
    assert!(!fh.truncated);
    assert_eq!(fh.entries.len(), 4, "expected 4 entries, got: {}", fmt_entries(&fh.entries));

    // Reverse-chronological: c4, c3, c2, c1.
    assert_eq!(fh.entries[0].sha, c4);
    assert_eq!(fh.entries[0].short_sha, short(&c4));
    assert_eq!(fh.entries[0].path, "new-name.txt");
    assert_eq!(fh.entries[0].renamed_from, None);
    assert_eq!(fh.entries[0].subject, "c4: edit after rename");

    // The rename commit itself: path is the NEW name, renamed_from is the OLD name.
    assert_eq!(fh.entries[1].sha, c3);
    assert_eq!(fh.entries[1].path, "new-name.txt");
    assert_eq!(
        fh.entries[1].renamed_from.as_deref(),
        Some("old-name.txt"),
        "the rename commit must carry renamed_from: {}",
        fmt_entries(&fh.entries)
    );

    // Entries BEFORE the rename must show the OLD path, not the queried
    // (new) one — this is the entire point of --follow.
    assert_eq!(fh.entries[2].sha, c2);
    assert_eq!(fh.entries[2].path, "old-name.txt");
    assert_eq!(fh.entries[2].renamed_from, None);

    assert_eq!(fh.entries[3].sha, c1);
    assert_eq!(fh.entries[3].path, "old-name.txt");
    assert_eq!(fh.entries[3].renamed_from, None);
}

// ---------------------------------------------------------------------------
// Regression test for a real bug an adversarial review caught: without
// `-c core.quotePath=false`, git C-quotes any non-ASCII byte in a
// --name-status path into an unreadable "\NNN-octal-escaped" string, so a
// real café-résumé.txt-style rename came back with `path`/`renamed_from`
// full of backslash-octal garbage instead of the real filename. Fixed by
// always passing `-c core.quotePath=false` (see file_history_inner's own
// comment on the git invocation).
// ---------------------------------------------------------------------------

#[test]
fn history_reports_non_ascii_paths_uncorrupted_by_quotepath() {
    let repo = TempRepo::init("filehistory_unicode");

    let c1 = repo.commit("café-résumé.txt", "line1\n", "c1: add café-résumé.txt");
    let c2 = commit_rename(&repo, "café-résumé.txt", "naïve.txt", "line1\nline2\n", "c2: rename to naïve.txt");

    let fh = tauri::async_runtime::block_on(file_history(repo.path(), "naïve.txt".to_string(), None)).expect("history should succeed");

    assert_eq!(fh.entries.len(), 2, "expected 2 entries, got: {}", fmt_entries(&fh.entries));
    assert_eq!(fh.entries[0].sha, c2);
    assert_eq!(fh.entries[0].path, "naïve.txt", "the current path must be the real UTF-8 name, not quoted/escaped");
    assert_eq!(
        fh.entries[0].renamed_from.as_deref(),
        Some("café-résumé.txt"),
        "renamed_from must be the real UTF-8 old name, not quoted/escaped: {}",
        fmt_entries(&fh.entries)
    );
    assert_eq!(fh.entries[1].sha, c1);
    assert_eq!(fh.entries[1].path, "café-résumé.txt");
}

// ---------------------------------------------------------------------------
// No renames at all: behaves like a plain (non-follow) log.
// ---------------------------------------------------------------------------

#[test]
fn history_with_no_renames_behaves_like_a_plain_log() {
    let repo = TempRepo::init("filehistory_plain");

    let c1 = repo.commit("file.txt", "v1\n", "c1: add file.txt");
    let c2 = repo.commit("file.txt", "v1\nv2\n", "c2: edit file.txt");
    let c3 = repo.commit("file.txt", "v1\nv2\nv3\n", "c3: edit file.txt again");

    let fh = tauri::async_runtime::block_on(file_history(repo.path(), "file.txt".to_string(), None)).expect("plain history should succeed");
    assert_eq!(fh.at_sha, c3);
    assert!(!fh.truncated);
    assert_eq!(fh.entries.len(), 3, "expected 3 entries, got: {}", fmt_entries(&fh.entries));
    assert_eq!(fh.entries[0].sha, c3);
    assert_eq!(fh.entries[1].sha, c2);
    assert_eq!(fh.entries[2].sha, c1);
    for e in &fh.entries {
        assert_eq!(e.path, "file.txt");
        assert_eq!(e.renamed_from, None);
    }
}

// ---------------------------------------------------------------------------
// A file absent at HEAD but present at an earlier at_commit is still
// queryable via that at_commit.
// ---------------------------------------------------------------------------

#[test]
fn history_of_a_file_deleted_at_head_is_queryable_via_at_commit() {
    let repo = TempRepo::init("filehistory_deleted");

    let c1 = repo.commit("gone.txt", "hello\n", "c1: add gone.txt");
    let c2 = repo.commit("gone.txt", "hello\nworld\n", "c2: edit gone.txt");
    repo.must(&["rm", "-q", "gone.txt"]);
    repo.must(&["commit", "-q", "--no-verify", "-m", "c3: delete gone.txt"]);
    let c3 = repo.must(&["rev-parse", "HEAD"]);

    // At HEAD, the file doesn't exist -> clean Err, not a panic or empty Ok.
    let err = must_err(
        tauri::async_runtime::block_on(file_history(repo.path(), "gone.txt".to_string(), None)),
        "gone.txt no longer exists at HEAD",
    );
    assert!(err.contains("does not exist"), "expected a 'does not exist' message, got: {err}");

    // Querying AT the delete commit itself: the file existed in a prior
    // state and the delete is itself a change, so tree lookup at c3 (the
    // delete commit) fails the SAME way libgit2 does for blame.rs (the
    // delete commit's own tree no longer has the path) - confirm that too,
    // then confirm the parent works.
    let err_at_delete = must_err(
        tauri::async_runtime::block_on(file_history(repo.path(), "gone.txt".to_string(), Some(c3.clone()))),
        "gone.txt is absent from the delete commit's own tree",
    );
    assert!(err_at_delete.contains("does not exist"));

    // At the delete commit's PARENT (where the file still exists), the full
    // pre-deletion history must be queryable. `at_commit` mirrors
    // `blame_file`'s own convention: resolved via `find_commit_by_prefix`,
    // a full/short SHA only, never revspec syntax like `<sha>^` — exactly
    // like blame.rs, resolving `^` to a real sha is the CALLER's job (see
    // detail.svelte.ts's `historyFile`, which resolves it via
    // `plumbingInspect` before calling `fileHistoryCtrl.openFor`). Here the
    // parent's real sha is already in hand as `c2`.
    let fh = tauri::async_runtime::block_on(file_history(repo.path(), "gone.txt".to_string(), Some(c2.clone())))
        .expect("history at the parent of the delete commit should succeed");
    assert_eq!(fh.at_sha, c2, "at_sha must resolve to the parent commit, not the delete commit");
    assert_eq!(fh.entries.len(), 2, "expected 2 entries, got: {}", fmt_entries(&fh.entries));
    assert_eq!(fh.entries[0].sha, c2);
    assert_eq!(fh.entries[1].sha, c1);
}

// ---------------------------------------------------------------------------
// Truncation: more touching commits than MAX_HISTORY_COMMITS.
// ---------------------------------------------------------------------------

#[test]
fn history_truncates_at_the_commit_cap() {
    let repo = TempRepo::init("filehistory_truncation_cap");

    // MAX_HISTORY_COMMITS is 2000; build a repo with a comfortably larger
    // number of commits that ALL touch the same file. Built directly via
    // git2 (blob+tree+commit, no `git` subprocess) rather than 2010 rounds
    // of `git add -A && git commit` — that shelled-out version was BOTH slow
    // AND flaky under CI resource pressure two different ways: a background
    // `git gc --auto` racing a commit trying to read HEAD's tree once loose
    // object count approached git's default gc.auto threshold ("bad tree
    // object HEAD"), and separately a plain subprocess/tempfile failure
    // ("unable to create temporary file") from spawning ~4000 git processes
    // in a tight loop. Writing objects in-process through one long-lived
    // git2::Repository handle sidesteps both failure classes entirely — no
    // other process ever touches this repo while the loop runs.
    let n = 2010;
    let git_repo = repo.open();
    let mut parent: Option<git2::Oid> = None;
    for i in 0..n {
        let blob = git_repo.blob(format!("rev{i}\n").as_bytes()).expect("write blob");
        let mut tb = git_repo.treebuilder(None).expect("new treebuilder");
        tb.insert("churn.txt", blob, 0o100644).expect("tree insert");
        let tree_oid = tb.write().expect("write tree");
        let tree = git_repo.find_tree(tree_oid).expect("find tree");
        let parents = match parent {
            Some(oid) => vec![git_repo.find_commit(oid).expect("find parent commit")],
            None => vec![],
        };
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        // Distinct, monotonically increasing times — same-second commits
        // would make revwalk's chronological ordering ambiguous.
        let sig = git2::Signature::new("GitCat Test", "test@gitcat.example", &git2::Time::new(1_735_689_600 + i as i64, 0))
            .expect("build signature");
        let commit_oid = git_repo
            .commit(Some("HEAD"), &sig, &sig, &format!("c{i}"), &tree, &parent_refs)
            .expect("create commit");
        parent = Some(commit_oid);
    }

    let fh = tauri::async_runtime::block_on(file_history(repo.path(), "churn.txt".to_string(), None)).expect("history should succeed even when capped");
    assert!(fh.truncated, "expected truncated=true for a history exceeding the cap");
    assert_eq!(
        fh.entries.len(),
        2000,
        "expected exactly MAX_HISTORY_COMMITS (2000) entries when capped, got {}",
        fh.entries.len()
    );
    // Most-recent-first: the very first entry must be the LAST commit made.
    assert_eq!(fh.entries[0].subject, format!("c{}", n - 1));
}

// ---------------------------------------------------------------------------
// Bad path / bad repo: clean refusals, not panics.
// ---------------------------------------------------------------------------

#[test]
fn history_of_a_bogus_path_is_a_clean_err() {
    let repo = TempRepo::init("filehistory_bogus_path");
    let _c1 = repo.commit("real.txt", "hi\n", "seed");

    let err = must_err(
        tauri::async_runtime::block_on(file_history(repo.path(), "nope/nowhere.txt".to_string(), None)),
        "a bogus path must be a clean Err",
    );
    assert!(!err.is_empty());
}

#[test]
fn history_invalid_repo_path_is_a_clean_err() {
    let err = must_err(
        tauri::async_runtime::block_on(file_history("/no/such/path/at/all".to_string(), "x.txt".to_string(), None)),
        "nonexistent repo path must be Err",
    );
    assert!(!err.is_empty());
}
