//! fsck-based dangling-object recovery (backlog #13) — list commits `git
//! fsck` finds with no ref (branch/tag) OR reflog pointing at them anymore (a
//! hard reset, an amend, a dropped rebase commit, a deleted branch, …), so
//! the user can recover one by creating a new branch at it.
//!
//! Read/write split: PURE READ — never calls `crate::safety::snapshot`.
//! Recovery itself is NOT a new mutation: it's `git_write::create_branch`
//! (already exists, already snapshots-first + dirty-tree-guards on its own
//! `checkout:true` path) called with the dangling commit's full sha as
//! `start_point` — see below for why nothing new is needed there.
//!
//! Why shell out instead of git2: fsck's reachability walk (which objects are
//! NOT reachable from any ref, discounting reflogs) is porcelain-only logic
//! with no git2 Odb/Repository equivalent — same class of problem
//! file_history.rs/pickaxe.rs's own doc comments already justify shelling
//! out for. Own small self-contained `Out`/`run_git` helper, per this
//! codebase's per-module convention (see file_history.rs/pickaxe.rs).
//!
//! EXACT INVOCATION (empirically settled — verified against a real hard
//! reset in a throwaway repo, git 2.51.0 on this machine; also re-confirmed
//! against a reachable HEAD correctly being excluded, and that
//! `create_branch`'s own `git branch --end-of-options <name> <sha>`
//! invocation makes the commit stop appearing as dangling immediately after):
//! `git fsck --dangling --no-reflogs`.
//!   - `--no-reflogs` is NOT optional: by default `git fsck` treats every
//!     ref's reflog as an extra reachability root, so a commit stranded
//!     moments ago by a hard reset/amend is still "reachable" via HEAD's own
//!     reflog for up to 90 days (`gc.reflogExpire`'s default) — without this
//!     flag, this feature would show almost nothing for its own stated use
//!     cases. Empirically confirmed: plain `git fsck --dangling` found
//!     NOTHING right after a real `git reset --hard HEAD~1`; adding
//!     `--no-reflogs` immediately surfaced the discarded commit.
//!   - `--dangling`, NOT `--unreachable`: `--unreachable` is a superset that
//!     also includes objects pointed to by ANOTHER unreachable object (e.g.
//!     the pre-amend commit, which is the amend-discarded tip's own parent)
//!     — not a useful separate recovery candidate, since recovering the TIP
//!     already carries that ancestor along. `--dangling` correctly omits
//!     such non-tip ancestors.
//!
//! PARSING (no `--format=` exists for fsck, unlike `git log` — this line
//! shape is the only interface, empirically confirmed stable): one object
//! per line, `"dangling <type> <sha40>\n"`, `<type>` in
//! {commit, tree, blob, tag}. We only ever want `commit` — a bare dangling
//! tree/blob isn't independently useful to show, and `--dangling` already
//! means every commit-type line here IS a real tip candidate. Filter is a
//! plain `strip_prefix("dangling commit ")`.
//!
//! OVERLAP WITH REFLOG RESCUE (reflog.rs): NOT a clean partition, and
//! expected to be the COMMON case rather than the exception — precisely
//! because of the `--no-reflogs` point above, most commits this surfaces
//! from a recent HEAD-affecting mistake will ALSO already be in Reflog
//! Rescue's list (which reads HEAD's own reflog). This feature's unique
//! value is (a) commits with no reflog trace anywhere (created via plumbing,
//! or already reflog-expired) and (b) commits only recorded in some OTHER
//! ref's reflog (Reflog Rescue only ever reads HEAD's). The frontend must
//! not claim this list is "everything Reflog Rescue can't reach" — it's fine
//! for the same commit to appear in both.
//!
//! NO CAP NEEDED ON THE INVOCATION ITSELF (unlike file_history.rs/
//! pickaxe.rs's `--max-count`): fsck always walks the whole object database
//! regardless, and there's no flag to bound that — but dangling COMMITS
//! specifically are inherently a small set. [`MAX_DANGLING`] still caps the
//! RESULT list, purely as defense-in-depth (never expected to bind in
//! practice) — matching this codebase's general habit of always having a cap
//! constant somewhere.
//!
//! RESOLUTION: each candidate sha -> a full commit via
//! `find_commit_by_prefix` (same convention as blame.rs/file_history.rs/
//! pickaxe.rs) — this works fine for an object with zero refs pointing at
//! it, since git2 reads the odb directly (the same way `git cat-file`/
//! `git show` can read a dangling object). A resolution failure for one sha
//! is skipped, never fails the whole list (defensive — should never actually
//! happen since fsck already told us it's a commit).
//!
//! NO NEW MUTATION COMMAND: recovery is `git_write::create_branch(path,
//! name, Some(dangling_sha), checkout)` AS-IS — empirically confirmed
//! against a real dangling sha in a throwaway repo: `git branch
//! --end-of-options <name> <sha>` (the exact non-checkout invocation
//! `create_branch` already runs) succeeds cleanly, and the commit is no
//! longer "dangling" afterward (a real ref now points to it). `create_branch`
//! already snapshots first and dirty-tree-guards its `checkout:true` path —
//! the exact same safety shape this backlog item asks for — so there is
//! nothing to add here.
//!
//! Unlike `reflog_restore`, no "re-validate against a fresh read before
//! mutating" step is needed here: reflog addressing is by ORDINAL INDEX
//! (`HEAD@{i}`), which can silently mean a DIFFERENT commit if the reflog
//! changes between list and click (a real wrong-target risk) — this feature
//! addresses by full, immutable SHA, so the only possible staleness is "the
//! object got gc'd meanwhile," which `create_branch`'s own git invocation
//! already fails on cleanly and safely (`ok:false` + git's own message).

