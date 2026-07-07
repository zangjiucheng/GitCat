//! Conflict inspection + per-file resolution (M2b conflict resolver).
//!
//! Read/write split (see git_read.rs / git_write.rs):
//!   * [`conflict_status`] is a READ — it inspects the index conflict stages with
//!     git2 (no mutation), so it uses libgit2 like the rest of the read path.
//!   * [`resolve_conflict_file`] is a WRITE — it shells out to the git CLI
//!     (`git checkout --ours|--theirs -- <file>` then `git add -- <file>`).
//!
//! Snapshot policy: resolve_conflict_file does NOT snapshot. It only ever runs
//! *inside* an already-in-progress operation (cherry-pick/merge/rebase) that was
//! snapshotted before it began, and `<op> --abort` fully restores the pre-op
//! state — so per-file resolution is always recoverable without a second backup.
//! (The enclosing cherry-pick command owns the snapshot; this composes with its
//! continue/abort.)

use git2::{IndexConflict, IndexEntry, Repository, RepositoryState};
use serde::Serialize;

use crate::safety::{self, GitOut};

/// Per-side line cap: a conflicted vendored/generated file can't blow up the
/// payload. Beyond this we keep the first N lines and append a truncation marker.
const CAP_LINES: usize = 400;

/// Upper bound on how many conflicted files we ship in one status call, so a
/// pathological mass-conflict can't stall the UI. Rarely hit in practice.
const MAX_FILES: usize = 200;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// One conflicted file, with the three merge stages as text.
///
/// `base` = stage 1 (common ancestor), `ours` = stage 2 (HEAD / current branch),
/// `theirs` = stage 3 (the incoming commit — during a cherry-pick, the picked
/// commit). A side that is **absent** (e.g. add/add has no base; delete/modify
/// has no ours or theirs) is the empty string; a **binary** side is the marker
/// `"‹binary›"`. Each side is UTF-8-lossy and capped to [`CAP_LINES`].
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub ours: String,
    pub base: String,
    pub theirs: String,
}

/// Result of [`conflict_status`]. `op` is one of
/// `"cherry-pick" | "merge" | "rebase" | "revert" | "none"`. `in_progress` is
/// true whenever a sequencer op is underway **or** there are unmerged files —
/// so once every file is resolved (`files` empty) but the cherry-pick has not
/// been continued yet, `in_progress` stays true and the UI can offer Continue.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictStatus {
    pub in_progress: bool,
    pub op: String,
    pub files: Vec<ConflictFile>,
}

/// Result of [`resolve_conflict_file`]. `remaining` is the count of files still
/// unmerged after this resolution (0 means the tree is ready to Continue).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResult {
    pub ok: bool,
    pub remaining: usize,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Command: conflict_status  (READ — git2 index inspection)
// ---------------------------------------------------------------------------

/// Report the in-progress operation and the conflicted files (with all three
/// merge stages). Read-only. JS: `invoke("conflict_status", { path })`.
#[tauri::command]
pub fn conflict_status(path: String) -> Result<ConflictStatus, String> {
    let repo =
        Repository::open(&path).map_err(|e| format!("cannot open repository: {}", e.message()))?;
    let op = op_name(repo.state());
    let files = read_conflicts(&repo).map_err(|e| e.message().to_string())?;
    let in_progress = op != "none" || !files.is_empty();
    Ok(ConflictStatus { in_progress, op: op.to_string(), files })
}

/// Map libgit2's repository state to the resolver's op label.
fn op_name(state: RepositoryState) -> &'static str {
    match state {
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => "cherry-pick",
        RepositoryState::Merge => "merge",
        RepositoryState::Revert | RepositoryState::RevertSequence => "revert",
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge
        | RepositoryState::ApplyMailbox
        | RepositoryState::ApplyMailboxOrRebase => "rebase",
        RepositoryState::Clean | RepositoryState::Bisect => "none",
    }
}

