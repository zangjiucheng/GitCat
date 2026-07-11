//! Pickaxe / diff-content search (`git log -S`/`-G`): occurrence-count-change
//! vs diff-line-match semantics genuinely differ (a reorder that doesn't
//! change a match count is caught by `-G` but not `-S`), `--pickaxe-regex`
//! turns `-S`'s literal into a regex, a `file` scope excludes other files'
//! matches, `--all` reaches a non-HEAD-ancestry commit, the
//! `MAX_PICKAXE_MATCHES` truncation cap, and a clean refusal for an empty
//! query.
//!
//! Mirrors `tests/file_history.rs`'s structure/conventions closely (own
//! `short`/`fmt_entries`/`must_err` helpers, `TempRepo` from `tests/common`).

mod common;

use common::TempRepo;
use gitcat_lib::pickaxe::{pickaxe_search, PickaxeMatch};

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

fn fmt_entries(entries: &[PickaxeMatch]) -> String {
    entries
        .iter()
        .map(|e| format!("[{} subject={:?}]", e.short_sha, e.subject))
        .collect::<Vec<_>>()
        .join(", ")
}

fn subjects(entries: &[PickaxeMatch]) -> Vec<String> {
    entries.iter().map(|e| e.subject.clone()).collect()
}

fn must_err<T>(r: Result<T, String>, ctx: &str) -> String {
    match r {
        Ok(_) => panic!("{ctx}: expected Err, got Ok"),
        Err(e) => e,
    }
}

// ---------------------------------------------------------------------------
// -S vs -G: genuinely different tools, not just different syntax.
//
// Repo: c1 creates "hello world" (1 occurrence), c2 adds a 2nd occurrence
// (1->2), c3 removes one (2->1), c4 adds a 2nd DISTINCT matching line
// (1->2), c5 REORDERS c4's two matching lines (count stays 2->2). -S must
// match c1..c4 but NOT c5 (reorder never changes the occurrence count); -G
// must match ALL of c1..c5 (c5 still adds+removes a diff line matching the
// text, regardless of the unchanged count).
// ---------------------------------------------------------------------------

fn build_reorder_repo(tag: &str) -> (TempRepo, [String; 5]) {
    let repo = TempRepo::init(tag);
    let c1 = repo.commit("content.txt", "hello world\n", "c1: add hello world");
    let c2 = repo.commit("content.txt", "hello world\nhello world\n", "c2: add 2nd occurrence");
    let c3 = repo.commit("content.txt", "hello world\n", "c3: remove one occurrence");
    let c4 = repo.commit("content.txt", "hello world A\nhello world B\n", "c4: add distinct 2nd occurrence");
    let c5 = repo.commit("content.txt", "hello world B\nhello world A\n", "c5: reorder (count unchanged)");
    (repo, [c1, c2, c3, c4, c5])
}

#[test]
fn added_removed_mode_matches_count_changes_but_not_a_pure_reorder() {
    let (repo, [c1, c2, c3, c4, c5]) = build_reorder_repo("pickaxe_reorder_s");
    let _ = &c5; // not expected to appear

    let r = pickaxe_search(repo.path(), "hello world".to_string(), "added-removed".to_string(), false, false, None, None)
        .expect("-S search should succeed");
    assert!(!r.truncated);
    let subs = subjects(&r.entries);
    assert!(subs.iter().any(|s| s.starts_with("c1:")), "expected c1 in {:?}", subs);
    assert!(subs.iter().any(|s| s.starts_with("c2:")), "expected c2 in {:?}", subs);
    assert!(subs.iter().any(|s| s.starts_with("c3:")), "expected c3 in {:?}", subs);
    assert!(subs.iter().any(|s| s.starts_with("c4:")), "expected c4 in {:?}", subs);
    assert!(
        !subs.iter().any(|s| s.starts_with("c5:")),
        "the reorder commit must NOT match -S (count unchanged): {}",
        fmt_entries(&r.entries)
    );
    // sanity: shas line up with the commits we actually made
    assert!(r.entries.iter().any(|e| e.sha == c1));
    assert!(r.entries.iter().any(|e| e.sha == c2));
    assert!(r.entries.iter().any(|e| e.sha == c3));
    assert!(r.entries.iter().any(|e| e.sha == c4));
}

