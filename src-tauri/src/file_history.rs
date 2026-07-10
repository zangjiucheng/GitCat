//! Per-file history with rename-following — every commit that touched a
//! given file across its lifetime, correctly continuing through renames
//! (`git log --follow`) rather than stopping at the file's current name.
//!
//! Read/write split: PURE READ — never calls `crate::safety::snapshot`.
//!
//! Why shell out instead of git2: `--follow` is porcelain-only logic (git's
//! own revision.c/log-tree rename-following across a whole history walk) —
//! there is no git2 Revwalk equivalent, and replicating it would mean
//! hand-rolling git's own similarity-threshold rename detection across an
//! entire log walk. Same class of problem git_merge.rs/git_remote.rs's own
//! doc comments already justify shelling out for; this module owns its own
//! small self-contained `Out`/`run_git` helper rather than importing theirs
//! (this codebase's convention — see git_remote.rs's doc comment).
//!
//! git2 IS used for everything that isn't rename-following itself: resolving
//! `at_commit`/HEAD to a full sha (via `find_commit_by_prefix`, same
//! convention as blame.rs/commands.rs), and pre-validating `file` exists as a
//! blob in that commit's tree — giving the CLI walk an exact, unambiguous
//! starting sha (never a user-supplied short prefix) and a clean refusal
//! message for a bad/typo'd path instead of git log's own silent empty
//! output (empirically confirmed: a pathspec that never existed exits 0 with
//! nothing printed, no error — see design doc's probe output).
//!
//! Parsing format: `--format=%x00%H%x00%an%x00%ae%x00%at%x00%s%x00` combined
//! with `--name-status`. NUL is the delimiter for exactly the reason git's
//! own `-z` porcelain modes use it: git forbids a real NUL byte inside commit
//! content, so it can never collide with a subject/name/email field — this
//! was verified against a subject containing literal quotes, a `%s`, and a
//! `|`, all passed through unmangled. `--follow` (no `-m`) never emits a
//! merge commit as its own row (empirically re-verified here against both a
//! treesame-to-one-parent merge and a genuine both-parents-differ conflict
//! merge) — so the name-status block for a commit is always 0 or exactly 1
//! line for this single-pathspec query; the parser takes the first
//! non-empty line and degrades gracefully (falls back to the originally-
//! queried `file` string — a fixed value for the whole walk, not stateful
//! "remember the last path we saw") if that assumption is ever violated on
//! some future git version.
//!
//! `-c core.quotePath=false` is passed on every invocation: without it, git
//! C-quotes any `--name-status` path containing a non-ASCII byte or a literal
//! quote/backslash into a `"\NNN-octal-escaped"` string (adversarially
//! confirmed: a café-résumé.txt-style rename came back as unreadable escape
//! garbage in `path`/`renamed_from` otherwise). This only affects the
//! `--name-status` path column — the NUL-delimited `%`-fields above were
//! never affected, since format placeholders aren't path-quoted.
//!
//! KNOWN, ACCEPTED UPSTREAM LIMITATION (not something this module can fix,
//! and deliberately not worked around — see the module's own "why shell out"
//! rationale above about not hand-rolling git's own rename detection):
//! `--follow` can silently drop real ancestor commits — not just the merge
//! commit itself — once a file was renamed on one side of history that a
//! merge later combines with an unrelated line of development on the other
//! side. Adversarially confirmed: a repo where a file was renamed away and
//! back on one branch while another branch edited it in parallel, then
//! merged, lost BOTH the merge commit's own row (expected/documented above)
//! AND the very first commit that created the file — with no error and no
//! `truncated: true` to signal it. This is real, upstream `git log --follow`
//! behavior (confirmed identical directly via the raw CLI, independent of
//! this module's parsing), not a parsing bug — the frontend surfaces a
//! permanent caveat about it (see FileHistory.svelte's `.fh-caveat` line)
//! rather than silently presenting a truncated list as complete.
//!
//! Cap: [`MAX_HISTORY_COMMITS`] — see its own doc comment.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::model::Person;