/// Walk the index's conflict entries and materialise each side's blob as text.
fn read_conflicts(repo: &Repository) -> Result<Vec<ConflictFile>, git2::Error> {
    // `repo.index()` returns an owned Index handle (no borrow of `repo`), so we
    // can hold the conflict iterator and still call `repo.find_blob` below.
    let index = repo.index()?;
    let mut out: Vec<ConflictFile> = Vec::new();
    for entry in index.conflicts()? {
        let c = entry?;
        let path = conflict_path(&c);
        if path.is_empty() {
            continue; // unnameable (all three stages missing) — nothing to show
        }
        out.push(ConflictFile {
            path,
            base: stage_text(repo, c.ancestor.as_ref()),
            ours: stage_text(repo, c.our.as_ref()),
            theirs: stage_text(repo, c.their.as_ref()),
        });
        if out.len() >= MAX_FILES {
            break;
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// The file's path, from whichever stage is present (ours → theirs → base).
fn conflict_path(c: &IndexConflict) -> String {
    c.our
        .as_ref()
        .or(c.their.as_ref())
        .or(c.ancestor.as_ref())
        .map(|e| String::from_utf8_lossy(&e.path).into_owned())
        .unwrap_or_default()
}

/// One merge stage as display text: empty for an absent stage, `"‹binary›"` for
/// a binary blob, else the UTF-8-lossy blob content capped to [`CAP_LINES`].
fn stage_text(repo: &Repository, entry: Option<&IndexEntry>) -> String {
    let Some(entry) = entry else {
        return String::new(); // absent side (add/add base, delete/modify, …)
    };
    let Ok(blob) = repo.find_blob(entry.id) else {
        return String::new();
    };
    if blob.is_binary() {
        return "‹binary›".to_string();
    }
    cap_lines(&String::from_utf8_lossy(blob.content()))
}

/// Keep the first [`CAP_LINES`] lines; if more remain, append a marker line.
fn cap_lines(s: &str) -> String {
    let mut lines = s.lines();
    let head: Vec<&str> = lines.by_ref().take(CAP_LINES).collect();
    let remaining = lines.count(); // consumes the tail; 0 when nothing was cut
    if remaining == 0 {
        head.join("\n")
    } else {
        format!("{}\n… ({remaining} more line(s) truncated)", head.join("\n"))
    }
}

// ---------------------------------------------------------------------------
// Command: resolve_conflict_file  (WRITE — git CLI checkout + add)
// ---------------------------------------------------------------------------

/// Resolve one conflicted file by taking the whole `ours` or `theirs` side, then
/// staging it. Returns how many files are still unmerged so the UI can flip to
/// "Continue" when it reaches 0. JS: `invoke("resolve_conflict_file", { path,
/// file, side })` where `side` is `"ours"` or `"theirs"`.
///
/// No snapshot here — see the module doc: the enclosing op was snapshotted and
/// its `--abort` restores everything.
#[tauri::command]
pub fn resolve_conflict_file(path: String, file: String, side: String) -> ResolveResult {
    // `--ours` = stage 2 (HEAD), `--theirs` = stage 3 (incoming). Reject anything else.
    let flag = match side.as_str() {
        "ours" => "--ours",
        "theirs" => "--theirs",
        other => {
            return ResolveResult::err(format!(
                "Unknown side {other:?} (expected \"ours\" or \"theirs\")."
            ))
        }
    };
    if let Err(e) = validate_path(&file) {
        return ResolveResult::err(e);
    }

    // Guard: only resolve inside a cherry-pick — the one op GitCat snapshots
    // (git_pick::cherry_pick) and can Abort/Continue. cherry_pick_abort/continue
    // are gated on CHERRY_PICK_HEAD, so a merge/rebase/revert conflict could be
    // neither backed out nor advanced from the app — never mutate inside one.
    match Repository::open(&path) {
        Ok(repo) => {
            let op = op_name(repo.state());
            if op != "cherry-pick" {
                return ResolveResult::err(format!(
                    "Not inside a cherry-pick (repository state: {op}). Resolve {op} \
                     conflicts with git on the command line."
                ));
            }
        }
        Err(e) => {
            return ResolveResult::err(format!("cannot open repository: {}", e.message()))
        }
    }

    // 1) Write the chosen side into the working tree. `--` ends option parsing so
    //    a path can never be read as a flag (defense-in-depth with validate_path).
    match safety::run_git(&path, &["checkout", flag, "--", &file]) {
        Ok(o) if o.ok => {}
        // e.g. delete/modify conflict where the requested side has no version:
        // "path '<file>' does not have our version" — surface it, don't force.
        Ok(o) => return ResolveResult::fail(err_msg(&o), remaining_conflicts(&path)),
        Err(e) => return ResolveResult::err(e),
    }

    // 2) Stage it — collapses the unmerged stages (1/2/3) to a resolved stage 0.
    match safety::run_git(&path, &["add", "--", &file]) {
        Ok(o) if o.ok => {}
        Ok(o) => return ResolveResult::fail(err_msg(&o), remaining_conflicts(&path)),
        Err(e) => return ResolveResult::err(e),
    }

    let remaining = remaining_conflicts(&path);
    let kept = if flag == "--ours" { "ours" } else { "theirs" };
    let message = if remaining == 0 {
        format!("Kept {kept} for {file}. All conflicts resolved — Continue to finish.")
    } else {
        format!("Kept {kept} for {file}. {remaining} file(s) still conflicted.")
    };
    ResolveResult { ok: true, remaining, message }
}

/// Count files still unmerged (worktree vs index, filtered to Unmerged). Best
/// effort: a failed probe reports 0 so it never masks a successful resolution.
fn remaining_conflicts(path: &str) -> usize {
    match safety::run_git(path, &["diff", "--name-only", "--diff-filter=U"]) {
        Ok(o) if o.ok => o.stdout.lines().filter(|l| !l.trim().is_empty()).count(),
        _ => 0,
    }
}

impl ResolveResult {
    fn err(message: impl Into<String>) -> Self {
        Self { ok: false, remaining: 0, message: message.into() }
    }
    fn fail(message: impl Into<String>, remaining: usize) -> Self {
        Self { ok: false, remaining, message: message.into() }
    }
}

/// Best human message from a failed git run (prefer stderr).
fn err_msg(o: &GitOut) -> String {
    if !o.stderr.is_empty() {
        o.stderr.clone()
    } else if !o.stdout.is_empty() {
        o.stdout.clone()
    } else {
        format!("git exited with status {}", o.code)
    }
}

/// Reject a pathspec that could be read as a flag or carries a NUL/newline.
/// `--` at the CLI boundary already stops flag parsing; this gives a clear
/// message first and blocks argument smuggling via embedded newlines.
fn validate_path(p: &str) -> Result<(), String> {
    if p.is_empty() {
        return Err("No file specified.".into());
    }
    if p.starts_with('-') {
        return Err(format!("Refusing a path that looks like a flag: {p:?}"));
    }
    if p.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err("Path has an illegal NUL/newline character.".into());
    }
    Ok(())
}
