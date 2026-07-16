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
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub ours: String,
    pub base: String,
    pub theirs: String,
}

/// Result of [`conflict_status`]. `op` is one of
/// `"cherry-pick" | "merge" | "rebase" | "revert" | "stash" | "merge-squash" |
/// "am" | "none"` — see [`detect_op`] for why `"stash"` and `"merge-squash"`
/// exist (a `git stash apply`/`pop` conflict AND a `git merge --squash`
/// conflict both leave `RepositoryState` at `Clean`, unlike every other op
/// here), and see [`op_name`] for why `"am"` (a real `git am` in progress,
/// see patch.rs) is its own label distinct from `"rebase"` even though both
/// share the same `rebase-apply/` on-disk directory.
/// `in_progress` is true whenever a sequencer op is underway **or** there are
/// unmerged files — so once every file is resolved (`files` empty) but the
/// cherry-pick has not been continued yet, `in_progress` stays true and the
/// UI can offer Continue.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictStatus {
    pub in_progress: bool,
    pub op: String,
    pub files: Vec<ConflictFile>,
}

/// Result of [`resolve_conflict_file`]. `remaining` is the count of files still
/// unmerged after this resolution (0 means the tree is ready to Continue).
#[derive(Serialize, specta::Type)]
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
#[specta::specta]
pub fn conflict_status(path: String) -> Result<ConflictStatus, String> {
    let repo =
        crate::trust::open_repo(&path).map_err(|e| format!("cannot open repository: {}", e.message()))?;
    let op = detect_op(&repo).map_err(|e| e.message().to_string())?;
    let files = read_conflicts(&repo).map_err(|e| e.message().to_string())?;
    let in_progress = op != "none" || !files.is_empty();
    Ok(ConflictStatus { in_progress, op: op.to_string(), files })
}

/// Map libgit2's repository state to the resolver's op label. Pure function
/// of `RepositoryState` alone — see [`detect_op`] for the two cases
/// (`"stash"`, `"merge-squash"`) this can never report on its own.
///
/// `RepositoryState::ApplyMailbox` gets its OWN `"am"` label, distinct from
/// `"rebase"` — EMPIRICALLY VERIFIED (see patch.rs's module doc for the full
/// trail, done in throwaway `/tmp` repos): a real `git am --3way` conflict
/// and a real `git rebase --apply` (apply-based rebase backend) conflict both
/// use the same on-disk `rebase-apply/` directory, but git's own
/// `git rebase --continue`/`--abort` FAIL OUTRIGHT against an am-created
/// conflict ("It looks like 'git am' is in progress. Cannot rebase.", exit
/// 128) — only `git am --continue`/`--abort`/`--skip` work. Reading
/// libgit2's own `git_repository_state()` (vendored under `libgit2-sys`)
/// shows `rebase-apply/rebasing` (a REAL apply-backend rebase) resolves to
/// `RepositoryState::Rebase` itself, never `ApplyMailbox` — so a genuine
/// `git rebase --apply` conflict is UNAFFECTED by this split and keeps going
/// through the "rebase" bucket below exactly as before.
/// `ApplyMailboxOrRebase` (the rare "rebase-apply/ exists, neither marker
/// present" anomaly) is also left in the "rebase" bucket unchanged — this
/// split only pulls out the one state EMPIRICALLY CONFIRMED to unambiguously
/// mean "a real `git am` is in progress".
fn op_name(state: RepositoryState) -> &'static str {
    match state {
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => "cherry-pick",
        RepositoryState::Merge => "merge",
        RepositoryState::Revert | RepositoryState::RevertSequence => "revert",
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge
        | RepositoryState::ApplyMailboxOrRebase => "rebase",
        RepositoryState::ApplyMailbox => "am",
        RepositoryState::Clean | RepositoryState::Bisect => "none",
    }
}