use serde::Serialize;

use crate::model::Person;

/// Defense-in-depth cap on the returned list — see module doc; not expected
/// to ever bind (dangling commits are inherently a small set).
const MAX_DANGLING: usize = 500;

// ---------------------------------------------------------------------------
// Payloads (mirrors PickaxeMatch/FileHistoryEntry's abbreviated per-row shape
// exactly — "one row of a small per-commit list", nothing file/diff-specific
// to add on top)
// ---------------------------------------------------------------------------

/// One dangling commit found via `git fsck --dangling --no-reflogs` — a real
/// recovery candidate (see module doc for why exactly this flag pair).
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DanglingCommit {
    pub sha: String,       // full 40-char oid
    pub short_sha: String, // 7-char prefix
    pub subject: String,   // first line of the message
    pub an: Person,        // author — n/e/t, matches CommitMeta's/FileHistoryEntry's/PickaxeMatch's `an`
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DanglingCommits {
    pub commits: Vec<DanglingCommit>,
    pub truncated: bool, // hit MAX_DANGLING (defense-in-depth only, see module doc)
}

// ---------------------------------------------------------------------------
// Tauri command (registered in lib.rs)
// ---------------------------------------------------------------------------

/// Every commit `git fsck --dangling --no-reflogs` finds, newest-author-date-
/// first (fsck's own line order is an artifact of internal object/hash
/// iteration, not chronological). Read-only.
///
/// JS: `commands.danglingCommits(path)` -> `Result<DanglingCommits, string>`.
///
/// BUG FIX: was a plain (non-async) `fn` — a `#[tauri::command]` in that
/// shape runs INLINE on Tauri's main thread, the same thread driving the
/// window's event loop and every other command's IPC delivery. This
/// command's body both opens the repo with git2 AND shells out to `git
/// fsck --dangling --no-reflogs`, which (per the module doc above) always
/// walks the ENTIRE object database with no way to bound the walk — on a
/// large/old repo that stalls for real seconds and freezes the whole app
/// window, not just this recovery panel. `async fn` + `run_blocking` moves
/// that work onto Tauri's blocking-task thread pool, matching
/// `repo_summary`'s own established fix for the same shape (inner already
/// returns `Result<T, String>`, so no extra `map_err` is needed here).
#[tauri::command]
#[specta::specta]
pub async fn dangling_commits(path: String) -> Result<DanglingCommits, String> {
    crate::blocking::run_blocking(move || dangling_commits_inner(&path)).await
}

fn dangling_commits_inner(path: &str) -> Result<DanglingCommits, String> {
    let repo = crate::trust::open_repo(path)
        .map_err(|e| format!("cannot open repository: {}", e.message()))?;

    let out = run_git(path, &["fsck", "--dangling", "--no-reflogs"])?;
    if !out.ok {
        return Err(git_msg(&out));
    }

    let mut commits: Vec<DanglingCommit> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for sha in parse_dangling_commit_shas(&out.stdout) {
        if !seen.insert(sha.clone()) {
            continue; // defensive de-dup; never observed a real duplicate line
        }
        if let Ok(commit) = repo.find_commit_by_prefix(&sha) {
            let full = commit.id().to_string();
            let sig = commit.author();
            commits.push(DanglingCommit {
                short_sha: short(&full),
                sha: full,
                subject: commit.summary().unwrap_or("").to_string(),
                an: Person {
                    n: sig.name().unwrap_or("").to_string(),
                    e: sig.email().unwrap_or("").to_string(),
                    t: sig.when().seconds(),
                },
            });
        }
        // else: skip — a resolution failure here would mean fsck's own
        // "commit" typing was wrong, never observed; one bad row must never
        // fail the whole list.
    }

    // Newest first — see module doc.
    commits.sort_by(|a, b| b.an.t.cmp(&a.an.t));

    let truncated = commits.len() > MAX_DANGLING;
    if truncated {
        commits.truncate(MAX_DANGLING);
    }

    Ok(DanglingCommits { commits, truncated })
}

// ---------------------------------------------------------------------------
// git CLI runner (own copy — see module doc's "one small self-contained
// helper per module" convention, same as file_history.rs/pickaxe.rs)
// ---------------------------------------------------------------------------

struct Out {
    ok: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// `LC_ALL=C`/`LANGUAGE=""`: fsck's "dangling"/"commit" keywords are plain
/// English porcelain strings that (like every other git CLI message) are
/// gettext-translatable — without locale-pinning, a non-English git install
/// could silently produce zero parsed rows with no error at all.
fn run_git(path: &str, args: &[&str]) -> Result<Out, String> {
    let o = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("LC_ALL", "C")
        .env("LANGUAGE", "")
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

/// Parse `git fsck --dangling --no-reflogs`'s stdout: one object per line,
/// `"dangling <type> <sha40>"`. Empirically confirmed exact shape — filters
/// to `commit`-type lines only (see module doc for why, not `--unreachable`'s
/// superset).
fn parse_dangling_commit_shas(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|l| l.strip_prefix("dangling commit "))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}
