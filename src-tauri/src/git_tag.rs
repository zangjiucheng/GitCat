//! Tag lifecycle: create / delete. (`push_tag` lives in `git_remote.rs` — see
//! that module's doc comment for why.)
//!
//! Same shell-out-to-git-CLI-for-mutations model as `git_write.rs` (this
//! module's closest precedent: branch create/checkout/delete/rename). Reuses
//! `git_write::WriteResult` verbatim as its return type (rather than adding a
//! fourth `{ok, message, backup_ref}` copy that would be structurally
//! identical) but otherwise keeps its OWN private `run_git`/validation/helper
//! copies — matching this codebase's established convention (see
//! `git_remote.rs`'s own doc comment: "one small self-contained result type +
//! git-runner per operation module, not a shared cross-module helper
//! surface") for everything that ISN'T just reusing that one shared shape.
//!
//! SAFETY — this module's one subtle point, and the whole reason it has a
//! long comment instead of just mirroring `git_write.rs`:
//!   * [`create_tag`] takes NO snapshot. Creating a tag is purely additive —
//!     it doesn't move HEAD, doesn't move any branch, and doesn't make any
//!     currently-reachable commit unreachable. There is nothing for a
//!     snapshot to protect.
//!   * [`delete_tag`] is the one that needs care, and it does NOT call
//!     `crate::safety::snapshot()` — that would be actively MISLEADING, not
//!     just unnecessary. `safety::snapshot()` pins HEAD and records a
//!     `refs/heads/*` topology map (see its own doc comment), and
//!     `safety::undo()`'s full-repo ref restore (M2c) only ever replays THAT
//!     map — it has no idea `refs/tags/*` exists. Taking a HEAD snapshot
//!     before deleting a tag would populate `WriteResult.backup_ref` and
//!     make the UI imply "this is Undo-able", exactly the false promise this
//!     codebase already learned to avoid: `safety::pin_deleted_tip` (branch
//!     tips) and `workdir::pin_dropped_stash` (dropped stashes) both exist
//!     BECAUSE "snapshot HEAD" does not make a non-branch ref recoverable.
//!     Deleting a tag has the identical shape of problem, so [`delete_tag`]
//!     follows the identical fix: pin the tag's own current target under a
//!     dedicated, never-an-undo-target namespace (`refs/gitgui/deleted-tag/*`,
//!     via [`pin_deleted_tag`] — same `<secs>-<nanos>-<seq>` naming scheme as
//!     those two precedents, just its own namespace/atomic counter, per this
//!     codebase's convention of a separate counter per ref namespace), BEFORE
//!     ever running `git tag -d`, and refuses the whole delete if that pin
//!     fails. The success message is explicit that recovery is via that
//!     pinned ref, NOT the global Undo (⌘Z) button.
//!   * The pin captures the tag ref's DIRECT target (`Reference::target()`,
//!     never peeled/dereferenced) rather than the commit it ultimately
//!     resolves to. For a lightweight tag those are the same object. For an
//!     ANNOTATED tag they are not: the ref points at a real tag object
//!     (message, tagger, date, optional GPG signature), which itself points
//!     at the commit. Pinning the peeled commit would silently let the tag
//!     object itself become unreachable and get gc'd, losing that metadata
//!     forever even though "the commit" looks recovered — pinning the direct
//!     target keeps the WHOLE thing (message included) reachable and
//!     inspectable via the pinned ref.
//!
//! Name validation: [`validate_tag_name`] is its own copy, not a reuse of
//! `git_write.rs`'s private `validate_branch_name` (which isn't `pub` anyway,
//! matching this codebase's per-module-copy convention). EMPIRICALLY VERIFIED
//! (real `git branch`/`git tag`, git 2.53): tag names and branch names are
//! governed by the identical `git check-ref-format`-derived character-class
//! restrictions in every case tried (control chars, space, `~^:?*[\`, `..`,
//! `@{`, `//`, leading/trailing `/`, trailing `.`, trailing `.lock`) — EXCEPT
//! `name == "@"`, which `git tag` itself refuses with a confusing, unrelated-
//! looking error (`fatal: no tag message?`, because a bare `git tag @` gets
//! reinterpreted rather than rejected cleanly), while `git branch -- "@"` is
//! accepted by this git version. `validate_branch_name` already excludes
//! `name == "@"` (defense-in-depth that wasn't strictly required for
//! branches) — mirroring that same exclusion here is what makes it actually
//! REQUIRED for tags, and gives the user a clear refusal instead of git's
//! confusing message.

use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{Oid, Repository};

use crate::git_write::WriteResult;