#[test]
fn diff_match_mode_also_matches_the_pure_reorder_commit() {
    let (repo, [c1, c2, c3, c4, c5]) = build_reorder_repo("pickaxe_reorder_g");

    let r = pickaxe_search(repo.path(), "hello world".to_string(), "diff-match".to_string(), false, false, None, None)
        .expect("-G search should succeed");
    assert!(!r.truncated);
    let subs = subjects(&r.entries);
    for (sha, label) in [(&c1, "c1"), (&c2, "c2"), (&c3, "c3"), (&c4, "c4"), (&c5, "c5")] {
        assert!(subs.iter().any(|s| s.starts_with(label)), "expected {label} in {:?}", subs);
        assert!(r.entries.iter().any(|e| &e.sha == sha), "expected sha for {label} present");
    }
    assert_eq!(r.entries.len(), 5, "expected all 5 commits to match -G, got: {}", fmt_entries(&r.entries));
}

// ---------------------------------------------------------------------------
// --pickaxe-regex: turns -S's literal match into a regex.
// ---------------------------------------------------------------------------

#[test]
fn pickaxe_regex_makes_added_removed_mode_treat_query_as_a_regex() {
    let repo = TempRepo::init("pickaxe_regex");
    let _seed = repo.commit("content.txt", "hello world\n", "c1: seed");
    let c2 = repo.commit("content.txt", "hello world\nfoobar123\n", "c2: add foobar123");

    // Literal '.' must NOT match "foobar123" as a wildcard without --pickaxe-regex.
    let literal = pickaxe_search(
        repo.path(),
        "foo.*123".to_string(),
        "added-removed".to_string(),
        false,
        false,
        None,
        None,
    )
    .expect("literal -S search should succeed");
    assert!(
        literal.entries.is_empty(),
        "literal '.*'/'.' must not act as a regex wildcard without --pickaxe-regex: {}",
        fmt_entries(&literal.entries)
    );

    // With regex:true, the same query as a real regex must match c2.
    let regexed = pickaxe_search(
        repo.path(),
        "foo.*123".to_string(),
        "added-removed".to_string(),
        true,
        false,
        None,
        None,
    )
    .expect("regex -S search should succeed");
    assert_eq!(regexed.entries.len(), 1, "expected exactly c2 to match: {}", fmt_entries(&regexed.entries));
    assert_eq!(regexed.entries[0].sha, c2);
}

// ---------------------------------------------------------------------------
// File scope: excludes matches from other files.
// ---------------------------------------------------------------------------

#[test]
fn file_scope_excludes_matches_in_other_files() {
    let repo = TempRepo::init("pickaxe_file_scope");
    let c1 = repo.commit("content.txt", "hello world\n", "c1: hello world in content.txt");
    let c2 = repo.commit("other.txt", "hello world\n", "c2: hello world in other.txt");

    // No scope: both files' commits match.
    let all = pickaxe_search(repo.path(), "hello world".to_string(), "added-removed".to_string(), false, false, None, None)
        .expect("unscoped search should succeed");
    assert_eq!(all.entries.len(), 2, "expected both commits unscoped: {}", fmt_entries(&all.entries));

    // Scoped to content.txt: only c1.
    let scoped = pickaxe_search(
        repo.path(),
        "hello world".to_string(),
        "added-removed".to_string(),
        false,
        false,
        Some("content.txt".to_string()),
        None,
    )
    .expect("file-scoped search should succeed");
    assert_eq!(scoped.entries.len(), 1, "expected only c1 when scoped to content.txt: {}", fmt_entries(&scoped.entries));
    assert_eq!(scoped.entries[0].sha, c1);
    assert_ne!(scoped.entries[0].sha, c2);
}

