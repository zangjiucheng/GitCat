//! Patch export/apply — one commit, or a whole revision range, as a single
//! git-am-mailbox-format `.patch` file for sharing outside a shared remote
//! (`git format-patch --stdout` / `git am --3way`).
//!
//! # Why `--3way` is mandatory for apply
//!
//! EMPIRICALLY VERIFIED (git 2.50.1, throwaway `/tmp` repos, deleted after):
//! plain `git am <file>` on a conflicting patch fails with **zero** conflict
//! markers and **zero** unmerged index entries ("patch does not apply",
//! working tree untouched) — nothing for conflict.rs's `read_conflicts`/the
//! Resolver's three-way UI to show. `git am --3way <file>` on the identical
//! input produces a real three-way merge with genuine conflict markers and
//! index stages 1/2/3 — fully compatible with the existing Resolver /
//! `resolve_conflict_file` machinery. So [`apply_patch`] always passes
//! `--3way`.
//!
//! # The `git rebase --continue`/`--abort` vs `git am --continue`/`--abort`/
//! `--skip` crux
//!
//! `git rebase`'s own apply-based backend and `git am` share the exact same
//! `.git/rebase-apply` directory — confirmed by git_rebase.rs's own
//! `in_progress()` checking `rebase-apply` alongside `rebase-merge`, and by
//! conflict.rs's pre-existing `op_name()` mapping BOTH `RepositoryState::
//! ApplyMailbox` and `ApplyMailboxOrRebase` to the same `"rebase"` label. This
//! module's own empirical test (throwaway repos, deleted after) found the two
//! command families are **not interchangeable**:
//!   * `git rebase --continue` against a real `git am --3way` conflict
//!     (resolved file staged): **fails outright** —
//!     `fatal: It looks like 'git am' is in progress. Cannot rebase.`
//!     (exit 128, zero mutation). Fed through git_rebase.rs's own
//!     `classify()`, this would misclassify as `state:"conflict"` again
//!     (since `in_progress()` — which checks `rebase-apply` too — stays
//!     true), producing an infinite "Continue" loop that can never succeed.
//!   * `git rebase --abort` against the same state: **also fails
//!     identically** — the Abort button would be non-functional, a real
//!     regression against `rebase_abort`'s own "the escape hatch must ALWAYS
//!     work" guarantee.
//!   * `git am --continue` / `git am --abort` / `git am --skip` against the
//!     am state: **all work correctly** (verified: continue finishes
//!     applying the remaining mailbox message and concludes the commit;
//!     abort restores the exact pre-am HEAD).
//!
//! # Resolving the disambiguation — no sidecar file needed
//!
//! Reading libgit2's own `git_repository_state()` (vendored under
//! `libgit2-sys`) shows it checks, in order: `rebase-apply/rebasing` (->
//! `Rebase`), then `rebase-apply/applying` (-> `ApplyMailbox`), then a bare
//! `rebase-apply/` with neither marker (-> `ApplyMailboxOrRebase`, an
//! anomalous case). EMPIRICALLY CONFIRMED: our `git am --3way` conflict's
//! `rebase-apply/` contained `applying` (no `rebasing`) -> `ApplyMailbox`;
//! a genuine `git rebase --apply` (the apply-based, non-default rebase
//! backend) conflict's `rebase-apply/` contained `rebasing` -> `Rebase`
//! itself, NOT `ApplyMailbox`/`ApplyMailboxOrRebase` at all — so it's
//! completely unaffected by this module and keeps going through
//! git_rebase.rs's existing "rebase" path unchanged. This means
//! `RepositoryState::ApplyMailbox` is unambiguously "a real `git am` in
//! progress" — conflict.rs's `op_name` now maps it to a new `"am"` label
//! (moved OUT of the old "rebase" bucket it used to share); `ApplyMailboxOrRebase`
//! (the rare "neither marker" anomaly) is left exactly where it was
//! ("rebase") — zero behavior change for that pre-existing corner, and
//! GitCat's own rebase_start/rebase_interactive_start never touch
//! `rebase-apply` at all (see git_rebase.rs's module doc).
//!
//! `am_continue`/`am_abort`/`am_skip` below shell literally to
//! `git am --continue`/`--abort`/`--skip` — NEVER to git_rebase.rs's
//! `rebase_continue`/`rebase_abort`, which are empirically confirmed to fail
//! outright against an am-created conflict.
//!
//! # Other verified odds and ends
//!
//! * `git am`'s per-successfully-applied-commit `"Applying: <subject>"` line
//!   goes to **stdout**, not stderr (re-verified: `git am --3way` on a clean
//!   multi-commit mailbox, and `git am --continue` after resolving, both put
//!   every "Applying: " line on stdout with stderr empty or hint-text-only) —
//!   used only for a non-load-bearing "Applied N commit(s)" success-message
//!   count, via [`count_applied`] on `out.stdout` (NOT `out.stderr` — an
//!   earlier draft got this backwards, which would have silently always
//!   reported "1 commit" regardless of the real count).
//! * There is no "nothing to do" success state for `am` the way rebase has
//!   "empty" — re-applying an already-applied patch, or one with no context
//!   margin, surfaces as an ordinary conflict/error. [`ApplyPatchResult`]
//!   only needs `"clean" | "conflict" | "error"`.
//! * **Merge-commit footgun**: `git format-patch -1 <merge-sha>` does NOT
//!   error and does NOT export the merge — it silently exports its FIRST
//!   PARENT's commit instead (verified). [`export_patch`]'s single-commit
//!   path (`from: None`) refuses a merge commit rather than silently handing
//!   back a patch for the wrong commit.
//! * `export_patch`'s own stdout capture is UNTRIMMED (unlike every other git
//!   CLI call in this module, which reuses the standard trimmed [`Out`]) —
//!   the mbox blob is written byte-for-byte to the user's chosen file.
//!   Trimming trailing whitespace was empirically confirmed harmless to a
//!   later `git am` (interior "From " message boundaries are per-message-
//!   start, unaffected by an outer trim), but untrimmed is zero-cost
//!   belt-and-suspenders, not a fix for an observed failure.
//!
//! # Mbox "From " ambiguity — a real, adversarially-found corruption, fixed
//! by [`mboxrd_escape`]
//!
//! An earlier draft of this module claimed "git's own mboxrd escaping
//! guarantees no commit BODY line can collide with this exact shape" — an
//! adversarial review proved that FALSE: `git format-patch --stdout` applies
//! NO escaping at all. A commit message whose BODY contains a line shaped
//! like a real boundary (`From <40-hex-chars> <a date-like string>`) is
//! written out completely unescaped, and `git am`'s own `mailsplit` cannot
//! tell it apart from a genuine message boundary — EMPIRICALLY CONFIRMED to
//! corrupt the split even for a SINGLE commit's own single-message file (not
//! just multi-commit concatenation): the body line gets treated as the start
//! of a second, bogus message with no real diff, and `git am` fails with
//! "Patch is empty." — silently orphaning that commit's actual change.
//!
//! The fix: [`export_patch`] computes the GROUND-TRUTH ordered list of real
//! commit shas being exported (via a git2 revwalk, oldest-first — the same
//! order `format-patch --stdout` itself emits messages in), then walks the
//! captured blob line by line. A line matching `^From <40 hex chars> ` is a
//! REAL boundary ONLY if that hex string is the NEXT expected sha in order
//! (advancing a cursor); every other line matching `^>*From ` (the real,
//! recursive mboxrd body-escaping trigger — a body line that already starts
//! with one or more ">"s followed by "From " needs one more ">", exactly
//! like a real mail delivery agent's own mboxrd escaping) gets one more ">"
//! prepended. [`apply_patch`] then passes `--patch-format=mboxrd` to `git
//! am`, telling it to unescape on the way back in. EMPIRICALLY VERIFIED (not
//! just reasoned about): the exact adversarial repro above round-trips
//! correctly with this fix (both commits apply, nothing orphaned), and a
//! completely ordinary patch with nothing to escape is byte-for-byte
//! unaffected by requesting `--patch-format=mboxrd` on the apply side.
//!
//! Because the ground truth is OUR OWN known sha sequence (not a generic
//! "looks like 40 hex chars" heuristic), this can never mis-escape a REAL
//! boundary or fail to escape a colliding body line — it isn't a heuristic
//! at all, it's exact.