/// Process-wide monotonic tie-breaker for `refs/gitgui/deleted-tag/*` names —
/// its own counter (not shared with `safety.rs`'s `SNAP_SEQ` or `workdir.rs`'s
/// `STASH_SEQ`), since this names its own ref namespace. Same rationale as
/// those two.
static TAG_SEQ: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// WriteResult constructors (WriteResult's own `ok`/`err` inherent methods are
// private to git_write.rs, so this module builds the struct literal directly
// — its 3 fields are all `pub` — via these two small local wrappers, matching
// the shape of git_write.rs's own convenience constructors without colliding
// with their names.)
// ---------------------------------------------------------------------------

fn ok_result(message: impl Into<String>, backup_ref: Option<String>) -> WriteResult {
    WriteResult { ok: true, message: message.into(), backup_ref }
}

fn err_result(message: impl Into<String>) -> WriteResult {
    WriteResult { ok: false, message: message.into(), backup_ref: None }
}

// ---------------------------------------------------------------------------
// git CLI runner (own copy — see module doc comment)
// ---------------------------------------------------------------------------

struct GitOut {
    ok: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run_git(path: &str, args: &[&str]) -> Result<GitOut, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    Ok(GitOut {
        ok: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

fn git_error_message(out: &GitOut) -> String {
    if !out.stderr.is_empty() {
        out.stderr.clone()
    } else if !out.stdout.is_empty() {
        out.stdout.clone()
    } else {
        format!("git exited with status {:?}", out.code)
    }
}

// ---------------------------------------------------------------------------
// Validation (flag/injection guard) — see module doc comment for why this is
// its own copy and the one empirically-verified difference from branch names.
// ---------------------------------------------------------------------------

/// Reject anything that could be read as a flag or is not a legal tag name.
/// Defense-in-depth: every mutation below also passes `--end-of-options` so a
/// leading `-` can never be parsed as an option, but we still refuse it here
/// so the user gets a clear message instead of git's own (for `name == "@"`,
/// a genuinely confusing one — see module doc comment). `git_remote.rs`'s
/// `push_tag` keeps its own copy of this exact guard rather than importing it
/// from here — matching this codebase's established per-module-copy
/// convention (see this module's own doc comment).
fn validate_tag_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Tag name is empty.".into());
    }
    if name.starts_with('-') {
        return Err(format!("Refusing a tag name that looks like a flag: {name:?}"));
    }
    for ch in name.chars() {
        if ch.is_control() || ch == ' ' || ch == '\u{7f}' {
            return Err(format!("Tag name has an illegal whitespace/control character: {name:?}"));
        }
        if matches!(ch, '~' | '^' | ':' | '?' | '*' | '[' | '\\') {
            return Err(format!("Tag name has an illegal character '{ch}': {name:?}"));
        }
    }
    if name.contains("..")
        || name.contains("@{")
        || name.contains("//")
        || name.starts_with('/')
        || name.ends_with('/')
        || name.ends_with('.')
        || name.ends_with(".lock")
        || name == "@"
    {
        return Err(format!("Not a valid tag name: {name:?}"));
    }
    Ok(())
}

/// Lighter guard for a target commit-ish (may legitimately contain `~^:@{` as
/// in `main~2` or `HEAD@{1}`) — mirrors `git_write.rs`'s private
/// `validate_revision` exactly (same job: stop flag injection and control
/// chars; `--end-of-options` handles the rest at the CLI boundary).
fn validate_revision(rev: &str) -> Result<(), String> {
    if rev.is_empty() {
        return Err("Target is empty.".into());
    }
    if rev.starts_with('-') {
        return Err(format!("Refusing a target that looks like a flag: {rev:?}"));
    }
    if rev.chars().any(|c| c.is_control()) {
        return Err("Target has a control character.".into());
    }
    Ok(())
}

fn open_repo(path: &str) -> Result<Repository, WriteResult> {
    Repository::open(path).map_err(|e| err_result(format!("Cannot open repository: {}", e.message())))
}

// ---------------------------------------------------------------------------
// Safety net for delete_tag (see module doc comment)
// ---------------------------------------------------------------------------

/// Pin a deleted tag's CURRENT direct target under a fresh, dedicated ref so
/// it survives `git gc` and stays recoverable, but is NEVER a
/// `safety::undo()`/global-Undo target — see module doc comment for why this
/// exists and why it captures the DIRECT (unpeeled) target.
fn pin_deleted_tag(repo: &Repository, oid: Oid, name: &str) -> Result<String, String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let seq = TAG_SEQ.fetch_add(1, Ordering::SeqCst);
    let ref_name = format!("refs/gitgui/deleted-tag/{}-{}-{}", now.as_secs(), now.subsec_nanos(), seq);
    repo.reference(&ref_name, oid, false, &format!("gitcat pin deleted tag {name}"))
        .map_err(|e| format!("could not pin deleted tag: {}", e.message()))?;
    Ok(ref_name)
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/// Create a tag. `target` is an optional commit-ish; defaults to HEAD when
/// omitted (mirrors `create_branch`'s `start_point` handling exactly: the arg
/// is simply left off the git invocation and git itself defaults to HEAD —
/// no git2 read of HEAD needed on our side). `message` present -> an
/// annotated tag (`git tag -a -m <message> <name> [<target>]`); absent ->
/// lightweight (`git tag <name> [<target>]`). No snapshot — see module doc
/// comment for why creating a tag needs none.
/// JS call: `invoke("create_tag", { path, name, target?, message? })`.
#[tauri::command]
#[specta::specta]
pub fn create_tag(path: String, name: String, target: Option<String>, message: Option<String>) -> WriteResult {
    if let Err(e) = validate_tag_name(&name) {
        return err_result(e);
    }
    if let Some(t) = &target {
        if let Err(e) = validate_revision(t) {
            return err_result(e);
        }
    }

    let has_msg = message.as_deref().map(|m| !m.trim().is_empty()).unwrap_or(false);
    let mut args: Vec<&str> = vec!["tag"];
    if has_msg {
        args.push("-a");
        args.push("-m");
        args.push(message.as_deref().unwrap());
    }
    // --end-of-options must come AFTER -a/-m (EMPIRICALLY VERIFIED: placed
    // before them, git treats -a/-m themselves as positional args and fails
    // with "too many arguments") and BEFORE <name>/[<target>], guarding both.
    args.push("--end-of-options");
    args.push(&name);
    if let Some(t) = &target {
        args.push(t.as_str());
    }

    match run_git(&path, &args) {
        Ok(out) if out.ok => ok_result(
            format!("Created {} tag {name}.", if has_msg { "annotated" } else { "lightweight" }),
            None,
        ),
        // e.g. "fatal: tag '<name>' already exists"
        Ok(out) => err_result(git_error_message(&out)),
        Err(e) => err_result(e),
    }
}

/// Delete a tag. THE ONE THAT NEEDS CARE — see module doc comment. Pins the
/// tag's current direct target under `refs/gitgui/deleted-tag/*` BEFORE ever
/// running `git tag -d`, and refuses the whole delete if that pin fails. The
/// success message names the pinned ref directly and is explicit that
/// recovery is NOT via the global Undo (⌘Z) button.
/// JS call: `invoke("delete_tag", { path, name })`.
#[tauri::command]
#[specta::specta]
pub fn delete_tag(path: String, name: String) -> WriteResult {
    if let Err(e) = validate_tag_name(&name) {
        return err_result(e);
    }
    let repo = match open_repo(&path) {
        Ok(r) => r,
        Err(w) => return w,
    };

    // Resolve the tag's DIRECT target (never peeled — see module doc comment)
    // so an annotated tag's own object (message/tagger/signature) is what
    // gets pinned, not just the commit it ultimately points at.
    let full_ref = format!("refs/tags/{name}");
    let target = match repo.find_reference(&full_ref).ok().and_then(|r| r.target()) {
        Some(oid) => oid,
        None => return err_result(format!("Tag {name} does not exist.")),
    };
    let short_target: String = target.to_string().chars().take(7).collect();

    // Pin BEFORE ever mutating. Refuse the whole delete if we can't even back
    // it up first — never delete unbacked-up.
    let pin = match pin_deleted_tag(&repo, target, &name) {
        Ok(p) => p,
        Err(e) => return err_result(format!("Refusing to delete tag {name} — could not back it up first: {e}")),
    };

    match run_git(&path, &["tag", "-d", "--end-of-options", &name]) {
        Ok(out) if out.ok => ok_result(
            format!(
                "Deleted tag {name} (was {short_target}). This is NOT restorable via the global Undo \
                 (\u{2318}Z) — that only rewinds branches, never tags. Recover with: git tag {name} {pin}"
            ),
            Some(pin),
        ),
        // e.g. "error: tag '<name>' not found." — the pin ref is a harmless,
        // inert leftover in this case (matches `workdir::stash_drop`'s own
        // failure-after-pin behavior: it doesn't surface the pin either).
        Ok(out) => err_result(git_error_message(&out)),
        Err(e) => err_result(e),
    }
}