/// The resolver's op label for the repo's CURRENT state — extends
/// `op_name`'s pure `RepositoryState` mapping with TWO more cases, both only
/// reachable when `RepositoryState` is `Clean` AND the index has conflicts:
/// `"merge-squash"` (a `git merge --squash` conflict — see git_merge.rs's
/// module doc) and `"stash"` (a `git stash apply`/`pop` conflict). Neither
/// sets any git-native marker (empirically verified: neither sets
/// `MERGE_HEAD` or any sequencer file the way merge/rebase/cherry-pick do),
/// so each writes its OWN sidecar (`git_merge::has_merge_squash_conflict` /
/// workdir's `stash-conflict.json`) — checked here in a fixed order: squash
/// first, stash as the fallback.
///
/// Squash is checked FIRST (not because it's "more correct", but because it's
/// the more specific of the two signals — this function only needs ONE
/// direct check, not two, since "not squash" already means "stash" by
/// elimination in today's two-op universe; see the "stash" branch below,
/// which is unconditional once squash is ruled out, preserving this
/// function's exact pre-existing default for any Clean+conflicted state with
/// no identifiable source).
///
/// INVARIANT that keeps the ordering from ever actually mattering: both
/// `git_merge::merge_squash` and `workdir::apply_or_pop` refuse to even START
/// while `unmerged_files()` is non-empty OR any sequencer op is in progress
/// — so under normal in-app use, AT MOST ONE of these two sidecars can exist
/// alongside a genuinely conflicted index at any given time.
///
/// A STALE sidecar (left behind by a conflict concluded out-of-band — e.g. a
/// plain `git commit` from a terminal instead of this app's own Continue) is
/// NOT just a labeling nuisance: an adversarial review found that `git_merge
/// ::merge_squash_abort`/`_continue` and `workdir::stash_conflict_abort`/
/// `_continue` each blindly trust THEIR OWN sidecar's content once dispatched
/// to — so a stale squash sidecar surviving until a LATER, unrelated stash
/// conflict would make this function mislabel it `"merge-squash"`, and a
/// user's Abort click would then hard-reset HEAD to the stale sidecar's
/// long-outdated `backup_ref`, silently discarding any real commits made
/// since. Fixed at the SOURCE, not here: both `merge_squash` and
/// `apply_or_pop` now clear BOTH sidecars the moment they confirm
/// `unmerged_files()` is empty at their own start (see each function's own
/// comment) — that emptiness proves any prior conflict is genuinely
/// concluded, so anything left on disk at that point is provably stale. This
/// function's ordering (squash-first) is therefore a tie-breaker for the
/// narrow out-of-band-concurrent-conflict case only (e.g. `git stash pop`
/// run from a terminal while GitCat already has a squash conflict open),
/// never a defense against staleness — that defense lives upstream.
///
/// Kept as ONE shared function (rather than duplicating this check) because
/// `conflict_status` (read), `resolve_conflict_file`'s allowlist (write
/// guard), AND `tool_settings::resolve_conflict_with_external_tool`'s own
/// allowlist (a third caller, delegating to `git mergetool` instead of
/// `checkout --ours/--theirs`) must all agree on it — a split here would let
/// one recognize a conflict while another refuses to act on it.
///
/// `pub(crate)` (not private) so `tool_settings.rs` can reuse this directly
/// rather than hand-copying the repository-state disambiguation logic — this
/// is a deliberate EXCEPTION to this codebase's usual "duplicate small
/// per-module helpers" convention (see `workdir.rs`'s own doc comment):
/// `detect_op` is genuinely complex, security-relevant logic (merge/rebase/
/// am/stash/squash state disambiguation), and a second hand-copied version
/// would be a real drift hazard, unlike the trivial one-liners each module
/// duplicates elsewhere (`err_msg`, `remaining_conflicts`, …).
pub(crate) fn detect_op(repo: &Repository) -> Result<&'static str, git2::Error> {
    let op = op_name(repo.state());
    if op == "none" && repo.index()?.has_conflicts() {
        if crate::git_merge::has_merge_squash_conflict(repo) {
            return Ok("merge-squash");
        }
        return Ok("stash");
    }
    Ok(op)
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

