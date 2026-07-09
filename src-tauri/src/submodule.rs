//! Submodule status (M1 of 4) + init/update (M2 of 4) + add/sync (M3 of 4).
//! deinit/remove/foreach are separate later milestones.
//!
//! Read-only, git2-based (mirrors `git_write::list_refs`'s read half): iterates
//! every submodule registered in `.gitmodules` via `Repository::submodules()`
//! and classifies each with `Repository::submodule_status(name, SubmoduleIgnore::None)`.
//!
//! Classification (empirically verified against real `git submodule status` in
//! a throwaway nested-submodule fixture — see the doc comment on
//! `classify_status` for the exact bit patterns observed for each of the 5
//! states, and how they line up with git's own `-`/`+`/` `/`U` prefixes):
//!   - "conflicted": the superproject's OWN index has an unresolved merge
//!     conflict at this submodule's gitlink path (two branches pointed the
//!     submodule at different commits, now conflicted). This is NOT one of
//!     `SubmoduleStatus`'s bits — verified empirically that none of them
//!     reliably fire for this case — so it's detected separately via
//!     `Index::conflicts()` (see `submodule_conflicted`) and takes priority
//!     over every bit-derived classification below (a conflicted gitlink entry
//!     can otherwise leave head_sha/workdir_sha looking plausible while the
//!     repo is genuinely mid-conflict).
//!   - "not-initialized": WD_UNINITIALIZED or WD_DELETED set (git's `-`
//!     prefix). WD_UNINITIALIZED is produced by a fresh `git clone` of the
//!     superproject with no `git submodule init/update` run afterward — NOT by
//!     `git submodule add`, which leaves the submodule immediately initialized
//!     *and* cloned. WD_DELETED is the sibling case: the submodule was
//!     manually `rm -rf`'d (not `git submodule deinit`'d) — "in index, not in
//!     workdir". Real `git submodule status` shows the same `-` prefix for
//!     both, so we fold them together too.
//!   - "out-of-date": WD_MODIFIED set (git's `+` prefix) — the commit actually
//!     checked out in the submodule's working tree differs from the commit the
//!     superproject's index/HEAD records for it (`Submodule::head_id()` !=
//!     `Submodule::workdir_id()`).
//!   - "dirty": WD_INDEX_MODIFIED, WD_WD_MODIFIED, or WD_UNTRACKED set — the
//!     submodule's own working tree (or its own index, for a staged-but-
//!     uncommitted change) differs from what it has committed. This is
//!     libgit2's own canonical "is dirty" bitset (see git2/submodule.h).
//!     NOTE: plain `git submodule status` does NOT surface this in its prefix
//!     (it stays a plain space); it only shows up via `git status --porcelain`
//!     (" M <path>") or `git diff --submodule` in the superproject. Verified
//!     empirically that git2 catches what the porcelain status line catches.
//!   - "clean": present, initialized, and none of the above — checked-out
//!     commit matches what's tracked, no local changes.
//! Priority when bits combine (e.g. WD_MODIFIED + WD_WD_MODIFIED, checked out
//! at the "wrong" commit AND locally modified) — verified this combination
//! empirically too: `git submodule status` still only ever reports `+`, never
//! a distinct "dirty AND out of date" state, so we mirror that and check
//! conflicted, then not-initialized, then out-of-date, then dirty, in that
//! order.
//!
//! ---------------------------------------------------------------------------
//! M2: `submodule_init` / `submodule_update` — mutations, CLI-shellout model.
//! ---------------------------------------------------------------------------
//!
//! Same shell-out-to-git-CLI-for-mutations model as `git_write.rs`/
//! `git_remote.rs` (git2 stays read-only everywhere in this codebase). Reuses
//! `git_write::WriteResult` verbatim as the return type (rather than adding a
//! fourth structurally-identical `{ok, message, backup_ref}` copy) but keeps
//! its own private `run_git`/validation helpers — matching `git_tag.rs`'s
//! precedent for "reuse the shared RESULT SHAPE, not a shared helper surface"
//! (see `git_remote.rs`'s own doc comment for why this codebase prefers one
//! self-contained runner per module over a shared cross-module helper).
//!
//! SAFETY MANAGER — neither command takes a snapshot, for two different reasons:
//!   * [`submodule_init`] only copies a URL (and, if set, a branch) from the
//!     superproject's committed `.gitmodules` into its OWN `.git/config`. It
//!     never touches a ref, the index, HEAD, or any working tree — there is
//!     nothing reachable-or-history-affecting for a snapshot to protect
//!     (identical reasoning to `git_tag.rs`'s `create_tag`: purely additive
//!     local bookkeeping, nothing for Undo to guard).
//!   * [`submodule_update`] moves HEAD and checks out files, but ONLY inside
//!     the *submodule's own separate `.git`* — never the superproject's HEAD,
//!     branches, or working tree (the gitlink entry the superproject itself
//!     tracks for that path is completely unchanged by this command; only
//!     what happens to be checked out AT that already-recorded commit
//!     changes). This is exactly `git_remote.rs`'s own "nothing local
//!     changes" reasoning for why plain `push` takes no snapshot — just one
//!     level down, inside the submodule's nested repo instead of a remote.
//!     The one real safety consideration — losing UNCOMMITTED work inside a
//!     dirty submodule's working tree — is handled a different way, below,
//!     not by a superproject snapshot (which couldn't protect it anyway: the
//!     Safety Manager only ever pins the SUPERPROJECT's refs, and a
//!     submodule's uncommitted-but-unstaged edits were never reachable from
//!     any ref in the first place, superproject or submodule).
//!
//! DIRTY-SUBMODULE SAFETY: never passes `--force`. Real git's OWN default
//! already refuses to check out over local modifications inside a submodule
//! ("error: Your local changes to the following files would be overwritten
//! by checkout ... Aborting" / "fatal: Unable to checkout '<sha>' in
//! submodule path '<path>'") — exactly this codebase's existing "never
//! force, surface git's own rejection" convention (`checkout`/`pull`). This
//! was EMPIRICALLY VERIFIED in a throwaway fixture before trusting it (and is
//! re-verified in `tests/submodule.rs`): a submodule whose tracked commit was
//! bumped out from under it (simulating a pulled superproject commit that
//! advanced the pointer) while its own working tree carried an uncommitted
//! edit to the very file that differs between the two commits — `git
//! submodule update` refused cleanly (non-zero exit, the message above), left
//! the uncommitted edit's content completely intact, and left the
//! submodule's own checked-out HEAD unmoved. No `--force` flag exists on
//! either command below to override that refusal.
//!
//! `submodule_init` and `submodule_update` are deliberately separate calls
//! (matching real `git submodule init` / `git submodule update` being
//! separate subcommands) so the UI can offer both a plain "Update" (assumes
//! already-registered/cloned; `init:false`) and a combined "Init + Update"
//! convenience for a never-initialized row (`init:true`, which folds
//! `submodule_init`'s registration step into the same `git submodule update
//! --init` invocation rather than requiring two round-trips).
//!
//! ---------------------------------------------------------------------------
//! M3: `submodule_add` / `submodule_sync` — new submodule + URL re-sync.
//! ---------------------------------------------------------------------------
//!
//! `--end-of-options` DOES NOT WORK HERE — EMPIRICALLY VERIFIED (git 2.53)
//! before writing either command below, since every other mutation in this
//! codebase leans on it: `git submodule add --end-of-options -- <url> <path>`
//! (and `git submodule sync --end-of-options -- <path>`) both fail outright
//! with git's own top-level USAGE error, never reaching the actual add/sync
//! logic. Unlike the plumbing commands this codebase's other modules shell
//! out to (`branch`, `tag`, `checkout`, ...), which all understand the
//! generic `--end-of-options` the top-level `git` driver provides,
//! `git-submodule` is its own porcelain argument parser (a wrapper script /
//! `submodule--helper` dispatch) that only recognizes a bare `--` to end
//! option parsing. So both commands below place a plain `--` immediately
//! before their positional args instead, exactly like real `git submodule
//! add`/`sync --help`'s own usage grammar shows, and rely on
//! `validate_repository_url`/`validate_branch_name`/`validate_submodule_path`
//! rejecting anything that starts with `-` before it ever reaches the CLI —
//! same defense-in-depth split this codebase already uses everywhere else,
//! just with `--` standing in for `--end-of-options` for this one git
//! subcommand family.
//!
//! PATH COLLISION (`submodule_add`'s `submodule_path` already exists, or is
//! already a registered submodule): NO Rust-side pre-check — EMPIRICALLY
//! VERIFIED (git 2.53, throwaway fixture, every colliding case tried) that
//! real `git submodule add` already refuses cleanly and unambiguously on its
//! own:
//!   - a tracked file OR tracked directory already at that path: "fatal:
//!     '<path>' already exists in the index"
//!   - an untracked directory in the way, whether empty or with untracked
//!     content: "fatal: '<path>' already exists and is not a valid git repo"
//!   - a path that's already a registered submodule (its gitlink already in
//!     the index from a prior `add`): also "fatal: '<path>' already exists in
//!     the index" (same message as the first case — plausible, since a
//!     registered submodule's gitlink IS an index entry)
//! All three are already specific about WHY the path is unusable, so a
//! redundant Rust-side existence/registration check would only duplicate
//! git's own clean refusal, not add real signal over it — surfaced verbatim
//! below, matching this codebase's existing "never force, surface git's own
//! rejection" convention (`checkout`/`pull`/`submodule_update`'s own dirty-
//! submodule refusal above).
//!
//! No snapshot on either command:
//!   * [`submodule_add`] clones a new submodule, adds one new `.gitmodules`
//!     entry, and stages both — purely additive (a new gitlink + a new
//!     tracked file, both freshly staged, nothing committed yet). Nothing
//!     reachable becomes unreachable and no ref moves — identical reasoning
//!     to `create_branch`/`create_tag`'s own no-snapshot rationale for
//!     additive-only operations.
//!   * [`submodule_sync`] only rewrites entries under `submodule.*` in the
//!     superproject's OWN `.git/config` from what's currently committed in
//!     `.gitmodules` — no ref moves, no index/workdir change, nothing
//!     history-affecting for Undo to protect (needed after someone hand-edits
//!     `.gitmodules`'s `url` field directly, e.g. by hand or via a merge —
//!     that edit alone never updates `.git/config`; `git submodule sync` is
//!     the dedicated command that copies it over, verified empirically in
//!     `tests/submodule.rs` by reading `.git/config` directly before/after).