use std::process::Command;

use git2::{Repository, RepositoryState};
use serde::Serialize;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// Result of [`export_patch`]. Never mutates the repo (nothing git-observable
/// changes — only an external file is written), so there is no `backupRef`:
/// nothing here is Undo-able or needs to be.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportPatchResult {
    pub ok: bool,
    pub message: String,
}

impl ExportPatchResult {
    fn err(message: impl Into<String>) -> Self {
        Self { ok: false, message: message.into() }
    }
    fn ok_msg(message: impl Into<String>) -> Self {
        Self { ok: true, message: message.into() }
    }
}

/// Result of [`apply_patch`] / [`am_continue`] / [`am_skip`] / [`am_abort`].
/// Structurally identical to git_rebase.rs's `RebaseResult` (so it slots into
/// resolver.svelte.ts's existing `OpResult` union with zero shape friction)
/// but WITHOUT "editing"/"empty" — `git am` has no analogue for either (see
/// module doc: an unresolvable/already-applied patch just surfaces as an
/// ordinary conflict/error, never a distinct "nothing to do" success).
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPatchResult {
    pub ok: bool,
    /// "clean" | "conflict" | "error"
    pub state: String,
    /// Repo-relative paths with unmerged entries — non-empty only when
    /// `state == "conflict"`.
    pub conflicted_files: Vec<String>,
    pub message: String,
    /// Pre-op safety snapshot ref (present when we snapshotted before
    /// mutating), so the UI can name the snapshot the user can Undo to.
    pub backup_ref: Option<String>,
}