/// Regression test for a gap an adversarial review flagged: without an
/// existence pre-check, a typo'd `file` scope silently returns an empty
/// result indistinguishable from "your query legitimately has zero
/// matches" (empirically confirmed real git behavior: `git log -S<query>
/// ... -- nonexistent/path.txt` exits 0 with empty stdout, no error).
/// `pickaxe_search` now pre-validates the file exists in the target commit's
/// tree, mirroring file_history.rs's identical guard for the same hazard.
#[test]
fn file_scope_refuses_a_nonexistent_path_instead_of_silently_returning_nothing() {
    let repo = TempRepo::init("pickaxe_bad_file_scope");
    let _c1 = repo.commit("content.txt", "hello world\n", "c1: hello world in content.txt");

    let err = must_err(
        pickaxe_search(
            repo.path(),
            "hello world".to_string(),
            "added-removed".to_string(),
            false,
            false,
            Some("nonexistent/path.txt".to_string()),
            None,
        ),
        "a typo'd file scope must be refused, not silently return zero matches",
    );
    assert!(
        err.contains("nonexistent/path.txt") && err.contains("does not exist"),
        "expected a clear 'does not exist' message naming the bad path, got: {err:?}"
    );
}

/// `at_commit` had zero test coverage even though it's the same
/// already-established resolution pattern blame.rs/file_history.rs both use
/// — an adversarial review flagged this as untested (not broken). Confirms
/// a search anchored at a HISTORICAL commit correctly excludes matches from
/// commits made AFTER it.
#[test]
fn at_commit_anchors_the_search_before_a_later_matching_commit() {
    let repo = TempRepo::init("pickaxe_at_commit");
    let _c1 = repo.commit("content.txt", "nothing interesting\n", "c1: base");
    let mid = repo.rev("HEAD").unwrap();
    let _c2 = repo.commit("content.txt", "hello world\n", "c2: adds hello world, AFTER mid");

    let anchored = pickaxe_search(
        repo.path(),
        "hello world".to_string(),
        "added-removed".to_string(),
        false,
        false,
        None,
        Some(mid.clone()),
    )
    .expect("at_commit search should succeed");
    assert_eq!(
        anchored.entries.len(),
        0,
        "anchored at `mid` (before c2), the later match must be excluded: {}",
        fmt_entries(&anchored.entries)
    );

    // Sanity: the SAME query with no at_commit (defaults to HEAD) DOES find it.
    let unanchored = pickaxe_search(repo.path(), "hello world".to_string(), "added-removed".to_string(), false, false, None, None)
        .expect("unanchored search should succeed");
    assert_eq!(unanchored.entries.len(), 1, "unanchored (HEAD) search must find c2: {}", fmt_entries(&unanchored.entries));
}

// ---------------------------------------------------------------------------
// --all: reaches a commit only present on a non-HEAD branch.
// ---------------------------------------------------------------------------

#[test]
fn all_refs_finds_a_commit_only_reachable_from_a_non_head_branch() {
    let repo = TempRepo::init("pickaxe_all_refs");
    let _c1 = repo.commit("content.txt", "hello world\n", "c1: on main");
    repo.must(&["checkout", "-q", "-b", "feature"]);
    let c2 = repo.commit("branchfile.txt", "hello world\nhello world\n", "c2: only on feature branch");
    repo.must(&["checkout", "-q", "main"]);
    assert_eq!(repo.current_branch(), "main");

    // Without --all: HEAD's ancestry (main) only, c2 invisible.
    let without_all =
        pickaxe_search(repo.path(), "hello world".to_string(), "added-removed".to_string(), false, false, None, None)
            .expect("search without --all should succeed");
    assert!(
        !without_all.entries.iter().any(|e| e.sha == c2),
        "branch-only commit must be invisible without --all: {}",
        fmt_entries(&without_all.entries)
    );

    // With --all: every ref is walked, c2 visible.
    let with_all =
        pickaxe_search(repo.path(), "hello world".to_string(), "added-removed".to_string(), false, true, None, None)
            .expect("search with --all should succeed");
    assert!(
        with_all.entries.iter().any(|e| e.sha == c2),
        "branch-only commit must be visible with --all: {}",
        fmt_entries(&with_all.entries)
    );
}

// ---------------------------------------------------------------------------
// Truncation: more matching commits than MAX_PICKAXE_MATCHES (2000).
// ---------------------------------------------------------------------------