use std::process::Command;

use git2::SubmoduleIgnore;
use serde::Serialize;

use crate::git_write::WriteResult;

/// One `.gitmodules`-registered submodule row.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleInfo {
    pub name: String,
    pub path: String,
    pub url: Option<String>,
    /// "conflicted" | "not-initialized" | "out-of-date" | "dirty" | "clean"
    pub status: String,
    /// Commit the superproject's index/HEAD tracks for this submodule.
    pub head_sha: Option<String>,
    /// Commit actually checked out in the submodule's working tree, or `None`
    /// when it has never been cloned (not-initialized).
    pub workdir_sha: Option<String>,
}

/// Tauri command: list every `.gitmodules`-registered submodule with a status
/// classification. Read-only (git2) — never mutates.
/// JS call: `invoke("submodule_status", { path })`.
#[tauri::command]
#[specta::specta]
pub fn submodule_status(path: String) -> Result<Vec<SubmoduleInfo>, String> {
    submodule_status_inner(&path).map_err(|e| e.message().to_string())
}

fn submodule_status_inner(path: &str) -> Result<Vec<SubmoduleInfo>, git2::Error> {
    let repo = crate::trust::open_repo(path)?;

    let mut out = Vec::new();
    for sm in repo.submodules()? {
        let name = sm.name().unwrap_or_default().to_string();
        let sm_path = sm.path().to_string_lossy().to_string();
        let url = sm.url().map(|s| s.to_string());
        let head_sha = sm.head_id().map(|oid| oid.to_string());
        let workdir_sha = sm.workdir_id().map(|oid| oid.to_string());

        // submodule_status() wants the registered name, not the path (they're
        // usually equal, but name is the documented lookup key).
        let bits = repo.submodule_status(&name, SubmoduleIgnore::None)?;
        // Checked BEFORE the bit-derived classification: a merge-conflicted
        // gitlink entry doesn't reliably set any `SubmoduleStatus` bit (see
        // the module doc comment), so every bit-derived arm would otherwise
        // fall through to "clean" despite the repo genuinely being mid-conflict
        // at this exact path.
        let status = if submodule_conflicted(&repo, &sm_path)? {
            "conflicted".to_string()
        } else {
            classify_status(bits)
        };

        out.push(SubmoduleInfo { name, path: sm_path, url, status, head_sha, workdir_sha });
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Map a `SubmoduleStatus` bitset to one of the 4 bit-derived UI-facing
/// classifications ("conflicted" is handled separately — see
/// `submodule_conflicted` — since it isn't a `SubmoduleStatus` bit at all).
/// See the module doc comment for the empirical verification behind each arm.
fn classify_status(bits: git2::SubmoduleStatus) -> String {
    use git2::SubmoduleStatus as S;
    if bits.contains(S::WD_UNINITIALIZED) || bits.contains(S::WD_DELETED) {
        "not-initialized".to_string()
    } else if bits.contains(S::WD_MODIFIED) {
        "out-of-date".to_string()
    } else if bits.contains(S::WD_INDEX_MODIFIED)
        || bits.contains(S::WD_WD_MODIFIED)
        || bits.contains(S::WD_UNTRACKED)
    {
        "dirty".to_string()
    } else {
        "clean".to_string()
    }
}

/// True if the superproject's index has an unresolved merge conflict AT
/// `sm_path` specifically — i.e. the submodule's own gitlink entry is itself
/// one of the conflicting stages, not just "the repo has some conflict
/// somewhere". Mirrors `conflict.rs`'s own index-conflict walk
/// (`read_conflicts`/`conflict_path`), matching each conflict's path (taken
/// from whichever stage is present) against `sm_path`.
///
/// `Index::has_conflicts()` is checked first purely as a cheap short-circuit
/// (avoids allocating the conflict iterator on the overwhelmingly common
/// case of a repo with no conflicts at all) — the real, path-specific test is
/// the loop below, not `repo.state()`: `state()` only says the repo AS A
/// WHOLE is mid-merge/rebase/etc, not that THIS gitlink is one of the
/// unresolved entries, and a stray unrelated conflict elsewhere in the tree
/// must not paint an unrelated, cleanly-tracked submodule as "conflicted".
fn submodule_conflicted(repo: &git2::Repository, sm_path: &str) -> Result<bool, git2::Error> {
    let index = repo.index()?;
    if !index.has_conflicts() {
        return Ok(false);
    }
    let sm_path_bytes = sm_path.as_bytes();
    for conflict in index.conflicts()? {
        let conflict = conflict?;
        let matches = |e: &Option<git2::IndexEntry>| e.as_ref().is_some_and(|e| e.path == sm_path_bytes);
        if matches(&conflict.ancestor) || matches(&conflict.our) || matches(&conflict.their) {
            return Ok(true);
        }
    }
    Ok(false)
}

// ---------------------------------------------------------------------------
// M2: init / update (own git-CLI runner — see module doc comment for why this
// isn't shared with git_write.rs/git_remote.rs beyond the WriteResult shape)
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

/// `WriteResult`'s `ok`/`err` constructors are private to `git_write.rs`, so
/// this module builds the struct literal directly (all 3 fields are `pub`) —
/// same pattern as `git_tag.rs`'s own `ok_result`/`err_result` wrappers.
fn ok_result(message: impl Into<String>, backup_ref: Option<String>) -> WriteResult {
    WriteResult { ok: true, message: message.into(), backup_ref }
}
fn err_result(message: impl Into<String>) -> WriteResult {
    WriteResult { ok: false, message: message.into(), backup_ref: None }
}

/// Reject anything that could be read as a flag or carries a control
/// character. Deliberately looser than `git_write.rs`'s `validate_branch_name`
/// — a submodule path legitimately contains `/` (nested paths) — this just
/// catches the obviously-wrong cases with a clear message; the `--` this
/// module always places before the path is the real defense (everything after
/// it is a pathspec to git, never an option).
fn validate_submodule_path(p: &str) -> Result<(), String> {
    if p.is_empty() {
        return Err("Submodule path is empty.".into());
    }
    if p.starts_with('-') {
        return Err(format!("Refusing a submodule path that looks like a flag: {p:?}"));
    }
    if p.chars().any(|c| c.is_control()) {
        return Err(format!("Submodule path has a control character: {p:?}"));
    }
    Ok(())
}

/// Register `submodule_path`'s URL (and branch, if `.gitmodules` sets one)
/// into the superproject's OWN `.git/config` (`git submodule init -- <path>`)
/// — does NOT clone. The overwhelmingly common precondition for
/// `submodule_update` on a submodule that has never been cloned (a fresh
/// clone of the superproject, or one manually `rm -rf`'d — both read as
/// "not-initialized" in `submodule_status`); use `submodule_update` with
/// `init:true` instead to fold both steps into one call.
/// JS call: `invoke("submodule_init", { path, submodulePath })`.
#[tauri::command]
#[specta::specta]
pub fn submodule_init(path: String, submodule_path: String) -> WriteResult {
    if let Err(e) = validate_submodule_path(&submodule_path) {
        return err_result(e);
    }
    match run_git(&path, &["submodule", "init", "--", &submodule_path]) {
        Ok(out) if out.ok => ok_result(format!("Initialized submodule {submodule_path}."), None),
        // e.g. "fatal: no submodule mapping found in .gitmodules for path '<path>'"
        Ok(out) => err_result(git_error_message(&out)),
        Err(e) => err_result(e),
    }
}

/// Clone/checkout submodule(s) to the commit(s) the superproject's index
/// tracks (`git submodule update`).
///
/// - `submodule_path: None` updates EVERY registered submodule in one
///   invocation (no path restriction at all) — the bulk "Update all" action.
///   `Some(p)` restricts to just that one path (`-- <p>`).
/// - `init: true` adds `--init`, folding a never-run `submodule_init` into
///   this same call (clone-if-never-cloned) — the "Init + Update"
///   convenience. `init: false` is the plain "Update" action: it requires the
///   submodule to already be registered+cloned (an update on a
///   not-initialized submodule with `init:false` is a no-op as far as that
///   path is concerned — real git silently skips it rather than erroring,
///   since there is nothing registered yet for it to act on).
/// - `recursive: true` adds `--recursive`, so a freshly-checked-out
///   submodule's OWN submodules (a submodule-of-a-submodule) are inited/
///   updated too, in the same call.
///
/// Never passes `--force`. See this module's doc comment for the empirically
/// verified refusal git's own default already gives when an update would
/// clobber uncommitted changes inside a submodule's working tree — that
/// refusal surfaces here verbatim as `ok:false`, exactly like `checkout`/
/// `pull`'s existing "never force" convention.
///
/// No Safety Manager snapshot: this only ever touches the SUBMODULE's own
/// separate `.git` (its own HEAD/index/workdir) — never the superproject's
/// HEAD, a branch, or its working tree — identical reasoning to plain
/// `push`'s own "nothing local changes" rationale in `git_remote.rs`. And the
/// one real risk a snapshot might otherwise exist to cover — clobbering
/// uncommitted submodule changes — is already prevented by git's own refusal
/// above, not by anything a superproject-level snapshot could restore anyway.
/// JS call: `invoke("submodule_update", { path, submodulePath?, recursive, init })`.
#[tauri::command]
#[specta::specta]
pub fn submodule_update(path: String, submodule_path: Option<String>, recursive: bool, init: bool) -> WriteResult {
    if let Some(p) = &submodule_path {
        if let Err(e) = validate_submodule_path(p) {
            return err_result(e);
        }
    }
    let mut args: Vec<&str> = vec!["submodule", "update"];
    if init {
        args.push("--init");
    }
    if recursive {
        args.push("--recursive");
    }
    if let Some(p) = &submodule_path {
        args.push("--");
        args.push(p.as_str());
    }
    match run_git(&path, &args) {
        Ok(out) if out.ok => ok_result(
            match &submodule_path {
                Some(p) => format!("Updated submodule {p}."),
                None => "Updated all submodules.".to_string(),
            },
            None,
        ),
        // e.g. "error: Your local changes to the following files would be
        // overwritten by checkout ... Aborting" — never forced, surfaced verbatim.
        Ok(out) => err_result(git_error_message(&out)),
        Err(e) => err_result(e),
    }
}

// ---------------------------------------------------------------------------
// M3: add / sync (see module doc comment for the empirically-verified
// `--end-of-options` incompatibility and the path-collision decision)
// ---------------------------------------------------------------------------

/// Reject anything that could be read as a flag or carries a control
/// character. Deliberately MUCH looser than `validate_branch_name` below (or
/// `git_tag.rs`'s `validate_tag_name`) — a repository URL legitimately
/// contains characters those name validators reject outright: `:` and `/` in
/// `https://host/path`, `~` in an scp-like `git@host:~user/repo.git`, `@`
/// separating user from host, `?`/`*`/`[` in an http(s) query string or a
/// bracketed IPv6 host. Reusing either name validator here would wrongly
/// refuse perfectly valid URLs (the exact mistake this module's doc comment
/// warns against). The bare `--` this command always places right before the
/// URL (see module doc comment for why not `--end-of-options` here
/// specifically) is the real defense; this just catches the obviously-wrong
/// cases with a clear message — same posture as `validate_revision` in
/// `git_write.rs`/`git_tag.rs`.
fn validate_repository_url(url: &str) -> Result<(), String> {
    if url.is_empty() {
        return Err("Repository URL is empty.".into());
    }
    if url.starts_with('-') {
        return Err(format!("Refusing a repository URL that looks like a flag: {url:?}"));
    }
    if url.chars().any(|c| c.is_control()) {
        return Err(format!("Repository URL has a control character: {url:?}"));
    }
    Ok(())
}

/// Own copy of `git_write.rs`'s `validate_branch_name` (same per-module-copy
/// convention `git_tag.rs`/`git_remote.rs` already follow for this exact
/// guard) — `submodule_add`'s `branch` is raw user input identical in shape
/// to a branch name anywhere else in this codebase (it becomes
/// `submodule.<name>.branch` in `.gitmodules` and is checked out with a plain
/// `git checkout <branch>` inside the new submodule), so it gets the
/// identical flag-injection/ref-name guard.
fn validate_branch_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Branch name is empty.".into());
    }
    if name.starts_with('-') {
        return Err(format!("Refusing a branch name that looks like a flag: {name:?}"));
    }
    for ch in name.chars() {
        if ch.is_control() || ch == ' ' || ch == '\u{7f}' {
            return Err(format!("Branch name has an illegal whitespace/control character: {name:?}"));
        }
        if matches!(ch, '~' | '^' | ':' | '?' | '*' | '[' | '\\') {
            return Err(format!("Branch name has an illegal character '{ch}': {name:?}"));
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
        return Err(format!("Not a valid branch name: {name:?}"));
    }
    Ok(())
}

/// Clone `repository_url` as a brand-new submodule at `submodule_path`,
/// registering it in `.gitmodules` and staging both the new gitlink and the
/// new `.gitmodules` entry (`git submodule add`) — mirrors real `git
/// submodule add` exactly: clone + register + stage, nothing committed.
///
/// `branch`, when set, checks out that branch inside the freshly cloned
/// submodule instead of the remote's default branch (`-b <branch>`), and
/// records `submodule.<name>.branch = <branch>` in `.gitmodules` too — real
/// git's own behavior, not something this command adds on top.
///
/// No pre-check for `submodule_path` colliding with an existing file/
/// directory or an already-registered submodule — see module doc comment for
/// the empirical verification behind that decision; git's own refusal is
/// surfaced verbatim below.
///
/// No snapshot — see module doc comment (purely additive, identical
/// reasoning to `create_branch`/`create_tag`).
/// JS call: `invoke("submodule_add", { path, repositoryUrl, submodulePath, branch? })`.
#[tauri::command]
#[specta::specta]
pub fn submodule_add(
    path: String,
    repository_url: String,
    submodule_path: String,
    branch: Option<String>,
) -> WriteResult {
    if let Err(e) = validate_repository_url(&repository_url) {
        return err_result(e);
    }
    if let Err(e) = validate_submodule_path(&submodule_path) {
        return err_result(e);
    }
    if let Some(b) = &branch {
        if let Err(e) = validate_branch_name(b) {
            return err_result(e);
        }
    }

    let mut args: Vec<&str> = vec!["submodule", "add"];
    if let Some(b) = &branch {
        args.push("-b");
        args.push(b.as_str());
    }
    // Bare `--`, NOT `--end-of-options` — see module doc comment.
    args.push("--");
    args.push(&repository_url);
    args.push(&submodule_path);

    match run_git(&path, &args) {
        Ok(out) if out.ok => ok_result(
            match &branch {
                Some(b) => format!("Added submodule {submodule_path} (branch {b})."),
                None => format!("Added submodule {submodule_path}."),
            },
            None,
        ),
        // e.g. "fatal: '<path>' already exists in the index" / "fatal:
        // '<path>' already exists and is not a valid git repo" — see module
        // doc comment for why no pre-check duplicates this.
        Ok(out) => err_result(git_error_message(&out)),
        Err(e) => err_result(e),
    }
}

/// Rewrite the superproject's OWN `.git/config` entries for submodule(s)'
/// configured remote URL from whatever is CURRENTLY committed in
/// `.gitmodules` (`git submodule sync`) — needed after someone hand-edits
/// `.gitmodules`'s `url` field directly (by hand, or via a merge): that edit
/// alone never touches `.git/config`, and a plain `submodule_update` still
/// fetches from the STALE `.git/config` url until a sync rewrites it.
///
/// - `submodule_path: None` syncs EVERY registered submodule in one
///   invocation (no path restriction at all) — mirrors `submodule_update`'s
///   own None-means-all convention exactly. `Some(p)` restricts to just that
///   one path (`-- <p>`).
/// - `recursive: true` adds `--recursive`, so a submodule's OWN nested
///   submodules (a submodule-of-a-submodule) get their urls synced too, in
///   the same call.
///
/// No snapshot: only ever rewrites `.git/config` — no ref moves, no index/
/// workdir change, nothing history-affecting for Undo to protect.
/// JS call: `invoke("submodule_sync", { path, submodulePath?, recursive })`.
#[tauri::command]
#[specta::specta]
pub fn submodule_sync(path: String, submodule_path: Option<String>, recursive: bool) -> WriteResult {
    if let Some(p) = &submodule_path {
        if let Err(e) = validate_submodule_path(p) {
            return err_result(e);
        }
    }
    let mut args: Vec<&str> = vec!["submodule", "sync"];
    if recursive {
        args.push("--recursive");
    }
    if let Some(p) = &submodule_path {
        // Bare `--`, NOT `--end-of-options` — see module doc comment.
        args.push("--");
        args.push(p.as_str());
    }
    match run_git(&path, &args) {
        Ok(out) if out.ok => ok_result(
            match &submodule_path {
                Some(p) => format!("Synced submodule {p}."),
                None => "Synced all submodules.".to_string(),
            },
            None,
        ),
        Ok(out) => err_result(git_error_message(&out)),
        Err(e) => err_result(e),
    }
}
