//! Blame (line-annotation view): a file with several distinct
//! commit-authored regions, a renamed file (free rename-lineage signal, no
//! flag needed), a brand-new file with no history, an empty file, a binary
//! file (clean refusal), and a request for a file absent from the target
//! commit.

mod common;

use std::process::Command;

use common::TempRepo;
use gitcat_lib::blame::{blame_file, BlameHunkRow};

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// Neither `BlameHunkRow` nor `FileBlame` derive `Debug` (they reuse
/// `model::Person`, which itself doesn't derive it — matching every other
/// DTO in `model.rs`), so these two small helpers stand in for
/// `{:?}`/`.expect_err()` without requiring it.
fn fmt_hunks(hunks: &[BlameHunkRow]) -> String {
    hunks
        .iter()
        .map(|h| format!("[{}..{} sha={} orig={:?}]", h.start_line, h.start_line + h.lines_in_hunk, h.short_sha, h.orig_path))
        .collect::<Vec<_>>()
        .join(", ")
}

fn must_err<T>(r: Result<T, String>, ctx: &str) -> String {
    match r {
        Ok(_) => panic!("{ctx}: expected Err, got Ok"),
        Err(e) => e,
    }
}

/// Like `TempRepo::commit`, but lets the caller pick author/committer
/// identity — needed to make "several distinct commit-authored regions"
/// actually carry distinct authors. `TempRepo::git`/`must` hardcode a single
/// fixed identity via env vars (by design, for every OTHER test file's
/// determinism), so this shells out directly rather than touching
/// `tests/common/mod.rs`'s shared, widely-depended-on helper.
fn commit_as(repo: &TempRepo, name: &str, email: &str, file: &str, content: &str, msg: &str) -> String {
    std::fs::write(repo.dir.join(file), content).expect("write file");
    let run = |args: &[&str], extra_env: &[(&str, &str)]| {
        let mut cmd = Command::new("git");
        cmd.arg("-C")
            .arg(&repo.dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null");
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
        let out = cmd.output().expect("failed to spawn git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    run(&["add", "-A"], &[]);
    run(
        &["commit", "-q", "--no-verify", "-m", msg],
        &[
            ("GIT_AUTHOR_NAME", name),
            ("GIT_AUTHOR_EMAIL", email),
            ("GIT_COMMITTER_NAME", name),
            ("GIT_COMMITTER_EMAIL", email),
            ("GIT_AUTHOR_DATE", "2026-01-01T00:00:00Z"),
            ("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z"),
        ],
    );
    run(&["rev-parse", "HEAD"], &[])
}

/// `git mv` a tracked file, then commit as `name`/`email` — used by the
/// rename test.
fn commit_rename_as(
    repo: &TempRepo,
    name: &str,
    email: &str,
    from: &str,
    to: &str,
    new_content: &str,
    msg: &str,
) -> String {
    let run = |args: &[&str], extra_env: &[(&str, &str)]| {
        let mut cmd = Command::new("git");
        cmd.arg("-C")
            .arg(&repo.dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null");
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
        let out = cmd.output().expect("failed to spawn git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    run(&["mv", from, to], &[]);
    std::fs::write(repo.dir.join(to), new_content).expect("write renamed file");
    run(&["add", "-A"], &[]);
    run(
        &["commit", "-q", "--no-verify", "-m", msg],
        &[
            ("GIT_AUTHOR_NAME", name),
            ("GIT_AUTHOR_EMAIL", email),
            ("GIT_COMMITTER_NAME", name),
            ("GIT_COMMITTER_EMAIL", email),
            ("GIT_AUTHOR_DATE", "2026-01-02T00:00:00Z"),
            ("GIT_COMMITTER_DATE", "2026-01-02T00:00:00Z"),
        ],
    );
    run(&["rev-parse", "HEAD"], &[])
}

// ---------------------------------------------------------------------------
// Several distinct commit-authored regions
// ---------------------------------------------------------------------------

#[test]
fn blame_reports_distinct_hunks_per_authoring_commit() {
    let repo = TempRepo::init("blame_regions");

    // c1 (alice): lines 1-3.
    let c1 = commit_as(
        &repo,
        "Alice",
        "alice@example.com",
        "file.txt",
        "line1\nline2\nline3\n",
        "c1: add file",
    );
    // c2 (bob): append lines 4-6.
    let c2 = commit_as(
        &repo,
        "Bob",
        "bob@example.com",
        "file.txt",
        "line1\nline2\nline3\nline4\nline5\nline6\n",
        "c2: append more lines",
    );
    // c3 (carol): modify line 2 only.
    let c3 = commit_as(
        &repo,
        "Carol",
        "carol@example.com",
        "file.txt",
        "line1\nline2-edited\nline3\nline4\nline5\nline6\n",
        "c3: edit line 2",
    );

    let fb = blame_file(repo.path(), "file.txt".to_string(), None, false)
        .expect("blame at HEAD should succeed");

    assert_eq!(fb.path, "file.txt");
    assert_eq!(fb.at_sha, c3);
    assert_eq!(fb.total_lines, 6);
    assert!(!fb.truncated);
    assert_eq!(fb.lines, vec!["line1", "line2-edited", "line3", "line4", "line5", "line6"]);

    // Expect (at least) 4 hunks: L1 (c1), L2 (c3), L3 (c1), L4-6 (c2).
    assert!(fb.hunks.len() >= 4, "expected >=4 hunks, got {}", fmt_hunks(&fb.hunks));

    let hunk_for = |line: u32| {
        fb.hunks
            .iter()
            .find(|h| line >= h.start_line && line < h.start_line + h.lines_in_hunk)
            .unwrap_or_else(|| panic!("no hunk covers line {line}: {}", fmt_hunks(&fb.hunks)))
    };

    let h1 = hunk_for(1);
    assert_eq!(h1.sha, c1);
    assert_eq!(h1.short_sha, short(&c1));
    assert_eq!(h1.author.n, "Alice");
    assert_eq!(h1.author.e, "alice@example.com");

    let h2 = hunk_for(2);
    assert_eq!(h2.sha, c3, "the edited line must blame to the edit commit, not the original");
    assert_eq!(h2.author.n, "Carol");

    let h3 = hunk_for(3);
    assert_eq!(h3.sha, c1);

    for line in 4..=6 {
        let h = hunk_for(line);
        assert_eq!(h.sha, c2, "line {line} must blame to the append commit");
        assert_eq!(h.author.n, "Bob");
    }

    let _ = c2;
}

/// The same file, blamed AT an older commit (`at_commit = Some(c1)`) rather
/// than HEAD, must show only that commit's content/history — not silently
/// fall through to the current (HEAD) version.
#[test]
fn blame_at_an_older_commit_shows_that_commits_own_content() {
    let repo = TempRepo::init("blame_at_commit");
    let c1 = commit_as(&repo, "Alice", "alice@example.com", "file.txt", "line1\nline2\n", "c1");
    let _c2 = commit_as(
        &repo,
        "Bob",
        "bob@example.com",
        "file.txt",
        "line1\nline2\nline3\n",
        "c2: append line3",
    );

    let fb = blame_file(repo.path(), "file.txt".to_string(), Some(c1.clone()), false)
        .expect("blame at c1 should succeed");
    assert_eq!(fb.at_sha, c1);
    assert_eq!(fb.total_lines, 2);
    assert_eq!(fb.lines, vec!["line1", "line2"]);
    assert!(fb.hunks.iter().all(|h| h.sha == c1));
}

// ---------------------------------------------------------------------------
// Renamed file: free rename-lineage signal (orig_path), no track-copies flag
// ---------------------------------------------------------------------------

#[test]
fn blame_surfaces_orig_path_across_a_rename() {
    let repo = TempRepo::init("blame_rename");
    let c1 = commit_as(
        &repo,
        "Alice",
        "alice@example.com",
        "old.txt",
        "alpha\nbeta\n",
        "c1: add old.txt",
    );
    let c2 = commit_rename_as(
        &repo,
        "Bob",
        "bob@example.com",
        "old.txt",
        "new.txt",
        "alpha\nbeta\ngamma\n",
        "c2: rename old.txt -> new.txt, add gamma",
    );

    let fb = blame_file(repo.path(), "new.txt".to_string(), None, false)
        .expect("blame across a rename should succeed");
    assert_eq!(fb.at_sha, c2);
    assert_eq!(fb.lines, vec!["alpha", "beta", "gamma"]);

    // Lines 1-2 predate the rename: their hunk(s) must carry final_commit_id
    // == c1 (content unchanged since c1) AND an orig_path pointing back at
    // "old.txt" (the free rename-lineage signal — no track-copies flag set).
    let pre_rename_hunk = fb
        .hunks
        .iter()
        .find(|h| h.start_line == 1)
        .expect("a hunk must start at line 1");
    assert_eq!(pre_rename_hunk.sha, c1);
    assert_eq!(
        pre_rename_hunk.orig_path.as_deref(),
        Some("old.txt"),
        "hunk predating the rename must report its original path (start_line={}, sha={})",
        pre_rename_hunk.start_line,
        pre_rename_hunk.short_sha,
    );

    // Line 3 (gamma) was authored IN the rename commit itself, at the new
    // path — no orig_path annotation expected (same as the queried path).
    let new_line_hunk = fb
        .hunks
        .iter()
        .find(|h| h.start_line == 3)
        .expect("a hunk must start at line 3");
    assert_eq!(new_line_hunk.sha, c2);
    assert_eq!(new_line_hunk.orig_path, None);
}

// ---------------------------------------------------------------------------
// Brand-new file with no history
// ---------------------------------------------------------------------------

#[test]
fn blame_brand_new_file_has_a_single_hunk() {
    let repo = TempRepo::init("blame_new_file");
    let c1 = repo.commit("fresh.txt", "only line\n", "add fresh.txt");

    let fb = blame_file(repo.path(), "fresh.txt".to_string(), None, false)
        .expect("blame a brand-new file should succeed");
    assert_eq!(fb.total_lines, 1);
    assert_eq!(fb.lines, vec!["only line"]);
    assert_eq!(fb.hunks.len(), 1);
    assert_eq!(fb.hunks[0].sha, c1);
    assert_eq!(fb.hunks[0].start_line, 1);
    assert_eq!(fb.hunks[0].lines_in_hunk, 1);
    assert_eq!(fb.hunks[0].orig_path, None);
}

// ---------------------------------------------------------------------------
// Empty file
// ---------------------------------------------------------------------------

#[test]
fn blame_empty_file_reports_zero_lines_and_no_hunks() {
    let repo = TempRepo::init("blame_empty_file");
    let _c1 = repo.commit("empty.txt", "", "add empty file");

    let fb = blame_file(repo.path(), "empty.txt".to_string(), None, false)
        .expect("blame an empty file should succeed, not error");
    assert_eq!(fb.total_lines, 0);
    assert!(!fb.truncated);
    assert!(fb.lines.is_empty());
    // libgit2 hands back exactly one degenerate zero-length hunk for an
    // empty blob (verified against git2's own `blame::tests::smoke`, which
    // asserts `lines_in_hunk() == 0` for an empty file) rather than zero
    // hunks — it covers no actual line, so the frontend's empty-file note
    // (§4) still fires off `total_lines == 0`, not off `hunks`.
    assert!(
        fb.hunks.iter().all(|h| h.lines_in_hunk == 0),
        "an empty file's hunk(s), if any, must cover zero lines"
    );
}

// ---------------------------------------------------------------------------
// Binary file: clean refusal
// ---------------------------------------------------------------------------

#[test]
fn blame_binary_file_is_a_clean_refusal_not_a_panic() {
    let repo = TempRepo::init("blame_binary");
    std::fs::write(repo.dir.join("bin.dat"), [0u8, 1, 2, 3, 0, 255, 254, 0]).expect("write binary file");
    repo.must(&["add", "-A"]);
    repo.must(&["commit", "-q", "--no-verify", "-m", "add binary file"]);

    let err = must_err(
        blame_file(repo.path(), "bin.dat".to_string(), None, false),
        "a binary file must refuse blame, not panic or succeed",
    );
    assert!(err.contains("binary"), "expected a binary-refusal message, got: {err}");
}

// ---------------------------------------------------------------------------
// File absent from the target commit
// ---------------------------------------------------------------------------

#[test]
fn blame_file_missing_at_target_commit_is_a_clean_err() {
    let repo = TempRepo::init("blame_missing");
    let root_sha = repo.commit("root.txt", "root\n", "root commit");
    let _c2 = repo.commit("later.txt", "born later\n", "add later.txt");

    // "later.txt" does not exist in the root commit's own tree.
    let err = must_err(
        blame_file(repo.path(), "later.txt".to_string(), Some(root_sha.clone()), false),
        "a file absent from the target commit must be a clean Err",
    );
    assert!(
        err.contains("does not exist"),
        "expected a 'does not exist' message, got: {err}"
    );

    // A wholly bogus path at HEAD must also fail cleanly.
    let err2 = must_err(
        blame_file(repo.path(), "nope/nowhere.txt".to_string(), None, false),
        "a bogus path must be a clean Err",
    );
    assert!(!err2.is_empty());
}

// ---------------------------------------------------------------------------
// Uncommitted rename / uncommitted new file at HEAD — the exact backend
// contract Workdir.svelte's Blame button (atCommit = null = "blame HEAD")
// must respect for its own path-selection logic (see workdir/Workdir.svelte's
// `canBlame`/`blameTarget` helpers): HEAD's own committed tree never has a
// STAGED-but-uncommitted rename's new path (only the old one), and never has
// a STAGED-but-uncommitted new file at all. `blame_file` must refuse cleanly
// for both — it is the FRONTEND's job to resolve the right target path
// (`f.oldPath` for a rename row, or simply disable Blame for a staged-new
// row), not the backend's job to guess.
// ---------------------------------------------------------------------------

#[test]
fn blame_at_head_fails_for_a_renames_new_path_when_the_rename_is_only_staged() {
    let repo = TempRepo::init("blame_staged_rename");
    let _c1 = repo.commit("old.txt", "alpha\nbeta\n", "add old.txt");
    repo.must(&["mv", "old.txt", "new.txt"]); // staged rename, NOT committed

    let err = must_err(
        blame_file(repo.path(), "new.txt".to_string(), None, false),
        "new.txt isn't in HEAD's tree yet — the rename is only staged",
    );
    assert!(err.contains("does not exist"), "expected a 'does not exist' message, got: {err}");

    // The OLD path is exactly what Workdir.svelte's `blameTarget()` must fall
    // back to for this row, and it must blame fine (unaffected by the staged
    // rename, since HEAD's own tree still only knows the file by this name).
    let fb = blame_file(repo.path(), "old.txt".to_string(), None, false)
        .expect("old.txt must still blame fine at HEAD despite the pending rename");
    assert_eq!(fb.lines, vec!["alpha", "beta"]);
}

#[test]
fn blame_at_head_fails_for_a_brand_new_files_path_when_only_staged() {
    let repo = TempRepo::init("blame_staged_new_file");
    let _c1 = repo.commit("existing.txt", "hi\n", "seed"); // HEAD must exist for "at HEAD" to mean anything
    std::fs::write(repo.dir.join("brand_new.txt"), "content\n").expect("write brand_new.txt");
    repo.must(&["add", "-A"]); // staged "A", not committed — no history anywhere yet

    let err = must_err(
        blame_file(repo.path(), "brand_new.txt".to_string(), None, false),
        "a staged-but-uncommitted new file has no HEAD history to blame",
    );
    assert!(err.contains("does not exist"), "expected a 'does not exist' message, got: {err}");
}

#[test]
fn blame_invalid_repo_path_is_a_clean_err() {
    let err = must_err(
        blame_file("/no/such/path/at/all".to_string(), "x.txt".to_string(), None, false),
        "nonexistent repo path must be Err",
    );
    assert!(!err.is_empty());
}

// ---------------------------------------------------------------------------
// MAX_BLAME_LINES truncation — the module's own doc comment claims a large
// file is capped, not silently mishandled or crashed on; this exercises that
// claim directly rather than trusting it.
// ---------------------------------------------------------------------------

#[test]
fn blame_truncates_at_the_line_cap_without_dropping_or_overshooting() {
    let repo = TempRepo::init("blame_truncation_cap");

    // 2000 lines exactly — must NOT be reported as truncated.
    let content_2000: String = (1..=2000).map(|i| format!("line{i}\n")).collect();
    commit_as(&repo, "Alice", "alice@example.com", "big.txt", &content_2000, "c1: 2000 lines");
    let fb_2000 =
        blame_file(repo.path(), "big.txt".to_string(), None, false).expect("blame at exactly the cap should succeed");
    assert_eq!(fb_2000.total_lines, 2000);
    assert!(!fb_2000.truncated, "exactly MAX_BLAME_LINES lines must not be reported as truncated");
    assert_eq!(fb_2000.lines.len(), 2000);

    // One more line (2001) — must now be reported truncated, capped to
    // exactly 2000 lines/hunk-coverage, never fewer and never more.
    let content_2001: String = (1..=2001).map(|i| format!("line{i}\n")).collect();
    commit_as(&repo, "Alice", "alice@example.com", "big.txt", &content_2001, "c2: 2001 lines");
    let fb_2001 =
        blame_file(repo.path(), "big.txt".to_string(), None, false).expect("blame past the cap should succeed, just truncated");
    assert_eq!(fb_2001.total_lines, 2001, "the file's REAL total_lines must be reported even when truncated");
    assert!(fb_2001.truncated, "2001 lines must be reported as truncated");
    assert_eq!(fb_2001.lines.len(), 2000, "the returned content must be capped to exactly MAX_BLAME_LINES");

    // No hunk may claim coverage past the cap. start_line is 1-indexed and
    // lines_in_hunk a count, so a hunk covering lines 1..=2000 (the cap)
    // reports start_line(1) + lines_in_hunk(2000) == 2001 (an EXCLUSIVE
    // upper bound) — not 2000. Same convention the existing
    // `blame_reports_distinct_hunks_per_authoring_commit` test's own
    // `hunk_for` closure already relies on (`line < h.start_line +
    // h.lines_in_hunk`).
    let max_covered = fb_2001.hunks.iter().map(|h| h.start_line + h.lines_in_hunk).max().unwrap_or(0);
    assert!(max_covered <= 2001, "a hunk overshot the cap: {}", fmt_hunks(&fb_2001.hunks));
    // And the cap must be genuinely reached, not undershot (every line up to
    // 2000 is covered by some hunk).
    assert_eq!(max_covered, 2001, "the cap should be exactly reached, not undershot: {}", fmt_hunks(&fb_2001.hunks));
}

#[test]
fn blame_straddling_hunk_at_the_cap_is_clipped_not_overshot() {
    // A single commit's own hunk would otherwise extend from line 1981 to
    // 2010 (30 lines) — straddling the 2000 cap by 10 lines. The cap must
    // clip that hunk's reported coverage to end exactly at line 2000, never
    // silently overshoot into content that was never returned.
    let repo = TempRepo::init("blame_truncation_straddle");

    let base: String = (1..=1980).map(|i| format!("base{i}\n")).collect();
    commit_as(&repo, "Alice", "alice@example.com", "big.txt", &base, "c1: base 1980 lines");

    let mut content = base.clone();
    content.push_str(&(1981..=2010).map(|i| format!("extra{i}\n")).collect::<String>());
    let c2 = commit_as(&repo, "Bob", "bob@example.com", "big.txt", &content, "c2: append 30 more, straddling the cap");

    let fb = blame_file(repo.path(), "big.txt".to_string(), None, false).expect("blame should succeed");
    assert!(fb.truncated);
    assert_eq!(fb.lines.len(), 2000);

    let straddling = fb
        .hunks
        .iter()
        .find(|h| h.sha == c2)
        .unwrap_or_else(|| panic!("expected a hunk for the straddling commit: {}", fmt_hunks(&fb.hunks)));
    assert_eq!(
        straddling.start_line + straddling.lines_in_hunk,
        2001, // exclusive upper bound for a hunk ending at the 1-indexed cap line 2000 — see the sibling test's comment
        "the straddling hunk must be clipped to end exactly at the cap: {}",
        fmt_hunks(&fb.hunks)
    );
}

// ---------------------------------------------------------------------------
// ignoreWhitespace — verify the flag actually changes attribution, not just
// that it's accepted as a parameter.
// ---------------------------------------------------------------------------

#[test]
fn blame_ignore_whitespace_skips_a_whitespace_only_edit() {
    let repo = TempRepo::init("blame_ignore_whitespace");

    let c1 = commit_as(&repo, "Alice", "alice@example.com", "f.txt", "line1\nline2\nline3\n", "c1: original");
    // c2 changes ONLY whitespace on line 2 (a trailing space) — no real content change.
    let c2 = commit_as(&repo, "Bob", "bob@example.com", "f.txt", "line1\nline2 \nline3\n", "c2: whitespace-only edit");

    let fb_default =
        blame_file(repo.path(), "f.txt".to_string(), None, false).expect("blame (default) should succeed");
    let hunk_for = |fb: &gitcat_lib::blame::FileBlame, line: u32| {
        fb.hunks
            .iter()
            .find(|h| line >= h.start_line && line < h.start_line + h.lines_in_hunk)
            .unwrap_or_else(|| panic!("no hunk covers line {line}"))
            .sha
            .clone()
    };
    assert_eq!(
        hunk_for(&fb_default, 2),
        c2,
        "with ignoreWhitespace OFF (default), the whitespace-only edit commit should be blamed"
    );

    let fb_ignore =
        blame_file(repo.path(), "f.txt".to_string(), None, true).expect("blame (ignoreWhitespace) should succeed");
    assert_eq!(
        hunk_for(&fb_ignore, 2),
        c1,
        "with ignoreWhitespace ON, a purely-whitespace edit must be skipped through to the original authoring commit"
    );
}
