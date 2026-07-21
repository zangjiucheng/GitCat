//! Pickaxe / diff-content search — every commit in (a subset of) history
//! whose DIFF touched a given string or pattern: `git log -S<string>`
//! (occurrence-COUNT-change search) and `git log -G<regex>` (any added/
//! removed diff LINE matches, regardless of count) exposed as two distinct,
//! non-interchangeable modes — NOT one merged "search string + regex
//! toggle" (empirically confirmed: a commit that reorders two already-
//! matching lines without changing how many match changes the -G result
//! but never the -S one — see design doc probe transcript).
//!
//! Read/write split: PURE READ — never calls `crate::safety::snapshot`.
//!
//! Why shell out instead of git2: `-S`/`-G` are porcelain pickaxe logic
//! (diffcore's own occurrence-count / added-removed-line matching across a
//! full revision walk) — no git2 Revwalk equivalent exists, same class of
//! problem file_history.rs's own doc comment already justifies shelling
//! out for. This module owns its own small self-contained `Out`/`run_git`
//! helper rather than importing another module's (this codebase's
//! convention — see git_remote.rs's doc comment). git2 is used only for
//! resolving `at_commit`/HEAD to a full sha via `find_commit_by_prefix`
//! (same convention as blame.rs/file_history.rs), giving the CLI walk an
//! exact starting point instead of a user-supplied short prefix.
//!
//! Unlike file_history.rs this needs none of `--follow`/`--name-status`/
//! rename-tracking: there's no single file whose renames to chase and no
//! per-commit path column to parse — a hit is reported exactly like a
//! plain `git log`'s own commit metadata, nothing more (see
//! [`parse_pickaxe_output`]).
//!
//! Parsing format: `--format=%x00%H%x00%an%x00%ae%x00%at%x00%s%x00`, same
//! NUL-delimiter convention/reasoning as file_history.rs. Empirically
//! confirmed (own scratch-repo probe, byte-verified with `od -c`, not
//! assumed): with this format and NO `--name-status`, git's own "tformat"
//! terminator semantics append a literal `"\n"` after every commit's own
//! trailing `%x00` — so splitting stdout on NUL yields groups of SIX
//! segments per commit record (sha, author name, author email, author unix
//! time, subject, and a 6th throwaway segment that is always exactly that
//! trailing `"\n"`, never meaningful) — the same 6-groups-per-record shape
//! file_history.rs's own parser uses, except the 6th group is discarded
//! here instead of holding a real name-status block.
//!
//! GIT SEMANTICS (empirically verified in a scratch repo with a commit that
//! ADDS a matching occurrence, one that REMOVES one, one that REORDERS two
//! already-matching lines without changing the count, and one only
//! reachable via a non-HEAD branch):
//!   - `-S<string>` matches a commit only when the NUMBER of occurrences of
//!     `string` changed between the commit and its parent — reordering
//!     matching lines without changing that count does NOT match. Literal
//!     by default (`-S'hello.world'` does not match a literal "hello
//!     world" line); `--pickaxe-regex` (order relative to `-S` doesn't
//!     matter) turns it into a regex too.
//!   - `-G<regex>` matches if ANY added/removed diff line matches the
//!     regex — always regex, no literal mode, count-agnostic (this is the
//!     mode that catches the "reorder" commit -S misses).
//!     `--pickaxe-regex` combined with `-G` is REJECTED BY GIT ITSELF
//!     (`fatal: options '-G' and '--pickaxe-regex' cannot be used
//!     together...`) — so `regex` is silently ignored for `"diff-match"`
//!     mode (see [`pickaxe_flag`]), never forwarded regardless of its
//!     value: the frontend's own form never renders that checkbox for this
//!     mode, so a stray `true` reaching here is an irrelevant field, not
//!     really a caller error worth a hard rejection.
//!   - No `--` pathspec searches the WHOLE repo; a trailing `-- <path>`
//!     scopes to one file/directory like any git log pathspec.
//!   - `--all` walks every ref, not just the resolved starting commit's own
//!     ancestry (confirmed: a branch-only commit is invisible without it,
//!     visible with it, in either mode).
//!
//! EMPTY QUERY — the one genuinely dangerous case; see [`validate_query`]'s
//! own doc comment for the full empirical reasoning. Rejected here BEFORE
//! argv is ever built, never left for git's own CLI to reject.
//!
//! Cap: [`MAX_PICKAXE_MATCHES`] — see its own doc comment.

use serde::Serialize;
use std::process::Command;

use crate::model::Person;