impl ApplyPatchResult {
    fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            state: "error".into(),
            conflicted_files: Vec::new(),
            message: message.into(),
            backup_ref: None,
        }
    }
}

// ---------------------------------------------------------------------------
// git CLI runners
// ---------------------------------------------------------------------------

/// One git CLI invocation's captured (TRIMMED) result — mirrors
/// git_rebase.rs's own `Out`/`git()` exactly, including the same `no_editor`
/// `GIT_EDITOR`/`GIT_SEQUENCE_EDITOR=true` guard (defensive for
/// `am_continue`: concluding a resolved-conflict commit doesn't normally open
/// an editor, but the same "never let a headless app block on an interactive
/// prompt" discipline applies uniformly across this codebase).
struct Out {
    ok: bool,
    stdout: String,
    stderr: String,
}

fn git(path: &str, args: &[&str], no_editor: bool) -> Result<Out, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path).args(args);
    if no_editor {
        cmd.env("GIT_EDITOR", "true").env("GIT_SEQUENCE_EDITOR", "true");
    }
    let o = cmd.output().map_err(|e| format!("Could not run git: {e}"))?;
    Ok(Out {
        ok: o.status.success(),
        stdout: String::from_utf8_lossy(&o.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&o.stderr).trim().to_string(),
    })
}

/// Best human message from a failed run (prefer stderr, then stdout).
fn git_msg(o: &Out) -> String {
    if !o.stderr.is_empty() {
        o.stderr.clone()
    } else if !o.stdout.is_empty() {
        o.stdout.clone()
    } else {
        "git exited with a non-zero status".to_string()
    }
}

/// UNTRIMMED stdout capture, used ONLY by [`export_patch`] — see module doc's
/// "export_patch's own stdout capture is UNTRIMMED" note.
struct RawOut {
    ok: bool,
    stdout: String,
    stderr: String,
}

