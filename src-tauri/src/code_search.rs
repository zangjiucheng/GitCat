//! Search Code — full-text search of the current checkout (or a chosen
//! historical commit's tree), via `git grep`. Complements `pickaxe.rs`'s
//! "Search Commit Content" (`git log -S`/`-G`, which searches historical
//! DIFFS and returns matching COMMITS): this searches actual file CONTENT
//! and returns file + line + matched text.
//!
//! Read/write split: PURE READ — never calls `crate::safety::snapshot`. Owns
//! its own small `Out`/`run_git` pair (this codebase's per-module
//! convention — see `pickaxe.rs`/`file_history.rs`'s own doc comments).
//!
//! **Invocation** (every flag/ordering below empirically verified — own
//! scratch-repo probes with `od -c`, not assumed):
//! ```text
//! git grep -n -z -I -F -e <query> [-i] [--untracked] --end-of-options [<resolved-sha>]
//! ```
//! - `-n` line numbers; `-z` NUL-delimited records (see parsing below);
//!   `-I` skip binary files entirely — a match inside a binary file has a
//!   completely different, non-NUL-delimited output shape ("Binary file
//!   <path> matches"), so this sidesteps that hazard rather than trying to
//!   special-case it; `-F` literal/fixed-string (no regex — this feature's
//!   scope is plain-text search only); `-e <query>` attaches the query as
//!   its own token, safe against a leading `-` (same reasoning as
//!   `pickaxe.rs`'s `-S<query>` token-attachment).
//! - `--untracked`, working-tree search only: without it, a brand-new file
//!   that's never been `git add`ed is invisible — git grep's own default only
//!   searches paths already in the index (reading their CURRENT on-disk
//!   content), never a path with no index entry at all. Empirically
//!   confirmed combining `--untracked` with a tree-ish is REJECTED
//!   ("fatal: HEAD: no such path in the working tree" — git treats the
//!   tree-ish as an attempted pathspec instead), so it's only ever added
//!   when `at_commit` is `None`.
//! - `--end-of-options` MUST come AFTER every dash-flag, immediately before
//!   the positional tree-ish — empirically confirmed placing it any earlier
//!   breaks `-z` parsing (`fatal: option '-z' must come before non-option
//!   arguments`), unlike `pickaxe.rs`/`file_history.rs`'s own `git log`
//!   invocations, where it can sit right before the revision.
//! - No commit given → **no tree-ish argument at all** → `git grep` searches
//!   the literal **working tree** (current on-disk content, including
//!   uncommitted edits and, via `--untracked` above, brand-new files) — this
//!   matches searching "the code as it's currently checked out" more
//!   literally than a frozen HEAD-tree read would.
//! - Commit given → resolved via `repo.revparse_single` (a full revspec —
//!   `HEAD`, a branch/tag name, `HEAD~2`, a sha/short-sha, ... — unlike
//!   `pickaxe.rs`/`file_history.rs`/`blame.rs`'s own `at_commit`, which stays
//!   sha-only by deliberate choice; see their own doc comments for why —
//!   this one is typed free text from CodeSearch.svelte's own "sha/ref"
//!   field, so it has to resolve everything `git rev-parse` itself would)
//!   → the resolved full sha is passed as the tree-ish, which then prefixes
//!   every output row with `<sha>:` (see parsing below), and is also handed
//!   back to the frontend as `resolvedSha` — `openHistory`/`openBlame`
//!   (codesearch.svelte.ts) reuse it instead of the raw typed text, since
//!   `blame_file`/`file_history` themselves stay sha-only.
//!
//! **Output parsing**: with `-z`, each match is
//! `<path>\0<line-number>\0<line text>\n`, or
//! `<sha>:<path>\0<line-number>\0<line text>\n` when a tree-ish was given.
//! Since the resolved sha is already known Rust-side, it's stripped as an
//! exact known prefix — no ambiguous generic "is this a sha or a path"
//! parsing needed.
//!
//! **Exit codes**: `git grep` exits 1 with EMPTY stdout/stderr for "no
//! matches" — this is not a failure, just an empty result. Any other
//! non-zero exit (bad tree-ish, not a repository, …) is a real error. See
//! [`interpret_exit`].
//!
//! **Empty query**: same hazard class `pickaxe.rs`'s own `validate_query`
//! doc comment describes — an empty pattern silently matches every line.
//! Rejected here before argv is ever built.
//!
//! **Cap**: [`MAX_CODE_SEARCH_MATCHES`] — unlike `pickaxe.rs`/
//! `file_history.rs`'s own `--max-count` (which bounds the WHOLE walk),
//! `git grep` has no total-match early-exit (its own `-m`/`--max-count`
//! only bounds matches PER FILE), so truncation here is a post-hoc
//! `Vec::truncate` after collecting everything. Accepted as-is: `git grep`
//! is fast enough in practice (a single C-implemented linear scan) that
//! this is a non-issue for realistic repos/queries.