/// Cap on returned history entries. Duplicated (own constant, not shared —
/// see blame.rs's MAX_BLAME_LINES / commands.rs's MAX_FILES precedent) rather
/// than an app-wide shared value. A single file's own touching-commit count
/// is normally far smaller than the whole-repo graph's own 50_000 (commands::
/// DEFAULT_LIMIT): even a churn-heavy CHANGELOG.md in a decade-old, huge repo
/// rarely exceeds a few hundred to low thousands of touching commits. 2000
/// leaves comfortable headroom for that pathological case while still
/// bounding the `--follow` walk (whose per-candidate rename-similarity cost
/// makes it more expensive per commit than a plain revwalk) — passed
/// straight to `--max-count`, which stops the walk once this many *matching*
/// commits are found, independent of total repo size.
const MAX_HISTORY_COMMITS: usize = 2000;

// ---------------------------------------------------------------------------
// Payloads (local to this module — matches workdir.rs/reflog.rs/plumbing.rs's
// precedent of each feature module owning its own DTOs rather than growing
// model.rs)
// ---------------------------------------------------------------------------

/// One commit in a file's history. Mirrors `CommitMeta`'s abbreviated
/// per-row field naming (`an`, `sha`+short) rather than `BlameHunkRow`'s
/// more verbose `author`/`orig_path` — a `FileHistoryEntry` is conceptually
/// "one row of a small per-commit list", the same shape `CommitMeta` is,
/// not a per-hunk line annotation.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    pub sha: String,       // full 40-char oid
    pub short_sha: String, // 7-char prefix
    pub subject: String,   // first line of the message
    pub an: Person,        // author — n/e/t, matches CommitMeta's `an`
    pub path: String, // the file's path AT THIS COMMIT (pre-rename entries show the OLD name)
    /// Some(old_path) ONLY on the commit where `--follow` detected this
    /// path was renamed from `old_path` to `path` (an `R###` name-status
    /// line) — None on every other entry, including pre-rename ones (their
    /// `path` is already the old name; there's nothing to annotate there).
    pub renamed_from: Option<String>,
}

/// Mirrors `FileBlame`'s field-naming style (`path`, `at_sha`, `truncated`).
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileHistory {
    pub file: String, // the originally queried path
    pub at_sha: String, // resolved full commit oid the walk started from (HEAD's oid if at_commit was None)
    pub entries: Vec<FileHistoryEntry>,
    pub truncated: bool, // hit MAX_HISTORY_COMMITS
}

// ---------------------------------------------------------------------------
// Tauri command (registered in lib.rs)
// ---------------------------------------------------------------------------

/// Every commit that touched `file` across its lifetime, as of `at_commit`
/// (HEAD if `None`), continuing through renames (`git log --follow`) rather
/// than stopping at the file's current name. Read-only. Refuses cleanly for
/// a path absent from the target commit's tree or a directory-shaped path.
///
/// JS: `commands.fileHistory(path, file, atCommit)`.
#[tauri::command]
#[specta::specta]
pub fn file_history(path: String, file: String, at_commit: Option<String>) -> Result<FileHistory, String> {
    file_history_inner(&path, &file, at_commit.as_deref())
}