fn run_format_patch(path: &str, args: &[&str]) -> Result<RawOut, String> {
    let o = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    Ok(RawOut {
        ok: o.status.success(),
        stdout: String::from_utf8_lossy(&o.stdout).into_owned(), // NOT trimmed
        stderr: String::from_utf8_lossy(&o.stderr).trim().to_string(),
    })
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Reject a revision that could be read as a flag or carries control chars —
/// same shape as git_rebase.rs's `validate_rev` (small helpers are duplicated
/// per module, not imported, per this codebase's own convention — see
/// blame.rs's doc comment). `--end-of-options` at the CLI boundary is the
/// real guard; this just yields a clean message instead of git's "unknown
/// revision".
fn validate_rev(rev: &str) -> Result<(), String> {
    if rev.is_empty() {
        return Err("No revision given.".into());
    }
    if rev.starts_with('-') {
        return Err(format!("Refusing a revision that looks like a flag: {rev:?}"));
    }
    if rev.chars().any(|c| c.is_control()) {
        return Err("Revision has a control character.".into());
    }
    Ok(())
}

/// `dest` is a LOCAL FILESYSTEM PATH from the frontend's native `save()`
/// dialog — not a git revision/pathspec. It's only ever consumed by Rust's
/// own `fs::write` (git never sees it as an argument), so only empty/NUL is
/// guarded — there's no CLI injection surface to speak of.
fn validate_dest_path(p: &str) -> Result<(), String> {
    if p.is_empty() {
        return Err("No destination file chosen.".into());
    }
    if p.contains('\0') {
        return Err("Destination path has an illegal NUL character.".into());
    }
    Ok(())
}

/// `patch_file_path` DOES reach git as a bare positional argument to
/// `git am`, so — defense in depth only; a path a native OS "open" dialog
/// returns can never actually start with '-' — this also rejects a leading
/// dash, mirroring conflict.rs's `validate_path`.
fn validate_patch_file(p: &str) -> Result<(), String> {
    if p.is_empty() {
        return Err("No patch file chosen.".into());
    }
    if p.starts_with('-') {
        return Err(format!("Refusing a path that looks like a flag: {p:?}"));
    }
    if p.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err("Path has an illegal NUL/newline character.".into());
    }
    Ok(())
}