/// Guard: only resolve inside an op GitCat snapshots AND can Abort/Continue
/// from the app — cherry-pick (git_pick), merge (git_merge), rebase
/// (git_rebase), revert (git_revert), stash
/// (workdir::stash_conflict_abort/_continue), merge-squash
/// (git_merge::merge_squash_abort/_continue), and am (patch::am_continue/
/// am_abort/am_skip). Their *_abort/*_continue commands are gated on
/// CHERRY_PICK_HEAD/MERGE_HEAD/the rebase-merge sequencer dir/REVERT_HEAD/
/// the stash-conflict sidecar file/the merge-squash-conflict sidecar
/// file/RepositoryState::ApplyMailbox respectively, so any OTHER op could
/// be neither backed out nor advanced from the app — never mutate inside
/// one. `--ours`/`--theirs` checkout + `add` (or the hunk editor's own
/// write + `add`) applies identically to an am conflict's index stages
/// 1/2/3 as to any other op's — nothing here is rebase/am-specific.
///
/// NOTE: this is intentionally an allowlist, not a denylist, so an op that
/// doesn't (yet) have app-level continue/abort support fails closed.
/// Shared by [`resolve_conflict_file`] and [`resolve_conflict_hunks`] — the
/// whole-file and hunk-level resolution paths must never drift apart on
/// which ops are safe to mutate inside.
fn ensure_resolvable_op(path: &str) -> Result<(), String> {
    let repo = crate::trust::open_repo(path).map_err(|e| format!("cannot open repository: {}", e.message()))?;
    let op = detect_op(&repo).map_err(|e| format!("cannot inspect repository state: {}", e.message()))?;
    if op != "cherry-pick" && op != "merge" && op != "rebase" && op != "revert" && op != "stash" && op != "merge-squash" && op != "am" {
        return Err(format!(
            "Not inside a cherry-pick, merge, rebase, revert, stash, squash-merge, or patch-apply conflict (repository state: {op}). \
             Resolve {op} conflicts with git on the command line."
        ));
    }
    Ok(())
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
#[specta::specta]
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

    if let Err(e) = ensure_resolvable_op(&path) {
        return ResolveResult::err(e);
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
    // ADVERSARIALLY-FOUND FIX: `p` should always be a repo-relative path
    // sourced from git's own conflict index (see `path_of`), never
    // caller-controlled — but that's an invariant, not something this
    // function enforced. `resolve_conflict_file`'s write is entirely
    // mediated by `git checkout -- <file>`, which git itself confines to
    // the work tree as a pathspec (a bad path there is at worst a no-op);
    // `resolve_conflict_hunks` writes via plain `std::fs::write` on
    // `Path::new(&path).join(&file)` instead, which has NO such confinement
    // — an absolute `p` replaces the joined base entirely (`Path::join`'s
    // documented behavior), and a `..` component walks back out of it, so
    // either would let a wrong/stale/malicious `file` argument write
    // somewhere outside the repository. Rejecting both here protects every
    // caller uniformly, not just the one that currently needs it.
    if std::path::Path::new(p).is_absolute() {
        return Err("Refusing an absolute path.".into());
    }
    if std::path::Path::new(p).components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("Refusing a path containing \"..\".".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Command: conflict_file_hunks  (READ — git2 index inspection + `git merge-file`)
// ---------------------------------------------------------------------------

/// One aligned region of a conflicted file: either shared, unconflicted
/// `context` (identical text across all three stages, surrounding a real
/// conflict), or a `conflict` region carrying each stage's own version of
/// just that region. `context`/(`ours`,`base`,`theirs`) are populated
/// according to `kind` — the other fields are `None`.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictHunk {
    pub kind: String, // "context" | "conflict"
    pub context: Option<String>,
    pub ours: Option<String>,
    pub base: Option<String>,
    pub theirs: Option<String>,
}

/// Result of [`conflict_file_hunks`]. `binary` means at least one stage is a
/// binary blob — `git merge-file` can't meaningfully line-diff that, so
/// `hunks` is empty and the frontend falls back to whole-file
/// Take-ours/Take-theirs (still available via [`resolve_conflict_file`],
/// unchanged by any of this).
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFileHunks {
    pub path: String,
    pub hunks: Vec<ConflictHunk>,
    pub binary: bool,
}

/// Aligned per-hunk view of one conflicted file, for the in-app resolution
/// editor — as opposed to [`conflict_status`]'s whole-side-per-column view,
/// which stays completely unchanged. Shells `git merge-file --diff3` on the
/// three already-fetched stages (reusing git's own 3-way merge/diff
/// algorithm to generate correct `<<<<<<</|||||||/=======/>>>>>>>` marker
/// text, rather than reimplementing line-alignment from scratch) and parses
/// that into structured hunks the frontend can render/edit per-region.
/// JS: `invoke("conflict_file_hunks", { path, file })`.
#[tauri::command]
#[specta::specta]
pub fn conflict_file_hunks(path: String, file: String) -> Result<ConflictFileHunks, String> {
    if let Err(e) = validate_path(&file) {
        return Err(e);
    }
    let repo = crate::trust::open_repo(&path).map_err(|e| format!("cannot open repository: {}", e.message()))?;
    let index = repo.index().map_err(|e| e.message().to_string())?;
    // conflict_get errors (rather than returning None) when the path has no
    // conflict entry — not a "cannot inspect the repo" failure, just "there's
    // nothing to fetch hunks for", so it gets the same user-facing message as
    // the (structurally impossible in practice, but still handled) empty case.
    let conflict = match index.conflict_get(std::path::Path::new(&file)) {
        Ok(c) => c,
        Err(_) => return Err(format!("{file} is not conflicted.")),
    };

    let (ours, ours_binary) = stage_full_text(&repo, conflict.our.as_ref());
    let (base, base_binary) = stage_full_text(&repo, conflict.ancestor.as_ref());
    let (theirs, theirs_binary) = stage_full_text(&repo, conflict.their.as_ref());
    if ours_binary || base_binary || theirs_binary {
        return Ok(ConflictFileHunks { path: file, hunks: Vec::new(), binary: true });
    }

    let scratch = scratch_dir(&repo);
    if let Err(e) = std::fs::create_dir_all(&scratch) {
        return Err(format!("cannot create scratch dir: {e}"));
    }
    let ours_path = scratch.join("ours");
    let base_path = scratch.join("base");
    let theirs_path = scratch.join("theirs");
    let write_result = std::fs::write(&ours_path, &ours)
        .and_then(|_| std::fs::write(&base_path, &base))
        .and_then(|_| std::fs::write(&theirs_path, &theirs));
    if let Err(e) = write_result {
        let _ = std::fs::remove_dir_all(&scratch);
        return Err(format!("cannot write scratch files: {e}"));
    }

    let result = safety::run_git(
        &path,
        &[
            "merge-file",
            "--diff3",
            "-p",
            "-L",
            "ours",
            "-L",
            "base",
            "-L",
            "theirs",
            &ours_path.to_string_lossy(),
            &base_path.to_string_lossy(),
            &theirs_path.to_string_lossy(),
        ],
    );
    let _ = std::fs::remove_dir_all(&scratch); // best-effort cleanup either way

    let out = result?;
    // Exit 0 = clean (no conflicting region at all — rare, e.g. both sides
    // changed identically), 1 = conflicts found (the expected/normal case),
    // 2+ = merge-file itself couldn't run (bad input, not "there's a conflict").
    if out.code != 0 && out.code != 1 {
        return Err(if !out.stderr.is_empty() { out.stderr } else { format!("git merge-file exited with status {}", out.code) });
    }

    Ok(ConflictFileHunks { path: file, hunks: parse_diff3_hunks(&out.stdout)?, binary: false })
}

/// One merge stage's FULL blob content for the hunk editor. Deliberately NOT
/// `stage_text` (display-only, capped to [`CAP_LINES`] for the read-only
/// three-way-diff view): `conflict_file_hunks` feeds this to `git merge-file`
/// and `resolve_conflict_hunks` later writes the user's edited version
/// straight back to the working tree, so capping here would silently
/// discard real file content past the cap the moment the user saves.
/// Returns `(text, is_binary)` in one blob lookup — folding the binary check
/// and the content read into a single `find_blob` instead of two separate
/// passes over the same blob.
fn stage_full_text(repo: &Repository, entry: Option<&IndexEntry>) -> (String, bool) {
    let Some(entry) = entry else { return (String::new(), false) };
    let Ok(blob) = repo.find_blob(entry.id) else { return (String::new(), false) };
    if blob.is_binary() {
        (String::new(), true)
    } else {
        (String::from_utf8_lossy(blob.content()).into_owned(), false)
    }
}

/// `<git-dir>/gitgui/conflict-merge-file/` — reuses the existing
/// `<git-dir>/gitgui/` sidecar convention already established for
/// `workdir.rs`'s `discard-backup/` and `git_rebase.rs`'s `rebase-todo/`
/// (see that module's own `todo_dir` comment), rather than
/// `std::env::temp_dir()` — keeps it repo-scoped, inspectable, and cleaned
/// up the same way. Fixed filenames (ours/base/theirs) are fine: this
/// scratch space is written, read, and removed within one synchronous
/// command call, never left around between calls.
fn scratch_dir(repo: &Repository) -> std::path::PathBuf {
    repo.path().join("gitgui").join("conflict-merge-file")
}

/// Parse `git merge-file --diff3 -L ours -L base -L theirs -p`'s output into
/// aligned hunks. The three `-L` labels make the marker lines unambiguous
/// (`<<<<<<< ours`, `||||||| base`, `>>>>>>> theirs`) instead of needing to
/// tolerate whatever text git would otherwise substitute there (the temp
/// file's own path). `.lines()` (not `.split('\n')`) so a CRLF-checked-out
/// file's `\r` doesn't leak into every reconstructed line.
///
/// KNOWN LIMITATION: reassembling matched lines with a trailing `\n` after
/// each one means a file whose very last line had NO trailing newline gains
/// one once resolved — a cosmetic, EOF-only newline-normalization edge case
/// judged not worth the extra bookkeeping this app's other line-based tools
/// (e.g. workdir.rs's hunk staging) don't attempt either.
fn parse_diff3_hunks(text: &str) -> Result<Vec<ConflictHunk>, String> {
    #[derive(PartialEq)]
    enum St {
        Context,
        Ours,
        Base,
        Theirs,
    }
    let mut st = St::Context;
    let mut hunks = Vec::new();
    let mut context = String::new();
    let mut ours = String::new();
    let mut base = String::new();
    let mut theirs = String::new();

    for line in text.lines() {
        // Guarded on `st == St::Context`, like the other three marker checks
        // below are each guarded on THEIR expected preceding state: without
        // this, a conflicted file whose OWN content happens to contain a
        // literal "<<<<<<< ours" line (plausible in anything documenting or
        // testing git conflict markers) would reset the parser mid-hunk and
        // silently discard whatever text had already accumulated for it.
        if line == "<<<<<<< ours" && st == St::Context {
            if !context.is_empty() {
                hunks.push(ConflictHunk::context(std::mem::take(&mut context)));
            }
            st = St::Ours;
            continue;
        }
        if line == "||||||| base" && st == St::Ours {
            st = St::Base;
            continue;
        }
        if line == "=======" && (st == St::Ours || st == St::Base) {
            st = St::Theirs;
            continue;
        }
        if line == ">>>>>>> theirs" && st == St::Theirs {
            hunks.push(ConflictHunk::conflict(std::mem::take(&mut ours), std::mem::take(&mut base), std::mem::take(&mut theirs)));
            st = St::Context;
            continue;
        }
        let buf = match st {
            St::Context => &mut context,
            St::Ours => &mut ours,
            St::Base => &mut base,
            St::Theirs => &mut theirs,
        };
        buf.push_str(line);
        buf.push('\n');
    }
    // An unterminated hunk (EOF reached without a closing ">>>>>>> theirs")
    // means the output didn't parse the way this function expects — surface
    // that honestly rather than silently dropping the accumulated
    // ours/base/theirs text, which a caller could otherwise save over the
    // real file content.
    if st != St::Context {
        return Err("could not parse this file's conflict markers — an unterminated conflict region was found.".into());
    }
    if !context.is_empty() {
        hunks.push(ConflictHunk::context(context));
    }
    Ok(hunks)
}

impl ConflictHunk {
    fn context(text: String) -> Self {
        Self { kind: "context".into(), context: Some(text), ours: None, base: None, theirs: None }
    }
    fn conflict(ours: String, base: String, theirs: String) -> Self {
        Self { kind: "conflict".into(), context: None, ours: Some(ours), base: Some(base), theirs: Some(theirs) }
    }
}

// ---------------------------------------------------------------------------
// Command: resolve_conflict_hunks  (WRITE — write assembled text + git add)
// ---------------------------------------------------------------------------

/// Write the frontend's already-assembled final resolution (joined from its
/// own hunk choices/edits — see [`conflict_file_hunks`]) straight to the
/// working tree, then stage it. The hunk-editor counterpart to
/// [`resolve_conflict_file`]: same finalize step (write + `git add`), just
/// fed a caller-assembled string instead of a `--ours`/`--theirs` side.
/// JS: `invoke("resolve_conflict_hunks", { path, file, resolvedContent })`.
///
/// No snapshot here — same reasoning as `resolve_conflict_file`: this only
/// ever runs inside an already-snapshotted, already-in-progress operation.
#[tauri::command]
#[specta::specta]
pub fn resolve_conflict_hunks(path: String, file: String, resolved_content: String) -> ResolveResult {
    if let Err(e) = validate_path(&file) {
        return ResolveResult::err(e);
    }

    if let Err(e) = ensure_resolvable_op(&path) {
        return ResolveResult::err(e);
    }

    // 1) Write the assembled resolution into the working tree — same
    //    workdir-relative-path-join convention as workdir.rs's own raw
    //    filesystem writes (e.g. `backup_untracked_bytes`), `file` sourced
    //    from git's own conflict index rather than raw untrusted input.
    let full_path = std::path::Path::new(&path).join(&file);
    if let Err(e) = std::fs::write(&full_path, &resolved_content) {
        return ResolveResult::err(format!("cannot write {file}: {e}"));
    }

    // 2) Stage it — collapses stages 1/2/3 to a resolved stage 0, exactly
    //    like resolve_conflict_file's own step 2.
    match safety::run_git(&path, &["add", "--", &file]) {
        Ok(o) if o.ok => {}
        Ok(o) => return ResolveResult::fail(err_msg(&o), remaining_conflicts(&path)),
        Err(e) => return ResolveResult::err(e),
    }

    let remaining = remaining_conflicts(&path);
    let message = if remaining == 0 {
        format!("Saved your resolution for {file}. All conflicts resolved — Continue to finish.")
    } else {
        format!("Saved your resolution for {file}. {remaining} file(s) still conflicted.")
    };
    ResolveResult { ok: true, remaining, message }
}