#[test]
fn search_truncates_at_the_match_cap() {
    let repo = TempRepo::init("pickaxe_truncation_cap");

    // See tests/file_history.rs's history_truncates_at_the_commit_cap for why
    // this loop is built via git2 directly rather than shelling out to `git
    // add`/`git commit` 2010 times: that version was flaky under CI resource
    // pressure two different ways (a background `git gc --auto` racing a
    // commit once loose-object count neared git's default gc.auto threshold,
    // and separately a bare subprocess/tempfile failure from spawning ~4000
    // git processes in a tight loop) — writing objects in-process through one
    // git2::Repository handle sidesteps both entirely.
    let n = 2010;
    let git_repo = repo.open();
    let mut parent: Option<git2::Oid> = None;
    for i in 0..n {
        // Every commit toggles the occurrence count of "needle" (0<->1) so
        // EVERY commit is itself a -S match — a simple, fast way to build a
        // repo with more matches than the cap.
        let content = if i % 2 == 0 { "needle\n" } else { "no match here\n" };
        let blob = git_repo.blob(content.as_bytes()).expect("write blob");
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

    let r = pickaxe_search(repo.path(), "needle".to_string(), "added-removed".to_string(), false, false, None, None)
        .expect("search should succeed even when capped");
    assert!(r.truncated, "expected truncated=true for a match count exceeding the cap");
    assert_eq!(r.entries.len(), 2000, "expected exactly MAX_PICKAXE_MATCHES (2000) entries when capped, got {}", r.entries.len());
    // Most-recent-first: the very first entry must be the LAST commit made.
    assert_eq!(r.entries[0].subject, format!("c{}", n - 1));
}

// ---------------------------------------------------------------------------
// Empty query: clean refusal, not a silent empty result (see pickaxe.rs's
// own validate_query doc comment for the empirical hazard this guards).
// ---------------------------------------------------------------------------

#[test]
fn empty_query_is_refused_cleanly_not_silently_empty() {
    let repo = TempRepo::init("pickaxe_empty_query");
    let _c1 = repo.commit("content.txt", "hello world\n", "seed");

    let err = must_err(
        pickaxe_search(repo.path(), "".to_string(), "added-removed".to_string(), false, false, None, None),
        "an empty -S query must be a clean Err, not a silent empty Ok",
    );
    assert!(!err.is_empty());

    let err_g = must_err(
        pickaxe_search(repo.path(), "".to_string(), "diff-match".to_string(), false, false, None, None),
        "an empty -G query must be a clean Err, not a silent empty Ok",
    );
    assert!(!err_g.is_empty());
}

#[test]
fn unknown_mode_is_a_clean_err() {
    let repo = TempRepo::init("pickaxe_unknown_mode");
    let _c1 = repo.commit("content.txt", "hello world\n", "seed");

    let err = must_err(
        pickaxe_search(repo.path(), "hello".to_string(), "bogus-mode".to_string(), false, false, None, None),
        "an unknown mode must be a clean Err",
    );
    assert!(!err.is_empty());
}

#[test]
fn invalid_repo_path_is_a_clean_err() {
    let err = must_err(
        pickaxe_search("/no/such/path/at/all".to_string(), "hello".to_string(), "added-removed".to_string(), false, false, None, None),
        "nonexistent repo path must be Err",
    );
    assert!(!err.is_empty());
}

// ---------------------------------------------------------------------------
// Short-sha field sanity (mirrors file_history.rs's own convention check).
// ---------------------------------------------------------------------------

#[test]
fn entries_carry_correctly_shortened_shas() {
    let repo = TempRepo::init("pickaxe_short_sha");
    let c1 = repo.commit("content.txt", "hello world\n", "c1: seed");

    let r = pickaxe_search(repo.path(), "hello world".to_string(), "added-removed".to_string(), false, false, None, None)
        .expect("search should succeed");
    assert_eq!(r.entries.len(), 1);
    assert_eq!(r.entries[0].sha, c1);
    assert_eq!(r.entries[0].short_sha, short(&c1));
}