/// Repo-relative unmerged (conflicted) paths — identical convention to
/// git_rebase.rs's `unmerged_files` (porcelain
/// `git diff --name-only --diff-filter=U`).
fn unmerged_files(path: &str) -> Vec<String> {
    match git(path, &["diff", "--name-only", "--diff-filter=U"], false) {
        Ok(o) if o.ok => o
            .stdout
            .lines()
            .map(|l| l.to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// Route a finished `git am [--continue|--abort|--skip]` run to an
/// [`ApplyPatchResult`] by inspecting live repo state — mirrors
/// git_rebase.rs's `classify()`, minus the "editing"/"empty" branches (no am
/// equivalent — see module doc), and using
/// `repo.state() == RepositoryState::ApplyMailbox` (NOT a raw `rebase-apply`
/// path-existence check, which conflict.rs's `op_name` would ALSO now call
/// "am" — using the identical condition here keeps "this op is labeled am"
/// and "this session is genuinely still open" provably in sync) as the
/// "still open" signal.
fn classify_am(repo: &Repository, path: &str, out: &Out, backup: Option<String>) -> ApplyPatchResult {
    let conflicts = unmerged_files(path);
    if !conflicts.is_empty() {
        let n = conflicts.len();
        return ApplyPatchResult {
            ok: false,
            state: "conflict".into(),
            conflicted_files: conflicts,
            message: format!(
                "Applying the patch conflicts in {n} file{}. Resolve them, then Continue — or Skip this commit, or Abort.",
                if n == 1 { "" } else { "s" }
            ),
            backup_ref: backup,
        };
    }
    if out.ok {
        return ApplyPatchResult {
            ok: true,
            state: "clean".into(),
            conflicted_files: Vec::new(),
            message: "Applied the patch.".into(), // caller overwrites with a commit count
            backup_ref: backup,
        };
    }
    if repo.state() == RepositoryState::ApplyMailbox {
        // No unmerged files, but the session is still open: couldn't
        // conclude the commit (hook rejection, gpgsign failure, …) — same
        // "never mislabel a still-open sequencer as clean/error" discipline
        // as git_rebase.rs's classify()'s own `in_progress` branch.
        return ApplyPatchResult {
            ok: false,
            state: "conflict".into(),
            conflicted_files: Vec::new(),
            message: format!(
                "Could not finish applying the patch: {}. Continue to retry, Skip this commit, or Abort.",
                git_msg(out)
            ),
            backup_ref: backup,
        };
    }
    ApplyPatchResult {
        ok: false,
        state: "error".into(),
        conflicted_files: Vec::new(),
        message: git_msg(out),
        backup_ref: backup,
    }
}

/// Count of "Applying: " lines git printed to STDOUT for a successful
/// (sub-)run (see module doc's "Other verified odds and ends" — this line
/// goes to stdout, not stderr) — non-load-bearing, success-message cosmetics
/// only.
fn count_applied(stdout: &str) -> usize {
    stdout.lines().filter(|l| l.starts_with("Applying: ")).count()
}

/// The commits `export_patch` will emit, oldest-first — the exact order
/// `git format-patch --stdout` itself writes messages in, and the GROUND
/// TRUTH [`mboxrd_escape`] uses to tell a real message boundary apart from a
/// commit-body line that merely looks like one (see module doc's "Mbox
/// 'From ' ambiguity" section). `to_commit` is peeled/resolved by the
/// caller; `from` (if any) is EXCLUSIVE, matching `<from>..<to>` range
/// semantics and `format-patch`'s own.
fn commit_shas_oldest_first(repo: &Repository, from: Option<&str>, to_commit: &git2::Commit) -> Result<Vec<String>, String> {
    if from.is_none() {
        return Ok(vec![to_commit.id().to_string()]);
    }
    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    walk.push(to_commit.id()).map_err(|e| e.message().to_string())?;
    if let Some(f) = from {
        let from_oid = repo
            .revparse_single(f)
            .and_then(|o| o.peel_to_commit())
            .map_err(|e| format!("Cannot resolve revision {f:?}: {}", e.message()))?
            .id();
        walk.hide(from_oid).map_err(|e| e.message().to_string())?;
    }
    let mut shas: Vec<String> = walk
        .filter_map(|oid| oid.ok())
        .map(|oid| oid.to_string())
        .collect();
    shas.reverse(); // revwalk is newest-first by default; format-patch emits oldest-first.
    Ok(shas)
}

/// Escape any body line that could be mistaken for a real mbox message
/// boundary by `git am`'s own `mailsplit` — see module doc's "Mbox 'From '
/// ambiguity" section for the full empirical story. `real_shas_oldest_first`
/// is the GROUND TRUTH ordered list of commits this blob actually contains
/// (from [`commit_shas_oldest_first`]); a line matching `^From <40 hex> ` is
/// a genuine boundary ONLY if its hex string is the NEXT expected sha in
/// that list (the cursor only ever advances forward, matching
/// `format-patch --stdout`'s own strictly-in-order message emission).
/// EVERY other line matching the real, recursive mboxrd trigger `^>*From `
/// (a body line already starting with one or more ">"s followed by
/// "From " needs exactly one more ">") gets escaped. The caller
/// (`apply_patch`) must pass `--patch-format=mboxrd` to `git am` so this
/// escaping is correctly undone on the way back in.
fn mboxrd_escape(blob: &str, real_shas_oldest_first: &[String]) -> String {
    let mut next = 0usize;
    let mut out = String::with_capacity(blob.len());
    for line in blob.split_inclusive('\n') {
        let content = line.strip_suffix('\n').unwrap_or(line);
        let is_real_boundary = next < real_shas_oldest_first.len()
            && content
                .strip_prefix("From ")
                .and_then(|rest| rest.get(..40))
                .is_some_and(|hex| hex == real_shas_oldest_first[next]);
        if is_real_boundary {
            next += 1;
            out.push_str(line);
        } else if content.trim_start_matches('>').starts_with("From ") {
            // Real mboxrd trigger: zero-or-more leading ">"s then "From ".
            out.push('>');
            out.push_str(line);
        } else {
            out.push_str(line);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Commands (registered in lib.rs)
// ---------------------------------------------------------------------------

/// Export `to` (or `from..to`) as one combined mbox `.patch` file at `dest`.
/// `from: None` => single-commit mode (`-1 <to>`, robust to `to` being a root
/// commit — see module doc for why NOT `<to>~1..<to>`, which hard-fails
/// "ambiguous argument" on a root commit). `from: Some(rev)` => range mode
/// (`<rev>..<to>`).
///
/// Pure read + external file write — no repo mutation, so no snapshot.
/// Refuses a merge commit in single-commit mode (see module doc's "footgun"
/// note) — this is a backend backstop; the frontend already disables the
/// commit-menu action for a merge.
///
/// JS: `invoke("export_patch", { path, from, to, dest })`.
#[tauri::command]
#[specta::specta]
pub fn export_patch(path: String, from: Option<String>, to: String, dest: String) -> ExportPatchResult {
    if let Err(e) = validate_rev(&to) {
        return ExportPatchResult::err(e);
    }
    if let Some(f) = &from {
        if let Err(e) = validate_rev(f) {
            return ExportPatchResult::err(e);
        }
    }
    if let Err(e) = validate_dest_path(&dest) {
        return ExportPatchResult::err(e);
    }

    let repo = match crate::trust::open_repo(&path) {
        Ok(r) => r,
        Err(e) => return ExportPatchResult::err(format!("Cannot open repository: {}", e.message())),
    };
    // Fail fast with a clean message before ever spawning format-patch — same
    // "resolve via git2 first" discipline as git_rebase.rs's resolve_oid.
    let to_commit = match repo.revparse_single(&to).and_then(|o| o.peel_to_commit()) {
        Ok(c) => c,
        Err(e) => return ExportPatchResult::err(format!("Cannot resolve revision {to:?}: {}", e.message())),
    };
    if from.is_none() && to_commit.parent_count() > 1 {
        return ExportPatchResult::err(
            "Can't export a merge commit as a single patch — format-patch has no single unambiguous diff for a \
             merge (git itself would silently export its FIRST PARENT's commit instead, not the merge). \
             Use Export Patches\u{2026} with an explicit revision range instead.",
        );
    }
    if let Some(f) = &from {
        if let Err(e) = repo.revparse_single(f) {
            return ExportPatchResult::err(format!("Cannot resolve revision {f:?}: {}", e.message()));
        }
    }

    let range_arg = match &from {
        Some(f) => format!("{f}..{to}"),
        None => to.clone(),
    };
    let mut args: Vec<&str> = vec!["format-patch", "--stdout"];
    if from.is_none() {
        args.push("-1");
    }
    args.push("--end-of-options");
    args.push(&range_arg);

    let out = match run_format_patch(&path, &args) {
        Ok(o) => o,
        Err(e) => return ExportPatchResult::err(e),
    };
    if !out.ok {
        return ExportPatchResult::err(if !out.stderr.is_empty() {
            out.stderr
        } else {
            "git format-patch failed.".into()
        });
    }
    if out.stdout.trim().is_empty() {
        return ExportPatchResult::err("Nothing to export — that range contains no commits.");
    }
    // Ground truth for mboxrd escaping (see module doc's "Mbox 'From '
    // ambiguity" section) — the exact, ordered set of shas this blob
    // actually contains, so any OTHER "From "-shaped line (commit-message
    // body content, not a real boundary) gets escaped before it ever
    // reaches disk / a later `git am`.
    let shas = match commit_shas_oldest_first(&repo, from.as_deref(), &to_commit) {
        Ok(s) => s,
        Err(e) => return ExportPatchResult::err(e),
    };
    let escaped = mboxrd_escape(&out.stdout, &shas);
    if let Err(e) = std::fs::write(&dest, &escaped) {
        return ExportPatchResult::err(format!("Could not write {dest}: {e}"));
    }
    let n = shas.len();
    ExportPatchResult::ok_msg(format!("Exported {n} commit{} to {dest}.", if n == 1 { "" } else { "s" }))
}

/// Apply a mailbox-format `.patch` file (as `git format-patch --stdout`
/// produces — one or many commits, one file) via `git am --3way`. Snapshots
/// FIRST, like every other history-mutating command in this codebase.
/// `--3way` is mandatory — see module doc: without it, a failed am leaves NO
/// index conflict stages for the Resolver to show at all.
///
/// Refuses to start on top of ANY other in-progress sequencer op (mirrors
/// git_merge.rs's `merge_squash`'s own `other_op_in_progress`-style guard — a
/// new top-level "start" command, not one nested inside an existing op, so it
/// checks `repo.state() != Clean` broadly, not just this module's own kind).
///
/// JS: `invoke("apply_patch", { path, patchFilePath })`.
#[tauri::command]
#[specta::specta]
pub fn apply_patch(path: String, patch_file_path: String) -> ApplyPatchResult {
    if let Err(e) = validate_patch_file(&patch_file_path) {
        return ApplyPatchResult::error(e);
    }
    let repo = match crate::trust::open_repo(&path) {
        Ok(r) => r,
        Err(e) => return ApplyPatchResult::error(format!("Cannot open repository: {}", e.message())),
    };
    if !matches!(repo.state(), RepositoryState::Clean) {
        return ApplyPatchResult::error("Another operation is already in progress — resolve or abort it first.");
    }
    let backup = match crate::safety::snapshot(&repo) {
        Ok(b) => b,
        Err(e) => return ApplyPatchResult::error(format!("Safety snapshot failed, aborting: {e}")),
    };
    // --patch-format=mboxrd: undoes export_patch's own mboxrd escaping (see
    // module doc's "Mbox 'From ' ambiguity" section) for a patch this app
    // exported; a no-op for a patch that never needed escaping (an ordinary
    // external patch with no colliding body lines applies identically
    // either way — empirically verified).
    let out = match git(&path, &["am", "--3way", "--patch-format=mboxrd", "--end-of-options", &patch_file_path], true) {
        Ok(o) => o,
        Err(e) => {
            return ApplyPatchResult {
                ok: false,
                state: "error".into(),
                conflicted_files: Vec::new(),
                message: e,
                backup_ref: Some(backup),
            }
        }
    };
    let mut result = classify_am(&repo, &path, &out, Some(backup));
    if result.state == "clean" {
        let n = count_applied(&out.stdout).max(1);
        result.message = format!("Applied {n} commit{} via git am.", if n == 1 { "" } else { "s" });
    }
    result
}

/// Continue an in-progress `git am --3way` after conflicts were resolved
/// (files `git add`ed by the Resolver — SAME `resolve_conflict_file` path a
/// rebase/merge/cherry-pick conflict already uses). Runs literally
/// `git am --continue` — NEVER `git rebase --continue`, which is
/// EMPIRICALLY CONFIRMED to fail outright against this state (see module
/// doc).
///
/// JS: `invoke("am_continue", { path })`.
#[tauri::command]
#[specta::specta]
pub fn am_continue(path: String) -> ApplyPatchResult {
    let repo = match crate::trust::open_repo(&path) {
        Ok(r) => r,
        Err(e) => return ApplyPatchResult::error(format!("Cannot open repository: {}", e.message())),
    };
    if repo.state() != RepositoryState::ApplyMailbox {
        return ApplyPatchResult::error("No patch-apply in progress to continue.");
    }
    let backup = crate::safety::snapshot(&repo).ok(); // best-effort, mirrors rebase_continue
    let out = match git(&path, &["am", "--continue"], true) {
        Ok(o) => o,
        Err(e) => {
            return ApplyPatchResult {
                ok: false,
                state: "error".into(),
                conflicted_files: Vec::new(),
                message: e,
                backup_ref: backup,
            }
        }
    };
    let mut result = classify_am(&repo, &path, &out, backup);
    if result.state == "clean" {
        result.message = format!("Conflict resolved — {}", result.message.to_lowercase());
    }
    result
}

/// Drop the patch the am session is currently stopped on entirely
/// (`git am --skip`) — mirrors `rebase_skip`'s exact "may land on the NEXT
/// conflicting patch, re-classify accordingly" semantics (empirically
/// confirmed for the analogous rebase case; the same state-inspection logic
/// applies here unchanged).
///
/// JS: `invoke("am_skip", { path })`.
#[tauri::command]
#[specta::specta]
pub fn am_skip(path: String) -> ApplyPatchResult {
    let repo = match crate::trust::open_repo(&path) {
        Ok(r) => r,
        Err(e) => return ApplyPatchResult::error(format!("Cannot open repository: {}", e.message())),
    };
    if repo.state() != RepositoryState::ApplyMailbox {
        return ApplyPatchResult::error("No patch-apply in progress to skip a commit from.");
    }
    let backup = crate::safety::snapshot(&repo).ok();
    let out = match git(&path, &["am", "--skip"], true) {
        Ok(o) => o,
        Err(e) => {
            return ApplyPatchResult {
                ok: false,
                state: "error".into(),
                conflicted_files: Vec::new(),
                message: e,
                backup_ref: backup,
            }
        }
    };
    let mut result = classify_am(&repo, &path, &out, backup);
    if result.state == "clean" {
        result.message = format!("Skipped that commit — {}", result.message);
    }
    result
}

/// Abort an in-progress `git am` (`git am --abort`) — restores pre-am HEAD
/// exactly (EMPIRICALLY VERIFIED). Deliberately NO snapshot — same "the
/// escape hatch must ALWAYS run" discipline as `rebase_abort`. Idempotent.
///
/// JS: `invoke("am_abort", { path })`.
#[tauri::command]
#[specta::specta]
pub fn am_abort(path: String) -> ApplyPatchResult {
    let repo = match crate::trust::open_repo(&path) {
        Ok(r) => r,
        Err(e) => return ApplyPatchResult::error(format!("Cannot open repository: {}", e.message())),
    };
    if repo.state() != RepositoryState::ApplyMailbox {
        return ApplyPatchResult {
            ok: true,
            state: "clean".into(),
            conflicted_files: Vec::new(),
            message: "No patch-apply in progress.".into(),
            backup_ref: None,
        };
    }
    match git(&path, &["am", "--abort"], false) {
        Ok(o) if o.ok => ApplyPatchResult {
            ok: true,
            state: "clean".into(),
            conflicted_files: Vec::new(),
            message: "Patch-apply aborted — back to the pre-apply state.".into(),
            backup_ref: None,
        },
        Ok(o) => ApplyPatchResult::error(git_msg(&o)),
        Err(e) => ApplyPatchResult::error(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_applied_counts_stdout_applying_lines_not_stderr() {
        // Regression guard for the stdout/stderr mixup this module's own
        // empirical re-check caught: `git am`'s "Applying: " lines are on
        // stdout (verified against real `git am --3way` / `--continue` runs),
        // so `count_applied` must read `out.stdout`, never `out.stderr`.
        let stdout = "Applying: first commit\nApplying: second commit\n";
        assert_eq!(count_applied(stdout), 2);
        let stderr_only = "Recorded resolution for 'f.txt'.\n";
        assert_eq!(count_applied(stderr_only), 0);
    }

    #[test]
    fn mboxrd_escape_leaves_real_boundaries_alone_and_escapes_only_lookalikes() {
        let sha1 = "1111111111111111111111111111111111111111";
        let sha2 = "2222222222222222222222222222222222222222";
        // A body line that looks exactly like a real boundary (adversarial
        // repro: a commit message body containing a full 40-hex-char sha +
        // date-shaped text) must be escaped, since it is NOT the next
        // expected real sha in order.
        let blob = format!(
            "From {sha1} Mon Sep 17 00:00:00 2001\nFrom: A\n\n\
             a lookalike body line:\nFrom 3333333333333333333333333333333333333333 Mon Sep 17 00:00:00 2001\n\n\
             From {sha2} Mon Sep 17 00:00:00 2001\nFrom: B\n\nordinary body text\n"
        );
        let escaped = mboxrd_escape(&blob, &[sha1.to_string(), sha2.to_string()]);
        assert!(escaped.contains(&format!("From {sha1} ")), "real first boundary must survive unescaped");
        assert!(escaped.contains(&format!("From {sha2} ")), "real second boundary must survive unescaped");
        assert!(
            escaped.contains(">From 3333333333333333333333333333333333333333 "),
            "the lookalike body line must be escaped with a leading '>': {escaped:?}"
        );
    }

    #[test]
    fn mboxrd_escape_is_recursive_on_an_already_escaped_lookalike() {
        // A body line that already starts with ">From " (however unlikely)
        // must get exactly one MORE ">", per the real mboxrd rule — not left
        // alone, and not double-escaped into "?From " or similar.
        let sha1 = "1111111111111111111111111111111111111111";
        let blob = format!("From {sha1} Mon Sep 17 00:00:00 2001\nFrom: A\n\n>From nested\n");
        let escaped = mboxrd_escape(&blob, &[sha1.to_string()]);
        assert!(escaped.contains(">>From nested"), "an already-escaped lookalike must get one more '>': {escaped:?}");
    }

    #[test]
    fn validate_patch_file_rejects_flag_like_and_empty() {
        assert!(validate_patch_file("").is_err());
        assert!(validate_patch_file("-x").is_err());
        assert!(validate_patch_file("/tmp/foo.patch").is_ok());
    }

    #[test]
    fn validate_dest_path_rejects_only_empty_and_nul() {
        assert!(validate_dest_path("").is_err());
        assert!(validate_dest_path("/tmp/-leading-dash.patch").is_ok());
    }
}