/// Cap on returned matches. Kept at the SAME value as file_history.rs's own
/// `MAX_HISTORY_COMMITS` (2000) — deliberately NOT raised despite this
/// module walking the whole repo history rather than one file's own
/// touching commits (a plausibly much bigger candidate set: a common
/// token/regex can realistically match many thousands of commits in a
/// large old repo). Two reasons this doesn't argue for a bigger cap:
///   1. `--max-count` is confirmed (own scratch-repo probe) to bound
///      MATCHING commits found, not commits examined — `--max-count=2`
///      against a query with 4 real matches returned the 2 *nearest actual
///      matches*, not the first 2 commits in walk order. So the cap
///      already does the right thing regardless of its numeric value;
///      raising it doesn't help the one case that's actually slow (a RARE
///      query, where git must walk the entire reachable history to prove
///      there are no more hits, cap or no cap).
///   2. More than ~2000 matches isn't a useful flat list for a human to
///      scan anyway — the fix for hitting this cap is a narrower query (a
///      more specific string/regex, or the optional path scope), surfaced
///      via `truncated: true`, same reading as file_history.rs's own cap.
const MAX_PICKAXE_MATCHES: usize = 2000;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// One matching commit. Mirrors `FileHistoryEntry`'s abbreviated per-row
/// naming, minus `path`/`renamed_from` — pickaxe does no rename-tracking
/// and has no single queried path to report per row (the OPTIONAL `file`
/// scope, when given, is the same for every row and already known to the
/// caller).
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PickaxeMatch {
    pub sha: String,       // full 40-char oid
    pub short_sha: String, // 7-char prefix
    pub subject: String,   // first line of the message
    pub an: Person,        // author — n/e/t, matches CommitMeta's/FileHistoryEntry's `an`
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PickaxeResults {
    pub entries: Vec<PickaxeMatch>,
    pub truncated: bool, // hit MAX_PICKAXE_MATCHES
}

// ---------------------------------------------------------------------------
// Tauri command (registered in lib.rs)
// ---------------------------------------------------------------------------

/// Every commit whose diff touched `query`, walking `at_commit`'s ancestry
/// (HEAD if `None`) or every ref if `all_refs` — `git log -S<query>` when
/// `mode == "added-removed"` (occurrence-COUNT-change search; `regex` turns
/// `query` into a regex too), or `git log -G<query>` when
/// `mode == "diff-match"` (any added/removed diff LINE matches the regex —
/// always regex; `regex` is ignored, see module doc). Optionally scoped to
/// `file`. Read-only.
///
/// JS: `commands.pickaxeSearch(path, query, mode, regex, allRefs, file, atCommit)`.
///
/// BUG FIX: was a plain (non-async) `fn` — per `blocking.rs`'s own doc
/// comment, that runs INLINE on Tauri's main thread. This command's body
/// shells out to `git log -S`/`-G` over the FULL revision history (optionally
/// every ref, via `--all`) and additionally opens the repo with git2 to
/// resolve `at_commit`/HEAD — on a large or old repo, or a common token that
/// matches thousands of commits, that walk is exactly the kind of cost that
/// scales with repo size `blocking.rs` warns about, and it froze the entire
/// app window (not just the pickaxe search panel) for as long as it ran.
/// `async fn` + `run_blocking` moves the work onto Tauri's blocking-task
/// thread pool, matching `dashboard_repo_status`/`workdir_status`'s already
/// established fix.
#[tauri::command]
#[specta::specta]
pub async fn pickaxe_search(
    path: String,
    query: String,
    mode: String,
    regex: bool,
    all_refs: bool,
    file: Option<String>,
    at_commit: Option<String>,
) -> Result<PickaxeResults, String> {
    crate::blocking::run_blocking(move || {
        pickaxe_search_inner(&path, &query, &mode, regex, all_refs, file.as_deref(), at_commit.as_deref())
    })
    .await
}

fn pickaxe_search_inner(
    path: &str,
    query: &str,
    mode: &str,
    regex: bool,
    all_refs: bool,
    file: Option<&str>,
    at_commit: Option<&str>,
) -> Result<PickaxeResults, String> {
    validate_query(query)?;
    let file = match file {
        Some(f) if !f.trim().is_empty() => {
            validate_file(f)?;
            Some(f)
        }
        _ => None,
    };
    let pickaxe_args = pickaxe_flag(mode, query, regex)?;

    // Starting point only matters when NOT walking every ref: --all makes a
    // single positional revision moot (confirmed — `--all --end-of-options`
    // with nothing else following is a legal, complete invocation), so
    // `at_commit` is simply not resolved/consulted when `all_refs` is set.
    // No error either — same "irrelevant, not nonsensical" shape of
    // decision as mode/regex above.
    let at_sha: Option<String> = if all_refs {
        None
    } else {
        let repo = crate::trust::open_repo(path).map_err(|e| format!("cannot open repository: {}", e.message()))?;
        let commit = match at_commit {
            Some(sha) => repo
                .find_commit_by_prefix(sha)
                .map_err(|e| format!("Not a valid commit: {sha:?} ({})", e.message()))?,
            None => {
                let head = repo.head().map_err(|e| e.message().to_string())?;
                head.peel_to_commit().map_err(|e| e.message().to_string())?
            }
        };
        // Existence pre-check for `file`, mirroring file_history.rs's own
        // identical guard — an adversarial review caught that without it, a
        // typo'd path is silently indistinguishable from "your query
        // legitimately has zero matches" (empirically confirmed: `git log
        // -S<query> ... -- nonexistent/path.txt` exits 0 with empty stdout,
        // no error at all). Only meaningful with a single definite `at_sha`
        // to check a tree against — skipped entirely under `--all`, where
        // there's no one tree "the file" could exist in (see the module's
        // own reasoning above for why `at_commit` itself is similarly moot
        // there).
        if let Some(f) = file {
            let short = short(&commit.id().to_string());
            let tree = commit.tree().map_err(|e| e.message().to_string())?;
            if tree.get_path(std::path::Path::new(f)).is_err() {
                return Err(format!("{f} does not exist at {short}."));
            }
        }
        Some(commit.id().to_string())
    };

    let max_count_arg = format!("--max-count={}", MAX_PICKAXE_MATCHES + 1);
    let mut args: Vec<&str> = vec!["log", "--format=%x00%H%x00%an%x00%ae%x00%at%x00%s%x00", &max_count_arg];
    for a in &pickaxe_args {
        args.push(a);
    }
    if all_refs {
        args.push("--all");
    }
    args.push("--end-of-options");
    if let Some(sha) = &at_sha {
        args.push(sha);
    }
    if let Some(f) = file {
        args.push("--");
        args.push(f);
    }

    let out = run_git(path, &args)?;
    if !out.ok {
        return Err(git_msg(&out));
    }

    let mut entries = parse_pickaxe_output(&out.stdout);
    let truncated = entries.len() > MAX_PICKAXE_MATCHES;
    if truncated {
        entries.truncate(MAX_PICKAXE_MATCHES);
    }

    Ok(PickaxeResults { entries, truncated })
}

// ---------------------------------------------------------------------------
// argv construction
// ---------------------------------------------------------------------------

/// Builds the `-S<query>`/`-G<query>` [+ `--pickaxe-regex`] argv piece as
/// ONE attached token per flag (never `.arg("-S").arg(query)` as two
/// separate elements) — see [`validate_query`]'s doc comment for exactly
/// why the attached form is the only one structurally safe regardless of
/// what `query` looks like.
fn pickaxe_flag(mode: &str, query: &str, regex: bool) -> Result<Vec<String>, String> {
    match mode {
        "added-removed" => {
            let mut v = vec![format!("-S{query}")];
            if regex {
                v.push("--pickaxe-regex".to_string());
            }
            Ok(v)
        }
        // -G is unconditionally regex; git itself rejects --pickaxe-regex
        // paired with -G (see module doc) — `regex` is deliberately never
        // forwarded here, whatever its value.
        "diff-match" => Ok(vec![format!("-G{query}")]),
        other => Err(format!(
            "Unknown pickaxe mode: {other:?} (expected \"added-removed\" or \"diff-match\")."
        )),
    }
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

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// `query` becomes part of a single `-S<query>`/`-G<query>` argv TOKEN, not
/// a separate positional argument the way a revision/path is — a
/// structurally different injection shape from `validate_rev`'s usual
/// "reject a leading dash" guard (patch.rs/git_rebase.rs), so it needs its
/// own reasoning rather than copy-pasting that pattern:
///   - A non-empty query is safe VERBATIM, no matter its content, including
///     a leading `-` or literally `--all`/`--end-of-options` — empirically
///     confirmed (`-S-foo-flag-like-string`, `-S--all` both correctly
///     treated as the search string, never re-parsed as a second flag),
///     because attaching it directly as one token makes it structurally
///     impossible for git's option parser to see a token boundary there.
///     No "reject a leading dash" guard is needed OR correct here.
///   - An EMPTY query is the actually dangerous case, for a reason
///     unrelated to the usual flag-injection shape: `format!("-S{q}")`
///     with `q == ""` collapses to the bare token `"-S"`, INDISTINGUISHABLE
///     from git's side from someone invoking the free-standing/detached
///     `-S <value>` form — so git happily consumes WHATEVER ARGV ELEMENT
///     COMES NEXT in our own array (`--all`, `--end-of-options`, the
///     resolved commit sha, or `--`) as the search string, and exits 0
///     with a silently-empty (never-matching) result — NOT an error.
///     Empirically confirmed two ways (`git log -S --end-of-options HEAD
///     --` and `git log -S HEAD` both exit 0, print nothing). Rejected
///     HERE, before argv is ever built — git's own CLI only rejects the
///     degenerate case where *nothing at all* follows `-S`, which never
///     happens in this module's own real argv (something always follows).
fn validate_query(query: &str) -> Result<(), String> {
    if query.is_empty() {
        return Err("Enter something to search for.".into());
    }
    if query.contains('\u{0}') {
        return Err("Search text has an embedded NUL byte.".into());
    }
    Ok(())
}

/// `file`, when given, reaches git as a pathspec strictly AFTER a literal
/// `--` (never omitted when `file` is `Some`), which already makes a
/// leading `-` in it inert (git's own universal "everything after `--` is
/// a path, never an option" rule) — so, unlike `query`, this only needs
/// file_history.rs's own `validate_path`-style NUL guard, not a
/// leading-dash check.
fn validate_file(file: &str) -> Result<(), String> {
    if file.contains('\u{0}') {
        return Err("Path has an embedded NUL byte.".into());
    }
    Ok(())
}

/// Parse the NUL-delimited `--format` output — see module doc's
/// empirically-confirmed 6-groups-per-commit layout (sha, author name,
/// author email, author unix time, subject, and a 6th throwaway segment
/// that is always exactly the trailing `"\n"` git's own tformat
/// terminator appends — file_history.rs's identically-shaped parser
/// instead keeps that 6th segment as a real name-status block).
fn parse_pickaxe_output(raw: &str) -> Vec<PickaxeMatch> {
    let mut parts = raw.split('\u{0}');
    parts.next(); // the empty string before the very first record's leading NUL
    let mut out = Vec::new();
    loop {
        let sha = match parts.next() {
            Some(s) if !s.is_empty() => s,
            _ => break,
        };
        let name = parts.next().unwrap_or("");
        let email = parts.next().unwrap_or("");
        let at: i64 = parts.next().unwrap_or("0").trim().parse().unwrap_or(0);
        let subject = parts.next().unwrap_or("");
        parts.next(); // throwaway trailing "\n" terminator — see module doc

        out.push(PickaxeMatch {
            short_sha: short(sha),
            sha: sha.to_string(),
            subject: subject.to_string(),
            an: Person { n: name.to_string(), e: email.to_string(), t: at },
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_query_rejects_only_empty_and_nul() {
        assert!(validate_query("").is_err());
        assert!(validate_query("\u{0}").is_err());
        assert!(validate_query("-leading-dash-is-fine").is_ok());
        assert!(validate_query("--all").is_ok());
    }

    #[test]
    fn pickaxe_flag_added_removed_with_and_without_regex() {
        assert_eq!(pickaxe_flag("added-removed", "foo", false).unwrap(), vec!["-Sfoo"]);
        assert_eq!(pickaxe_flag("added-removed", "foo", true).unwrap(), vec!["-Sfoo", "--pickaxe-regex"]);
    }

    #[test]
    fn pickaxe_flag_diff_match_never_forwards_pickaxe_regex() {
        assert_eq!(pickaxe_flag("diff-match", "foo", false).unwrap(), vec!["-Gfoo"]);
        assert_eq!(pickaxe_flag("diff-match", "foo", true).unwrap(), vec!["-Gfoo"]); // regex ignored
    }

    #[test]
    fn pickaxe_flag_rejects_unknown_mode() {
        assert!(pickaxe_flag("bogus", "foo", false).is_err());
    }

    #[test]
    fn parse_pickaxe_output_parses_multiple_records() {
        let raw = "\u{0}aaa\u{0}Ada\u{0}a@x.com\u{0}100\u{0}subject one\u{0}\n\u{0}bbb\u{0}Bob\u{0}b@x.com\u{0}200\u{0}subject two\u{0}\n";
        let entries = parse_pickaxe_output(raw);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].sha, "aaa");
        assert_eq!(entries[0].subject, "subject one");
        assert_eq!(entries[1].sha, "bbb");
    }
}