use serde::Serialize;
use std::process::Command;

/// Cap on returned matches — same value as `pickaxe::MAX_PICKAXE_MATCHES`/
/// `file_history::MAX_HISTORY_COMMITS`, though (per module doc) enforced
/// post-hoc rather than via `--max-count`.
const MAX_CODE_SEARCH_MATCHES: usize = 2000;

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodeSearchMatch {
    pub path: String,
    pub line: u32,
    pub text: String,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodeSearchResults {
    pub matches: Vec<CodeSearchMatch>,
    pub truncated: bool,
    /// The full sha `at_commit` resolved to, when given — `None` for a
    /// working-tree search. Lets the frontend's `openHistory`/`openBlame`
    /// (codesearch.svelte.ts) pass a real sha to `blame_file`/`file_history`
    /// (both deliberately sha-only — see this module's own doc comment)
    /// instead of the raw typed "sha/ref" text `code_search` itself accepts.
    pub resolved_sha: Option<String>,
}

/// Full-text search of `query` across `path`'s tracked files — the working
/// tree (including uncommitted edits) if `at_commit` is `None`, or that
/// commit's own tree otherwise. Read-only.
///
/// JS: `commands.codeSearch(path, query, caseSensitive, atCommit)`.
#[tauri::command]
#[specta::specta]
pub fn code_search(
    path: String,
    query: String,
    case_sensitive: bool,
    at_commit: Option<String>,
) -> Result<CodeSearchResults, String> {
    code_search_inner(&path, &query, case_sensitive, at_commit.as_deref())
}

fn code_search_inner(
    path: &str,
    query: &str,
    case_sensitive: bool,
    at_commit: Option<&str>,
) -> Result<CodeSearchResults, String> {
    validate_query(query)?;

    // Always resolved (not just when at_commit is given): this is also the
    // one place that applies the WSL/UNC auto-trust side effect (writes
    // safe.directory, which the raw `git` CLI shelled out to below reads
    // too) BEFORE any git invocation touches this path — see trust.rs.
    let repo = crate::trust::open_repo(path).map_err(|e| format!("cannot open repository: {}", e.message()))?;

    // `revparse_single`, not `find_commit_by_prefix`: unlike blame.rs/
    // file_history.rs/pickaxe.rs's own `at_commit` (always a real sha, fed
    // from a graph row — see their own doc comments for why THEY
    // deliberately stay sha-only), this one is typed free text — the UI's
    // own placeholder promises "sha/ref" (CodeSearch.svelte), so "HEAD",
    // a branch name, a tag, or "HEAD~2" must resolve here too, not just an
    // exact/abbreviated oid. `revparse_single` is a strict superset of
    // `find_commit_by_prefix` for this purpose (every sha prefix it accepted
    // still resolves) plus everything `git rev-parse` itself understands.
    let sha: Option<String> = match at_commit {
        Some(rev) => {
            let obj = repo.revparse_single(rev).map_err(|e| format!("Not a valid commit: {rev:?} ({})", e.message()))?;
            let commit =
                obj.peel_to_commit().map_err(|e| format!("Not a valid commit: {rev:?} ({})", e.message()))?;
            Some(commit.id().to_string())
        }
        None => None,
    };

    let mut args: Vec<&str> = vec!["grep", "-n", "-z", "-I", "-F", "-e", query];
    if !case_sensitive {
        args.push("-i");
    }
    // --untracked: without it, a brand-new file that's never been `git add`ed
    // is invisible to a working-tree search (empirically confirmed: git grep's
    // own default only searches paths already in the index, reading their
    // CURRENT on-disk content — an untracked file has no index entry at all).
    // Only valid for a working-tree search: empirically confirmed combining
    // it with a tree-ish is REJECTED ("fatal: HEAD: no such path in the
    // working tree" — git treats the tree-ish as an attempted pathspec).
    if sha.is_none() {
        args.push("--untracked");
    }
    args.push("--end-of-options");
    if let Some(s) = &sha {
        args.push(s);
    }

    let out = run_git(path, &args)?;
    match interpret_exit(out.ok, out.code, out.stdout.is_empty(), out.stderr.is_empty()) {
        ExitOutcome::Matches => {}
        ExitOutcome::NoMatches => {
            return Ok(CodeSearchResults { matches: Vec::new(), truncated: false, resolved_sha: sha });
        }
        ExitOutcome::Error => return Err(git_msg(&out)),
    }

    let mut matches = parse_grep_output(&out.stdout, sha.as_deref());
    let truncated = matches.len() > MAX_CODE_SEARCH_MATCHES;
    if truncated {
        matches.truncate(MAX_CODE_SEARCH_MATCHES);
    }
    Ok(CodeSearchResults { matches, truncated, resolved_sha: sha })
}

// ---------------------------------------------------------------------------
// exit-code interpretation
// ---------------------------------------------------------------------------

enum ExitOutcome {
    Matches,
    NoMatches,
    Error,
}

/// `git grep` exits 1 with empty stdout AND empty stderr specifically to mean
/// "ran fine, found nothing" — that exact combination is the only thing that
/// counts as [`ExitOutcome::NoMatches`]; a 0 exit is [`ExitOutcome::Matches`],
/// and anything else (a different non-zero code, or exit 1 with stderr — e.g.
/// git itself printing a warning alongside a real failure) is
/// [`ExitOutcome::Error`].
fn interpret_exit(success: bool, code: Option<i32>, stdout_empty: bool, stderr_empty: bool) -> ExitOutcome {
    if success {
        return ExitOutcome::Matches;
    }
    if code == Some(1) && stdout_empty && stderr_empty {
        return ExitOutcome::NoMatches;
    }
    ExitOutcome::Error
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

/// Parse `-z`-delimited `git grep` output — see module doc for the exact
/// empirically-verified layout. `sha`, when `Some`, is stripped as an exact
/// known prefix (`"<sha>:"`) from the path field — no generic/ambiguous
/// "is this a sha or a path" parsing needed, since the caller already knows
/// precisely which sha it asked git to prefix every row with.
fn parse_grep_output(raw: &str, sha: Option<&str>) -> Vec<CodeSearchMatch> {
    let prefix = sha.map(|s| format!("{s}:"));
    let mut out = Vec::new();
    for record in raw.split('\n') {
        if record.is_empty() {
            continue; // the trailing "\n" after the last real record
        }
        let mut parts = record.splitn(3, '\u{0}');
        let mut path = match parts.next() {
            Some(p) => p.to_string(),
            None => continue,
        };
        let line: u32 = match parts.next().and_then(|s| s.trim().parse().ok()) {
            Some(n) => n,
            None => continue,
        };
        let text = parts.next().unwrap_or("").to_string();

        if let Some(p) = &prefix {
            if let Some(stripped) = path.strip_prefix(p.as_str()) {
                path = stripped.to_string();
            }
        }

        out.push(CodeSearchMatch { path, line, text });
    }
    out
}

// ---------------------------------------------------------------------------
// git CLI runner (own copy — see module doc's "one small self-contained
// helper per module" convention)
// ---------------------------------------------------------------------------

struct Out {
    ok: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run_git(path: &str, args: &[&str]) -> Result<Out, String> {
    let o = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    Ok(Out {
        ok: o.status.success(),
        code: o.status.code(),
        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&o.stderr).trim().to_string(),
    })
}

fn git_msg(o: &Out) -> String {
    if !o.stderr.is_empty() {
        o.stderr.clone()
    } else {
        format!("git exited with status {:?}", o.code)
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Same NUL/empty guard shape as `pickaxe.rs`'s own `validate_query` — an
/// empty pattern silently matches every line (git grep's own hazard), and a
/// literal embedded NUL would corrupt this module's own delimiter parsing.
fn validate_query(query: &str) -> Result<(), String> {
    if query.is_empty() {
        return Err("Enter something to search for.".into());
    }
    if query.contains('\u{0}') {
        return Err("Search text has an embedded NUL byte.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_query_rejects_only_empty_and_nul() {
        assert!(validate_query("").is_err());
        assert!(validate_query("\u{0}").is_err());
        assert!(validate_query("-leading-dash-is-fine").is_ok());
        assert!(validate_query("normal query").is_ok());
    }

    #[test]
    fn interpret_exit_success_is_matches() {
        assert!(matches!(interpret_exit(true, Some(0), false, true), ExitOutcome::Matches));
    }

    #[test]
    fn interpret_exit_code_1_with_empty_output_is_no_matches() {
        assert!(matches!(interpret_exit(false, Some(1), true, true), ExitOutcome::NoMatches));
    }

    #[test]
    fn interpret_exit_code_1_with_stderr_is_still_an_error() {
        // e.g. a warning alongside a real failure — the empty-stdout/empty-stderr
        // combination is the ONLY thing that means "ran fine, found nothing".
        assert!(matches!(interpret_exit(false, Some(1), true, false), ExitOutcome::Error));
    }

    #[test]
    fn interpret_exit_other_nonzero_code_is_an_error() {
        assert!(matches!(interpret_exit(false, Some(128), true, false), ExitOutcome::Error));
    }

    #[test]
    fn parse_grep_output_without_sha_prefix_is_the_working_tree_shape() {
        let raw = "src/a.rs\u{0}10\u{0}fn main() {}\nsrc/b.rs\u{0}2\u{0}let x = 1;\n";
        let matches = parse_grep_output(raw, None);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].path, "src/a.rs");
        assert_eq!(matches[0].line, 10);
        assert_eq!(matches[0].text, "fn main() {}");
        assert_eq!(matches[1].path, "src/b.rs");
        assert_eq!(matches[1].line, 2);
        assert_eq!(matches[1].text, "let x = 1;");
    }

    #[test]
    fn parse_grep_output_strips_the_known_sha_prefix() {
        let sha = "abc123abc123abc123abc123abc123abc123abcd";
        let raw = format!("{sha}:src/a.rs\u{0}10\u{0}fn main() {{}}\n");
        let matches = parse_grep_output(&raw, Some(sha));
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, "src/a.rs");
        assert_eq!(matches[0].line, 10);
    }

    #[test]
    fn parse_grep_output_ignores_the_trailing_newline_after_the_last_record() {
        let raw = "src/a.rs\u{0}1\u{0}one\n";
        assert_eq!(parse_grep_output(raw, None).len(), 1);
    }

    #[test]
    fn parse_grep_output_of_empty_stdout_is_an_empty_list() {
        assert!(parse_grep_output("", None).is_empty());
    }
}