fn file_history_inner(path: &str, file: &str, at_commit: Option<&str>) -> Result<FileHistory, String> {
    validate_path(file)?;

    let repo = crate::trust::open_repo(path)
        .map_err(|e| format!("cannot open repository: {}", e.message()))?;

    // Same resolution convention as blame_file_inner.
    let commit = match at_commit {
        Some(sha) => repo
            .find_commit_by_prefix(sha)
            .map_err(|e| format!("Not a valid commit: {sha:?} ({})", e.message()))?,
        None => {
            let head = repo.head().map_err(|e| e.message().to_string())?;
            head.peel_to_commit().map_err(|e| e.message().to_string())?
        }
    };
    let at_sha = commit.id().to_string();
    let short_sha = short(&at_sha);

    // Existence pre-check — lighter than blame's: any blob is fine (binary
    // included; history doesn't read content), only a directory is refused.
    let tree = commit.tree().map_err(|e| e.message().to_string())?;
    let entry = tree
        .get_path(Path::new(file))
        .map_err(|_| format!("{file} does not exist at {short_sha}."))?;
    let obj = entry
        .to_object(&repo)
        .map_err(|_| format!("{file} does not exist at {short_sha}."))?;
    if obj.as_blob().is_none() {
        return Err(format!("{file} is a directory at {short_sha} — pick a file."));
    }

    let max_count_arg = format!("--max-count={}", MAX_HISTORY_COMMITS + 1);
    let out = run_git(
        path,
        &[
            // -c core.quotePath=false: without it, git C-quotes any
            // non-ASCII/quote/backslash byte in a --name-status path into a
            // "\NNN-octal-escaped" string (an adversarial review caught this
            // empirically — a real café-résumé.txt-style rename came back as
            // literal backslash-octal garbage in `path`/`renamed_from`, while
            // `--format`'s own %-placeholders are untouched since they aren't
            // path fields). This only affects the --name-status path column,
            // never the NUL-delimited %-fields above.
            "-c",
            "core.quotePath=false",
            "log",
            "--follow",
            "--name-status",
            "--format=%x00%H%x00%an%x00%ae%x00%at%x00%s%x00",
            &max_count_arg,
            "--end-of-options",
            &at_sha,
            "--",
            file,
        ],
    )?;
    if !out.ok {
        return Err(git_msg(&out));
    }

    let mut entries = parse_follow_output(&out.stdout, file);
    let truncated = entries.len() > MAX_HISTORY_COMMITS;
    if truncated {
        entries.truncate(MAX_HISTORY_COMMITS);
    }

    Ok(FileHistory {
        file: file.to_string(),
        at_sha,
        entries,
        truncated,
    })
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

/// Flag-injection/NUL guard, own copy per this codebase's per-module
/// validation convention (see git_merge.rs's validate_sha, git_remote.rs's
/// validate_remote_name). `--` already protects a `-`-prefixed path from
/// being read as an option, but this is defense in depth, and rejecting an
/// embedded NUL up front is what actually protects our own parser's
/// delimiter assumption (see module doc).
fn validate_path(file: &str) -> Result<(), String> {
    if file.trim().is_empty() {
        return Err("No file to show history for.".into());
    }
    if file.contains('\u{0}') {
        return Err("Path has an embedded NUL byte.".into());
    }
    Ok(())
}

/// Parse the NUL-delimited `--format` output. Layout confirmed empirically
/// (see design doc / module doc): splitting the whole stdout on NUL yields a
/// leading empty string, then groups of 6 per commit: sha, author name,
/// author email, author unix time, subject, and — everything up to the NEXT
/// record's leading NUL (or EOF for the last record) — that commit's raw
/// `--name-status` block (`"\n\n<status>\t<path...>\n"`).
fn parse_follow_output(raw: &str, queried_file: &str) -> Vec<FileHistoryEntry> {
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
        let diff_block = parts.next().unwrap_or("");

        let (path, renamed_from) = parse_name_status(diff_block, queried_file);

        out.push(FileHistoryEntry {
            short_sha: short(sha),
            sha: sha.to_string(),
            subject: subject.to_string(),
            an: Person {
                n: name.to_string(),
                e: email.to_string(),
                t: at,
            },
            path,
            renamed_from,
        });
    }
    out
}

/// `block` looks like `"\n\nM\tnew-name.txt\n"` or
/// `"\n\nR100\told.txt\tnew.txt\n"`. Takes the first non-empty line; a
/// rename/copy status (`R###`/`C###` — checked by PREFIX, not exact "R100",
/// since a same-commit rename+edit yields a partial similarity like "R066",
/// empirically confirmed) has 3 tab-separated fields (status, old, new);
/// anything else has 2 (status, path). Falls back to `queried_file`,
/// unrenamed, if the block is ever empty/malformed (defensive only — default
/// `--follow` never emits an empty block for a real match, see module doc).
fn parse_name_status(block: &str, queried_file: &str) -> (String, Option<String>) {
    let line = match block.lines().find(|l| !l.trim().is_empty()) {
        Some(l) => l,
        None => return (queried_file.to_string(), None),
    };
    let fields: Vec<&str> = line.split('\t').collect();
    match fields.as_slice() {
        [status, old, new] if status.starts_with('R') || status.starts_with('C') => {
            (new.to_string(), Some(old.to_string()))
        }
        [_status, p] => (p.to_string(), None),
        _ => (queried_file.to_string(), None),
    }
}
