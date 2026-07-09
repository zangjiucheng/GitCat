//! Submodule status (M1) + init/update (M2) + add/sync (M3) + deinit/remove
//! (M4) + foreach (M5, final milestone): run an arbitrary user-supplied shell
//! command in every initialized submodule's own working directory, with live
//! progress and cancellation. See this file's own M5 section doc comment
//! (below the M4 section) for the foreach design.
//!
//! Read-only, git2-based (mirrors `git_write::list_refs`'s read half): iterates
//! every submodule registered in `.gitmodules` via `Repository::submodules()`
//! and classifies each with `Repository::submodule_status(name, SubmoduleIgnore::None)`.
//!
//! Classification (empirically verified against real `git submodule status` in
//! a throwaway nested-submodule fixture — see the doc comment on
//! `classify_status` for the exact bit patterns observed for each of the 6
//! bit/index-derived states, and how they line up with git's own `-`/`+`/`
//! `/`U` prefixes; there is a 7th, `submodule_status`-specific state,
//! "unreadable", layered on top of all of them — see its own bullet below):
//!   - "unreadable": CRASH FIX, added after `submodule_foreach`'s own
//!     unbounded-recursion stack-overflow crash (see this file's M5 section,
//!     `discover_nested_targets`'s doc comment for the full empirically
//!     confirmed mechanism) turned out to be independently reachable through
//!     THIS function too — `submodule_status_inner` also unconditionally
//!     called `repo.submodule_status(name, ..)` for every top-level
//!     submodule, with no cycle check at all. That call itself is what
//!     stack-overflows (crashing the ENTIRE application process) when asked
//!     about a submodule whose own resolved git directory, or ANYTHING
//!     reachable in its nested-submodule subtree at any depth, is cyclic
//!     (a malformed or maliciously crafted `.git` gitfile pointer) — and,
//!     more surprisingly, the identical crash fires for any ANCESTOR of the
//!     cyclic node too, not just the offending submodule itself. This is a
//!     materially bigger blast radius than the foreach crash: `submodule_status`
//!     runs AUTOMATICALLY every time a repo is opened (the sidebar's own
//!     `refreshSubmodules()`), so an unguarded call here crashed the whole app
//!     just from OPENING a third-party/untrusted repo containing such a
//!     submodule — no foreach sweep, no opt-in action, needed. Fixed by
//!     `check_submodule_safe_for_status`, which verifies (reusing the exact
//!     canonicalize-and-track-visited-paths mechanism `check_safe_to_recurse`/
//!     `discover_nested_targets` already established for the foreach fix)
//!     that a top-level submodule's ENTIRE reachable subtree is confirmed
//!     cycle-free BEFORE `submodule_status_inner` ever calls
//!     `repo.submodule_status()` on it. When it is not, "unreadable" is
//!     reported directly and `submodule_status` is never called for that row
//!     at all — this takes priority over every classification below (none of
//!     them can be safely computed once this is true; see
//!     `submodule_status_inner`). The frontend never offers Init/Update/Sync/
//!     Deinit/Remove for this status — see `submoduleAction`/Sidebar.svelte.
//!   - "conflicted": the superproject's OWN index has an unresolved merge
//!     conflict at this submodule's gitlink path (two branches pointed the
//!     submodule at different commits, now conflicted). This is NOT one of
//!     `SubmoduleStatus`'s bits — verified empirically that none of them
//!     reliably fire for this case — so it's detected separately via
//!     `Index::conflicts()` (see `submodule_conflicted`) and takes priority
//!     over every bit-derived classification below (a conflicted gitlink entry
//!     can otherwise leave head_sha/workdir_sha looking plausible while the
//!     repo is genuinely mid-conflict).
//!   - "removed": INDEX_DELETED set — `submodule_remove` has already STAGED
//!     this submodule's removal (its gitlink deleted from the index) but
//!     nothing is committed yet, so it still shows up here (HEAD's own
//!     committed `.gitmodules` is unchanged). Added as a bug fix (see M4's own
//!     doc comment below): none of the WD_* bits below fire for this case
//!     either, so without this check it fell all the way through to "clean" —
//!     a ghost row for a submodule that's already gone in every way that
//!     matters. Checked BEFORE every WD_* arm below (same reasoning as
//!     "conflicted" above).
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
//! order. "unreadable" (see its own bullet above) is checked before ANY of
//! this — before `submodule_status`/`submodule_conflicted` are even called —
//! since none of these bit-derived classifications can be safely computed at
//! all once a submodule's own reachable subtree is confirmed cyclic.
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

use std::collections::HashSet;
use std::fs;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{Diff, DiffOptions, Patch, Repository, StatusOptions, SubmoduleIgnore};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State, Wry};

use crate::git_write::WriteResult;

/// One `.gitmodules`-registered submodule row.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleInfo {
    pub name: String,
    pub path: String,
    /// The submodule's own working directory, as an absolute path on disk:
    /// this repo's OWN `repo.workdir()` (the repo `submodule_status` was
    /// called against — NOT necessarily the top-level superproject; calling
    /// `submodule_status` on a MID-level repo, in a submodule-of-a-submodule
    /// chain, yields paths relative to THAT repo's own workdir, one level
    /// down) joined with `path` via `join_native_relative` (per-component
    /// `Path::join`, see that function's own doc comment) — never string
    /// concatenation nor a single `Path::join` on the whole (possibly multi-
    /// component) relative path, either of which could produce a wrong or
    /// wrongly/mixed-separator path on Windows (`\` vs `/`). This is exactly
    /// the path the frontend passes back into
    /// `load_graph`/`workdir_status`/etc. to treat the submodule as its own
    /// fully-fledged active repo (own graph, own stage/commit, own
    /// branches/tags, own bisect/rebase, even its own nested Submodules
    /// section) — the whole point of this field.
    ///
    /// Still populated (a well-formed, valid absolute path string — never
    /// empty/null) even for a "not-initialized"/"removed"/"unreadable" row
    /// where nothing actually exists on disk at this path yet: the frontend
    /// itself decides whether to offer an "Open" action for those statuses,
    /// not this field.
    pub absolute_path: String,
    pub url: Option<String>,
    /// "conflicted" | "removed" | "not-initialized" | "out-of-date" | "dirty" | "clean" | "unreadable"
    ///
    /// "unreadable": CRASH FIX — this submodule's own resolved git directory,
    /// or something reachable in its nested-submodule subtree at any depth,
    /// was found cyclic (or unresolvable, or past a hard recursion-depth
    /// cap) — see `check_submodule_safe_for_status`'s doc comment for why
    /// `submodule_status` is never even called for a row in this state.
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

    // CRASH FIX: seed the exact same cycle-detection `visited` set
    // `submodule_foreach_run` seeds (the outermost repo's own canonical git
    // directory) BEFORE ever asking libgit2 for any top-level submodule's own
    // status — closes the case where a top-level submodule's gitfile points
    // straight back at ITS OWN containing (this very) repo. Threaded through
    // every `check_submodule_safe_for_status` call below (one shared set for
    // the whole listing, not a fresh one per submodule), mirroring
    // `submodule_foreach_run`'s own single-seed-per-sweep discipline. See
    // `check_submodule_safe_for_status`'s doc comment for the full,
    // empirically-confirmed crash this guards against.
    let mut visited: HashSet<std::path::PathBuf> = HashSet::new();
    if let Ok(canon) = fs::canonicalize(repo.path()) {
        visited.insert(canon);
    }

    let mut out = Vec::new();
    for sm in repo.submodules()? {
        let name = sm.name().unwrap_or_default().to_string();
        let sm_path = sm.path().to_string_lossy().to_string();
        // `join_native_relative` (per-COMPONENT `Path::join`), NEVER a single
        // `wd.join(&sm_path)` or string concatenation — see that helper's own
        // doc comment for why a single join isn't enough for a multi-
        // component submodule path (e.g. "vendor/lib-a") on Windows. Falls
        // back to the bare relative path (still a well-formed, non-empty
        // string, just not actually absolute) in the practically-unreachable
        // case of a BARE superproject repo (`workdir()` is `None`) — a
        // superproject that can register `.gitmodules` entries but has no
        // working tree for any of them to ever be checked out into, so there
        // is no real absolute path to compute in the first place.
        let absolute_path = repo
            .workdir()
            .map(|wd| join_native_relative(wd, &sm_path))
            .unwrap_or_else(|| std::path::PathBuf::from(&sm_path))
            .to_string_lossy()
            .to_string();
        let url = sm.url().map(|s| s.to_string());
        // `head_id()`/`workdir_id()` are plain OID reads (the gitlink entry's
        // recorded commit, and the submodule's own checked-out HEAD,
        // respectively) — NEITHER calls `Repository::submodule_status()`
        // internally, so both stay safe (and populated) even for a submodule
        // this function is about to classify "unreadable" below.
        let head_sha = sm.head_id().map(|oid| oid.to_string());
        let workdir_sha = sm.workdir_id().map(|oid| oid.to_string());

        // CRASH FIX: verify this submodule's ENTIRE reachable subtree is
        // confirmed cycle-free BEFORE ever calling `repo.submodule_status()`
        // on it — that call itself is what stack-overflows (crashing the
        // whole process) on a cyclic submodule, or on any ANCESTOR of one.
        // See `check_submodule_safe_for_status`'s own doc comment for the
        // full mechanism this mirrors from the M5 foreach fix. Takes priority
        // over every other classification below: none of them can be safely
        // computed once this is true.
        let status = match check_submodule_safe_for_status(&sm, &sm_path, &mut visited) {
            Err(_reason) => "unreadable".to_string(),
            Ok(()) => {
                // submodule_status() wants the registered name, not the path
                // (they're usually equal, but name is the documented lookup
                // key).
                let bits = repo.submodule_status(&name, SubmoduleIgnore::None)?;
                // Checked BEFORE the bit-derived classification: a merge-conflicted
                // gitlink entry doesn't reliably set any `SubmoduleStatus` bit (see
                // the module doc comment), so every bit-derived arm would otherwise
                // fall through to "clean" despite the repo genuinely being mid-conflict
                // at this exact path.
                if submodule_conflicted(&repo, &sm_path)? {
                    "conflicted".to_string()
                } else {
                    classify_status(bits)
                }
            }
        };

        out.push(SubmoduleInfo { name, path: sm_path, absolute_path, url, status, head_sha, workdir_sha });
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Join `base` (an already fully native-separated absolute path — this repo's
/// own `workdir()`) with `relative`, a git-internal relative path that is
/// ALWAYS forward-slash-separated regardless of platform — confirmed against
/// git2/libgit2 source: `Submodule::path()` returns whatever byte string is
/// recorded in `.gitmodules`/the index gitlink entry, which git itself always
/// writes and reads with `/` (never the platform separator) so the same
/// `.gitmodules` file is portable across OSes; git2's own `bytes2path` (what
/// actually produces that `Path`/`&str` on the Windows build of libgit2) does
/// no separator translation, it just wraps the raw bytes.
///
/// A single `base.join(relative)` gets the OUTERMOST separator right (`Path::
/// join` inserts one native separator between `base` and the whole `relative`
/// string) but does NOT walk into and renormalize any `/` already embedded
/// INSIDE `relative` for a multi-component path (e.g. "vendor/lib-a" — a
/// submodule registered a directory or more below the repo root). On Windows
/// that would produce a mixed-separator result like `C:\Users\dev\repo\
/// vendor/lib-a` — every intermediate separator still `/`, only the join
/// point itself native.
///
/// Fixed by splitting `relative` on `/` (safe unconditionally: git never uses
/// it as anything but a path separator in a stored path, and `/` is not a
/// legal character within a single path COMPONENT on any platform this app
/// supports) and folding `Path::join` over each component individually, so
/// `Path::join`'s own native-separator insertion happens at EVERY component
/// boundary, not just the outermost one.
fn join_native_relative(base: &std::path::Path, relative: &str) -> std::path::PathBuf {
    relative.split('/').fold(base.to_path_buf(), |acc, component| acc.join(component))
}

/// Map a `SubmoduleStatus` bitset to one of the 5 bit-derived UI-facing
/// classifications ("conflicted" is handled separately — see
/// `submodule_conflicted` — since it isn't a `SubmoduleStatus` bit at all).
/// See the module doc comment for the empirical verification behind each arm.
///
/// BUG-6 FIX: `INDEX_DELETED` is checked FIRST, above every `WD_*` arm below
/// — EMPIRICALLY VERIFIED that right after `submodule_remove` STAGES its `D
/// <path>` (nothing committed yet), `repo.submodule_status()` comes back as
/// exactly `IN_HEAD | INDEX_DELETED` (HEAD's own committed `.gitmodules`
/// still lists the submodule — nothing's been committed — but the INDEX no
/// longer has its gitlink), with NONE of the `WD_*` bits this function
/// already checked (the workdir. is gone too, deinited first). Every existing
/// arm below fell through to "clean" for this bit combination — a genuine
/// ghost row: `submodule_status` kept reporting a just-staged-for-removal
/// submodule as an ordinary, actionable "clean" one. A NEW status
/// ("removed", rather than overloading "not-initialized" — that one still
/// means "registered in .gitmodules, never cloned OR emptied without being
/// unregistered", a meaningfully different situation from "already staged
/// out of the index entirely") makes the frontend able to hide every row
/// action (see `submoduleAction`/Sidebar.svelte) and show a distinct,
/// unambiguous label instead of silently reusing an existing, wrong-shaped
/// state.
fn classify_status(bits: git2::SubmoduleStatus) -> String {
    use git2::SubmoduleStatus as S;
    if bits.contains(S::INDEX_DELETED) {
        "removed".to_string()
    } else if bits.contains(S::WD_UNINITIALIZED) || bits.contains(S::WD_DELETED) {
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

/// CRASH FIX (M1): answers the one question `submodule_status_inner` needs
/// before it may safely call `repo.submodule_status(name, ..)` for a given
/// TOP-LEVEL submodule `sm` — is `sm`'s entire reachable subtree, at any
/// depth, confirmed cycle-free? EMPIRICALLY CONFIRMED (the exact same
/// investigation that produced `submodule_foreach`'s own crash fix — see
/// `discover_nested_targets`'s doc comment in the M5 section below for the
/// full trail): `Repository::submodule_status()` itself stack-overflows
/// (crashing the whole process, not just returning an `Err`) when asked about
/// a submodule whose own resolved git directory — or ANYTHING reachable in
/// its own nested-submodule subtree, at any depth — is cyclic (a malformed or
/// maliciously crafted `.git` gitfile pointer that redirects back at an
/// ancestor already being walked). And, more surprisingly, the identical
/// crash fires when asking about any ANCESTOR of the cyclic node too, not
/// only the offending submodule itself (an ancestor's own dirty-status
/// computation transitively walks its whole reachable workdir).
///
/// This is independently reachable from `submodule_status_inner` alone — it
/// never needed the foreach feature at all: `submodule_status` runs
/// AUTOMATICALLY on every repo-open (the sidebar's own `refreshSubmodules()`),
/// so an unguarded `repo.submodule_status()` call here crashed the entire
/// application just from OPENING a repository containing such a submodule.
///
/// Reuses, rather than re-derives, the exact cycle-detection primitives the
/// M5 foreach fix already established:
///   - `sm.open()` failing just means this submodule was never checked out —
///     nothing reachable underneath it, and `Submodule::open()` alone was
///     verified safe even on the cyclic fixture (the crash lives inside
///     `submodule_status()` specifically) — so `Ok(())` (safe) immediately,
///     no further check needed, mirroring `discover_nested_targets`'s own
///     handling of the same case.
///   - Otherwise, `check_safe_to_recurse` decides whether `sm`'s OWN resolved
///     git directory is itself cyclic (already in `visited`) or unresolvable
///     — if so, `sm` itself is the offending node: `Err` immediately, without
///     ever calling `discover_nested_targets` (which would itself try to open
///     `.gitmodules` inside the very directory just found suspect).
///   - Otherwise, `sm`'s own directory is confirmed unique so far, but (per
///     the "ancestor crashes too" surprise above) that alone does not make
///     querying `sm`'s status safe: something DEEPER in its own subtree might
///     still be cyclic. `discover_nested_targets` is called one level down
///     (`depth: 1`, matching the depth `submodule_foreach_run`'s own
///     outermost call passes to ITS top-level submodules) purely for its
///     `tainted` return value — its actual `Vec<ForeachTarget>` is discarded;
///     `submodule_status_inner` only ever reports TOP-LEVEL rows and has no
///     use for deeper entries, unlike foreach's own `recursive: true` sweep.
///
/// `visited` is threaded through by the caller (`submodule_status_inner`) as
/// ONE shared set for the whole top-level listing, seeded with the outermost
/// repo's own canonical git directory before the first call — identical
/// discipline to `submodule_foreach_run`'s own single-seed-per-sweep pattern,
/// which is what closes the "a top-level submodule points straight back at
/// its own containing repo" case.
fn check_submodule_safe_for_status(
    sm: &git2::Submodule,
    full_path: &str,
    visited: &mut HashSet<std::path::PathBuf>,
) -> Result<(), String> {
    let Ok(sub_repo) = sm.open() else {
        return Ok(()); // never checked out -> nothing reachable underneath to be cyclic
    };
    check_safe_to_recurse(&sub_repo, full_path, visited)?;
    let (_ignored_entries, tainted) = discover_nested_targets(&sub_repo, full_path, visited, 1, false);
    if tainted {
        return Err(format!(
            "{full_path} contains a cyclic (or too-deep) nested submodule reference somewhere in its own subtree \
             — refusing to compute its status"
        ));
    }
    Ok(())
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

// ---------------------------------------------------------------------------
// M4: deinit / remove
// ---------------------------------------------------------------------------
//
// EMPIRICALLY VERIFIED (git 2.53.0, throwaway fixtures, re-verified by hand
// before writing this code — not trusted from a design doc alone):
//   * `git submodule deinit [-f] -- <path>` clears the submodule's OWN
//     working tree down to an empty directory and `git config --unset`s its
//     `[submodule "<path>"]` section from the SUPERPROJECT's `.git/config` —
//     but never touches `.gitmodules`, never touches the superproject's own
//     index/HEAD/gitlink entry, and (this is the safety property the UI is
//     built around) NEVER touches `.git/modules/<name>` — the submodule's own
//     object database (its refs/objects/history). A subsequent
//     `submodule_init` + `submodule_update` (even with the original remote
//     permanently gone — verified by `mv`ing the source repo away first)
//     restores the exact checked-out content with ZERO network/fetch
//     activity, straight from `.git/modules/<name>`.
//   * Without `-f`, deinit refuses cleanly (exit 128) on ANY of: an
//     uncommitted tracked edit, an untracked file, OR a merge-conflicted
//     gitlink entry in the SUPERPROJECT's own index (verified: the
//     submodule's own tree can be perfectly clean and it still refuses) —
//     always the same message: "error: the following file has local
//     modifications: ... fatal: ... use '-f' to discard them". With `-f`, all
//     of that content is silently gone — "Cleared directory '<path>'" is the
//     entire trace, confirming the backup-before-force need is real, not
//     hypothetical. A conflicted-gitlink `deinit -f` does NOT resolve the
//     conflict itself (that lives in the superproject's index, untouched by
//     deinit).
//   * `git rm -f -- <path>` (after a `deinit -f`) removes the gitlink AND
//     strips+stages the matching `[submodule ...]` section of `.gitmodules`
//     in one step (real, current git's documented `git-rm` behavior — see
//     `man git-rm`), leaving exactly `M  .gitmodules` / `D  <path>` staged,
//     nothing committed, no stray directory. `--cached` is deliberately NOT
//     used: verified it leaves an empty stray directory forever AND does not
//     auto-strip `.gitmodules`. Path -> registered name resolution is done by
//     `git rm` internally (verified with a submodule added via `--name` !=
//     path), so this module keeps passing paths, never names, matching
//     init/update/sync/add.
//   * `git rm -f` on a conflicted gitlink resolves that path's 3-way conflict
//     as a side effect (collapses to one clean `D` entry) — a genuine (not
//     just tolerated) benefit of `submodule_remove` on a conflicted row.
//
// SAFETY MANAGER: no ref snapshot on either command (same reasoning as every
// other command in this file — see its doc comments above). `submodule_deinit`
// only ever touches the submodule's OWN working tree and the superproject's
// OWN `.git/config` — never a ref. `submodule_remove` additionally only ever
// STAGES an index change (a gitlink deletion + a `.gitmodules` edit) —
// staging is not a ref move either, identical reasoning to `stage_file`/
// `stage_all`'s own no-snapshot rationale (workdir.rs). The one genuinely
// destructible thing here — a submodule's own UNCOMMITTED content — is
// categorically outside what a ref-snapshot could ever protect (same
// reasoning as `discard_file`'s own case, workdir.rs): the content-backup
// mechanism below is the correct and sufficient safety net for it.
//
// `submodule_deinit` does NOT pre-flight "would deinit refuse without -f" in
// Rust — `force:false` just tries the plain command and surfaces whatever
// git says verbatim (dirty OR conflicted-gitlink refusal, either way an
// honest git message). `force:true`'s only extra job is deciding whether a
// backup write is needed first, which is answered by a DIRECT walk of the
// submodule's own tree (its own staged index, its own unstaged working-tree
// edits, its own untracked files) — a strictly narrower, more literal
// question than replicating git's own refusal logic, and one that gives the
// right answer regardless of *why* git would otherwise have refused (see
// `backup_submodule_dirty_content`).
//
// `submodule_remove` takes no `force` parameter — it always behaves as force
// internally (the whole point of "remove" is unconditional; the frontend's
// own confirm dialog is the gate, not a second forced round-trip) and never
// auto-commits — only ever stages, mirroring `submodule_add`'s own "clone +
// register + stage, nothing committed" precedent (the only mutating-but-not-
// inherently-commit-creating precedent anywhere in this codebase).

/// Result of [`submodule_deinit`] / [`submodule_remove`] — deliberately NOT
/// `WriteResult`: those two commands need a `backup_patch` channel
/// `WriteResult` doesn't have, and widening the shared type for every OTHER
/// caller across the codebase to carry-but-never-populate a field only these
/// two commands use would fight this codebase's own stated precedent (one
/// type per module once the shape genuinely differs).
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleRemovalResult {
    pub ok: bool,
    pub message: String,
    /// Always `None` — neither command ever takes a Safety-Manager ref
    /// snapshot (see this section's doc comment). Present for structural
    /// uniformity with every other WriteResult-family type in the codebase.
    pub backup_ref: Option<String>,
    /// Git-dir-relative path to a saved pre-force copy of the submodule's own
    /// dirty content (its staged index, its unstaged working-tree edits, its
    /// untracked files) — `Some` exactly when
    /// [`backup_submodule_dirty_content`] found and backed up something,
    /// `None` on every `force:false` `submodule_deinit` call and every call
    /// where the submodule's own tree genuinely had nothing to lose.
    pub backup_patch: Option<String>,
}

/// Mirrors `WorkdirResult::ok` — see `ok_result`/`err_result` above for why
/// this module builds struct literals directly rather than reaching for
/// private ctors on a shared type.
fn ok_removal(message: impl Into<String>, backup_patch: Option<String>) -> SubmoduleRemovalResult {
    SubmoduleRemovalResult { ok: true, message: message.into(), backup_ref: None, backup_patch }
}
fn err_removal(message: impl Into<String>) -> SubmoduleRemovalResult {
    SubmoduleRemovalResult { ok: false, message: message.into(), backup_ref: None, backup_patch: None }
}
/// A failure AFTER a backup was already written (the git command itself then
/// failed) — keeps `backup_patch` populated, mirroring `discard_file`'s own
/// "the backup was already written even though the mutation failed — keep
/// pointing at it" discipline (workdir.rs).
fn err_removal_with_backup(message: impl Into<String>, backup_patch: Option<String>) -> SubmoduleRemovalResult {
    SubmoduleRemovalResult { ok: false, message: message.into(), backup_ref: None, backup_patch }
}

/// Process-wide monotonic tie-breaker for submodule-backup directory names,
/// mirroring `workdir.rs`'s `DISCARD_SEQ` — a separate counter since this
/// names its own directory namespace.
static SUBMODULE_BACKUP_SEQ: AtomicU64 = AtomicU64::new(0);

/// `<superproject-git-dir>/gitgui/submodule-backup/` — reuses the existing
/// `<git-dir>/gitgui/` convention (`oplog.jsonl`, `discard-backup/`).
fn submodule_backup_root(repo: &Repository) -> std::path::PathBuf {
    repo.path().join("gitgui").join("submodule-backup")
}

/// `<secs>-<nanos>-<seq>-<submodule_path with / -> _>`, unique even for two
/// backups of the same submodule path in the same nanosecond.
fn submodule_backup_stem(submodule_path: &str) -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let seq = SUBMODULE_BACKUP_SEQ.fetch_add(1, Ordering::SeqCst);
    let sanitized = submodule_path.replace('/', "_");
    format!("{}-{}-{}-{}", now.as_secs(), now.subsec_nanos(), seq, sanitized)
}

/// The registered submodule (if any) whose `.gitmodules` PATH matches
/// `submodule_path` exactly — the same path walk `submodule_status_inner`
/// already performs, reused here for two different follow-up needs: opening
/// the submodule's own repo (backup) and resolving its registered NAME
/// (remove's defensive `.gitmodules`-cleanup fallback).
fn find_submodule_by_path<'a>(repo: &'a Repository, submodule_path: &str) -> Option<git2::Submodule<'a>> {
    let sm_path = std::path::Path::new(submodule_path);
    repo.submodules().ok()?.into_iter().find(|sm| sm.path() == sm_path)
}

/// Open the SUBMODULE's own repository (not the superproject's), via git2's
/// purpose-built `Submodule::open()` — works transparently whether the
/// submodule uses an old-style nested `.git` or the modern gitfile-pointer
/// layout. Returns `None` when the submodule is not registered at this path,
/// OR `Submodule::open()` itself errored for ANY reason.
///
/// BUG-1 FIX — a `None` here does NOT by itself mean "nothing of its own to
/// back up": EMPIRICALLY VERIFIED (throwaway fixtures) that `Submodule::open()`
/// returns the exact SAME `ErrorCode::NotFound`/`ErrorClass::Os` "failed to
/// resolve path '.../.git'" error for two completely different situations —
/// (a) a genuinely never-checked-out submodule (fresh clone, no `init`/
/// `update` run — nothing to lose), AND (b) a submodule whose `.git` gitfile
/// pointer was simply deleted (or, verified separately, corrupted/malformed —
/// a THIRD, distinct error class/code for that variant) while its real
/// tracked content remains sitting in the working tree (everything to lose).
/// The error alone cannot tell these apart, so callers of this function must
/// NEVER treat a bare `None` as "safe to proceed" — see
/// `submodule_workdir_has_any_content`, the direct filesystem fallback check
/// `backup_submodule_dirty_content` uses instead to make that call correctly.
fn open_submodule_repo(repo: &Repository, submodule_path: &str) -> Option<Repository> {
    find_submodule_by_path(repo, submodule_path)?.open().ok()
}

/// Fallback safety check for when [`open_submodule_repo`] returns `None`: does
/// `submodule_path`'s own working-tree directory exist and hold ANY entry at
/// all (not recursing — a single stray entry already means "there is
/// something here")? A missing or genuinely empty directory really is nothing
/// to lose (a never-checked-out submodule, or one already cleared); anything
/// else means `Submodule::open()` failed for some OTHER reason (corrupted/
/// malformed gitfile, permissions, ...) while real content sits right there —
/// see `open_submodule_repo`'s doc comment for the empirical verification
/// behind why the error alone can't make this distinction.
fn submodule_workdir_has_any_content(repo: &Repository, submodule_path: &str) -> bool {
    let Some(workdir) = repo.workdir() else { return false };
    match fs::read_dir(workdir.join(submodule_path)) {
        Ok(mut entries) => entries.next().is_some(),
        Err(_) => false, // doesn't exist at all -> definitely nothing to lose
    }
}

/// The submodule's registered NAME (its `.gitmodules` section key, which can
/// differ from its path — verified empirically, e.g. via `git submodule add
/// --name custom <url> <path>`), resolved BEFORE any mutation: once
/// `.gitmodules`/the index are changed this lookup is no longer possible the
/// normal way. Used only by `submodule_remove`'s defensive fallback (see
/// `ensure_gitmodules_section_removed`).
fn resolve_submodule_name(repo: &Repository, submodule_path: &str) -> Option<String> {
    find_submodule_by_path(repo, submodule_path)?.name().map(|s| s.to_string())
}

/// One whole `git2::Diff` rendered as a single `git apply`-able unified patch
/// text, by concatenating each delta's own `Patch::to_buf()` — a `Diff` has
/// no combined-buffer method of its own (only per-delta `Patch` does), same
/// building block `backup_tracked_patch` (workdir.rs) already uses for one
/// delta at a time. A binary delta (`Patch::from_diff` returning `Ok(None)`)
/// is treated as a hard error here, not silently skipped — mirrors
/// `backup_tracked_patch`'s own "Could not build a patch ... (binary file?)"
/// refusal, so a binary change inside a submodule can never be silently
/// force-discarded with no way to recover it.
fn diff_to_patch_text(diff: &Diff<'_>) -> Result<String, String> {
    let mut out = String::new();
    let n = diff.deltas().len();
    for i in 0..n {
        let mut patch = Patch::from_diff(diff, i).map_err(|e| e.message().to_string())?.ok_or_else(|| {
            let p = diff
                .get_delta(i)
                .and_then(|d| d.new_file().path().or_else(|| d.old_file().path()))
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            format!("could not build a patch for {p} (binary file?)")
        })?;
        let buf = patch.to_buf().map_err(|e| e.message().to_string())?;
        out.push_str(buf.as_str().unwrap_or_default());
    }
    Ok(out)
}

/// True if `repo`'s own tree — a staged (index vs HEAD) change, an unstaged
/// (workdir vs index) change, or an untracked/ignored file — has ANYTHING a
/// `deinit -f` would discard. The boolean-only sibling of
/// `backup_submodule_dirty_content`'s own three-way dirty check below, shared
/// with [`first_dirty_nested_submodule`] where only a yes/no answer is needed
/// (never the actual patch/backup bytes — see that function's own doc comment
/// for why DETECTION, not a full recursive backup, is this codebase's answer
/// one level down). BUG-5 FIX applies here too: `include_ignored`/
/// `recurse_ignored_dirs` so a nested submodule's own gitignored-but-real
/// files are correctly counted as "dirty" too, matching what `deinit -f`'s
/// clear actually removes.
fn repo_has_dirty_content(repo: &Repository) -> Result<bool, String> {
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let staged_diff = repo
        .diff_tree_to_index(head_tree.as_ref(), None, None)
        .map_err(|e| format!("could not diff staged changes: {}", e.message()))?;
    if staged_diff.deltas().len() > 0 {
        return Ok(true);
    }
    let unstaged_diff = repo
        .diff_index_to_workdir(None, None)
        .map_err(|e| format!("could not diff unstaged changes: {}", e.message()))?;
    if unstaged_diff.deltas().len() > 0 {
        return Ok(true);
    }
    let mut status_opts = StatusOptions::new();
    status_opts.include_untracked(true).recurse_untracked_dirs(true).include_ignored(true).recurse_ignored_dirs(true);
    let statuses = repo.statuses(Some(&mut status_opts)).map_err(|e| format!("could not read untracked/ignored files: {}", e.message()))?;
    Ok(statuses.iter().any(|e| e.status().is_wt_new() || e.status().is_ignored()))
}

/// BUG-2 FIX: a submodule can itself have its OWN registered submodules (a
/// "submodule of a submodule") — EMPIRICALLY VERIFIED (design phase, checked
/// against real `git submodule deinit --help`/docs) that `git submodule
/// deinit` has NO `--recursive` flag at all, so force-deiniting/removing the
/// OUTER submodule wipes whatever the inner one has checked out too, with no
/// way to ask git to preserve or even skip it first. A full recursive
/// backup-and-proceed (nested diffs, nested patches, nested untracked files,
/// arbitrary depth) is a much larger and harder-to-get-right surface than the
/// single-level backup above, so this is pragmatically handled as DETECTION
/// instead: recurse into `sub_repo`'s own `repo.submodules()`, to any depth,
/// and report the first one found dirty (via `repo_has_dirty_content`) so the
/// caller can refuse the WHOLE operation naming exactly which nested path is
/// at risk, rather than silently destroying it.
///
/// Returns `Ok(None)` when nothing nested is dirty (including when a nested
/// submodule isn't checked out at all — same nothing-to-lose reasoning
/// `open_submodule_repo` uses one level up: a merely-not-checked-out nested
/// submodule is intentionally NOT chased further via
/// `submodule_workdir_has_any_content`'s own fallback — that fallback exists
/// to keep a corrupted-but-content-bearing TOP-LEVEL target from being
/// silently treated as clean; a nested submodule this deep that's merely
/// unreadable is already exceedingly rare and, worst case, is still caught by
/// this same recursive walk failing to find it dirty and the outer operation
/// proceeding no worse than it would have before this fix existed). `Err`
/// only when a nested submodule's dirty state genuinely could not be
/// determined (mirrors `backup_submodule_dirty_content`'s own
/// refuse-don't-guess posture for read failures).
fn first_dirty_nested_submodule(sub_repo: &Repository) -> Result<Option<String>, String> {
    let nested = sub_repo.submodules().map_err(|e| format!("could not enumerate nested submodules: {}", e.message()))?;
    for nested_sm in nested {
        let nested_path = nested_sm.path().to_string_lossy().to_string();
        let Some(nested_repo) = nested_sm.open().ok() else {
            continue; // not checked out -> nothing of its own to lose
        };
        if repo_has_dirty_content(&nested_repo)? {
            return Ok(Some(nested_path));
        }
        if let Some(deeper) = first_dirty_nested_submodule(&nested_repo)? {
            return Ok(Some(format!("{nested_path}/{deeper}")));
        }
    }
    Ok(None)
}

/// The core of the design decision above: is there anything in the
/// submodule's OWN repository (its own staged index vs HEAD, its own
/// unstaged working tree vs index, its own untracked files) that a `deinit
/// -f`/the deinit-then-`rm` sequence would silently discard? If so, back it
/// up FIRST as a small directory bundle under
/// `<superproject-git-dir>/gitgui/submodule-backup/<stem>/` (`staged.patch` /
/// `unstaged.patch` / `untracked/<relative path>`, any of which is omitted
/// when empty) and return its git-dir-relative path. Returns `Ok(None)` — no
/// directory even created — when genuinely nothing is dirty, INCLUDING when
/// the submodule isn't checked out at all (nothing of its own working tree
/// exists to lose — see `open_submodule_repo`/`submodule_workdir_has_any_content`
/// for the BUG-1 fix distinguishing that from "checked out but unreadable").
/// `Err` when something IS dirty but backing it up failed, OR (BUG-2 fix) when
/// the target submodule has a nested submodule-of-its-own that is itself
/// dirty (refuse-and-inform, never a silent partial backup) — callers must
/// treat either `Err` as "refuse the whole operation", exactly `discard_file`'s
/// backup-or-refuse discipline (workdir.rs).
fn backup_submodule_dirty_content(repo: &Repository, submodule_path: &str) -> Result<Option<String>, String> {
    let sub_repo = match open_submodule_repo(repo, submodule_path) {
        Some(r) => r,
        None => {
            // BUG-1 FIX: `Submodule::open()` failing does NOT by itself mean
            // "nothing to lose" — see `open_submodule_repo`'s doc comment for
            // the empirical verification. Fall back to a direct filesystem
            // check: an empty (or nonexistent) directory really is nothing to
            // lose; anything else means we cannot tell whether it's dirty and
            // must refuse rather than silently proceeding to a force-deinit/
            // remove that could wipe real, un-backed-up content.
            if submodule_workdir_has_any_content(repo, submodule_path) {
                return Err(format!(
                    "{submodule_path}'s own repository could not be opened (possibly corrupted, or its .git \
                     pointer is unreadable), but its working directory is not empty — refusing to guess whether \
                     it holds uncommitted work"
                ));
            }
            return Ok(None);
        }
    };

    // BUG-2 FIX: refuse the WHOLE operation up front if a submodule nested
    // inside THIS one is itself dirty — see `first_dirty_nested_submodule`'s
    // doc comment for why detection (not recursive backup) is the answer here.
    if let Some(nested_path) = first_dirty_nested_submodule(&sub_repo)? {
        return Err(format!(
            "{submodule_path}'s own nested submodule {nested_path} has uncommitted changes of its own, and a \
             force-deinit/remove has no way to preserve them (git submodule deinit has no --recursive flag) — \
             refusing. Resolve or back up {submodule_path}/{nested_path} first"
        ));
    }

    let mut staged_opts = DiffOptions::new();
    staged_opts.context_lines(3);
    let head_tree = sub_repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let staged_diff = sub_repo
        .diff_tree_to_index(head_tree.as_ref(), None, Some(&mut staged_opts))
        .map_err(|e| format!("could not diff the submodule's staged changes: {}", e.message()))?;

    let mut unstaged_opts = DiffOptions::new();
    unstaged_opts.context_lines(3);
    let unstaged_diff = sub_repo
        .diff_index_to_workdir(None, Some(&mut unstaged_opts))
        .map_err(|e| format!("could not diff the submodule's unstaged changes: {}", e.message()))?;

    // BUG-5 FIX: `include_ignored`/`recurse_ignored_dirs` too, not just
    // `include_untracked` — EMPIRICALLY CONFIRMED `git submodule deinit -f`
    // clears gitignored files inside the submodule right along with plain
    // untracked ones, so the backup scope must match (exactly
    // `workdir.rs::discard_file`'s own scope-matches-`git clean -f`
    // discipline, one level down).
    let mut status_opts = StatusOptions::new();
    status_opts.include_untracked(true).recurse_untracked_dirs(true).include_ignored(true).recurse_ignored_dirs(true);
    let statuses = sub_repo
        .statuses(Some(&mut status_opts))
        .map_err(|e| format!("could not read the submodule's untracked files: {}", e.message()))?;
    let untracked: Vec<String> = statuses
        .iter()
        .filter(|e| e.status().is_wt_new() || e.status().is_ignored())
        .filter_map(|e| e.path().map(|p| p.to_string()))
        .collect();

    let staged_empty = staged_diff.deltas().len() == 0;
    let unstaged_empty = unstaged_diff.deltas().len() == 0;
    if staged_empty && unstaged_empty && untracked.is_empty() {
        return Ok(None);
    }

    let stem = submodule_backup_stem(submodule_path);
    let dir = submodule_backup_root(repo).join(&stem);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create submodule backup dir: {e}"))?;

    if !staged_empty {
        let text = diff_to_patch_text(&staged_diff)?;
        fs::write(dir.join("staged.patch"), text).map_err(|e| format!("could not write staged.patch: {e}"))?;
    }
    if !unstaged_empty {
        let text = diff_to_patch_text(&unstaged_diff)?;
        fs::write(dir.join("unstaged.patch"), text).map_err(|e| format!("could not write unstaged.patch: {e}"))?;
    }
    if !untracked.is_empty() {
        let sub_workdir = sub_repo
            .workdir()
            .ok_or_else(|| "submodule has no working directory".to_string())?
            .to_path_buf();
        let untracked_root = dir.join("untracked");
        for rel in &untracked {
            let src = sub_workdir.join(rel);
            let dest = untracked_root.join(rel);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("could not create backup dir for {rel}: {e}"))?;
            }
            // BUG-4 FIX: `fs::symlink_metadata` (NOT `fs::metadata`/a plain
            // `fs::read`, both of which FOLLOW a symlink) first — a stray,
            // genuinely broken/dangling symlink (its target since deleted)
            // has no bytes of its own to read at all. EMPIRICALLY VERIFIED a
            // plain `fs::read` on one errors with "No such file or
            // directory", which previously turned an otherwise-harmless
            // force-deinit into a hard refusal over one dead link. There is
            // no byte content to preserve for a dangling link either way, so
            // the best available backup is simply recording WHERE it pointed.
            let meta = fs::symlink_metadata(&src).map_err(|e| format!("could not stat {rel}: {e}"))?;
            if meta.file_type().is_symlink() {
                let target = fs::read_link(&src).map_err(|e| format!("could not read symlink target for {rel}: {e}"))?;
                fs::write(&dest, target.to_string_lossy().as_bytes())
                    .map_err(|e| format!("could not back up symlink target for {rel}: {e}"))?;
            } else {
                let bytes = fs::read(&src).map_err(|e| format!("could not read {rel}: {e}"))?;
                fs::write(&dest, &bytes).map_err(|e| format!("could not back up {rel}: {e}"))?;
            }
        }
    }

    // git-dir-relative, matching backup_tracked_patch/backup_untracked_bytes's
    // own "gitgui/discard-backup/..." convention.
    Ok(Some(format!("gitgui/submodule-backup/{stem}")))
}

/// Unregister a submodule and clear its checked-out working tree (`git
/// submodule deinit [-f] -- <path>`) — see this section's doc comment for the
/// exact, empirically-verified semantics. Its committed history in
/// `.git/modules/<name>` is NEVER touched by this command; `submodule_init` +
/// `submodule_update` restore it instantly afterward, even fully offline.
///
/// `force:false` runs the plain command and surfaces git's own refusal
/// verbatim (a dirty submodule tree OR a merge-conflicted gitlink both refuse
/// with the identical "local modifications ... use '-f'" message) —
/// `backup_patch` is always `None` on this path, nothing is ever discarded.
///
/// `force:true` first checks the submodule's OWN tree directly for anything
/// that would be discarded (staged index, unstaged edits, untracked files —
/// see `backup_submodule_dirty_content`); if genuinely nothing is dirty, the
/// backup step is skipped entirely (still `backup_patch: None`) and `deinit
/// -f` runs directly. This also correctly covers the merge-conflicted-gitlink
/// case: the submodule's own tree can be clean even while the SUPERPROJECT's
/// index is conflicted, so no needless backup is written there either — the
/// conflict itself lives in the superproject's index, which deinit never
/// touches. If something IS found, the backup is written FIRST; if that
/// backup write itself fails, the WHOLE operation is refused — no git command
/// is run at all (mirrors `discard_file`'s exact backup-or-refuse discipline,
/// workdir.rs). `backup_patch` is then populated regardless of whether the
/// subsequent `deinit -f` itself goes on to succeed or fail (mirrors
/// `discard_file`'s "backup already written even though the mutation failed
/// — keep pointing at it").
///
/// No Safety-Manager snapshot — see this section's doc comment.
/// JS call: `invoke("submodule_deinit", { path, submodulePath, force })`.
#[tauri::command]
#[specta::specta]
pub fn submodule_deinit(path: String, submodule_path: String, force: bool) -> SubmoduleRemovalResult {
    if let Err(e) = validate_submodule_path(&submodule_path) {
        return err_removal(e);
    }

    if !force {
        return match run_git(&path, &["submodule", "deinit", "--", &submodule_path]) {
            Ok(out) if out.ok => ok_removal(format!("Deinitialized submodule {submodule_path}."), None),
            // e.g. "fatal: Submodule work tree '<path>' contains local
            // modifications; use '-f' to discard them" (dirty tree OR a
            // merge-conflicted gitlink — see this section's doc comment) —
            // never forced, surfaced verbatim.
            Ok(out) => err_removal(git_error_message(&out)),
            Err(e) => err_removal(e),
        };
    }

    let repo = match crate::trust::open_repo(&path) {
        Ok(r) => r,
        Err(e) => return err_removal(format!("Cannot open repository: {}", e.message())),
    };
    let backup_patch = match backup_submodule_dirty_content(&repo, &submodule_path) {
        Ok(p) => p,
        Err(e) => {
            return err_removal(format!(
                "Could not back up {submodule_path}'s own uncommitted changes before force-deiniting, refusing: {e}"
            ))
        }
    };

    match run_git(&path, &["submodule", "deinit", "-f", "--", &submodule_path]) {
        Ok(out) if out.ok => ok_removal(
            match &backup_patch {
                Some(b) => format!("Deinitialized submodule {submodule_path} (backup: {b})."),
                None => format!("Deinitialized submodule {submodule_path}."),
            },
            backup_patch,
        ),
        Ok(out) => err_removal_with_backup(git_error_message(&out), backup_patch),
        Err(e) => err_removal_with_backup(e, backup_patch),
    }
}

/// Remove a submodule from the repository entirely: clear+unregister it (same
/// as [`submodule_deinit`]'s force path) then stage its removal from the
/// index AND strip+stage its matching `.gitmodules` section (`git rm -f --
/// <path>`) — see this section's doc comment for the exact, empirically-
/// verified `git rm` behavior this relies on. Its committed history in
/// `.git/modules/<name>` is NEVER deleted (same as deinit).
///
/// Always behaves as force internally — no `force` parameter (see this
/// section's doc comment for why: the confirm dialog is the gate, not a
/// second forced round-trip). Runs the identical "is there anything of the
/// submodule's own to back up" check as `submodule_deinit`'s force path
/// first (skip the backup write if genuinely clean, refuse-the-whole-op if
/// something is dirty and the backup write itself fails).
///
/// Never auto-commits — only ever STAGES (`M .gitmodules` / `D <path>`),
/// mirroring `submodule_add`'s own "stage, don't commit" precedent; commit
/// via the existing `workdir.rs::commit`.
///
/// No Safety-Manager snapshot — see this section's doc comment.
/// JS call: `invoke("submodule_remove", { path, submodulePath })`.
#[tauri::command]
#[specta::specta]
pub fn submodule_remove(path: String, submodule_path: String) -> SubmoduleRemovalResult {
    if let Err(e) = validate_submodule_path(&submodule_path) {
        return err_removal(e);
    }

    let repo = match crate::trust::open_repo(&path) {
        Ok(r) => r,
        Err(e) => return err_removal(format!("Cannot open repository: {}", e.message())),
    };

    // Resolved BEFORE any mutation — see `resolve_submodule_name`'s doc
    // comment for why this can't be done afterward.
    let name = resolve_submodule_name(&repo, &submodule_path);

    let backup_patch = match backup_submodule_dirty_content(&repo, &submodule_path) {
        Ok(p) => p,
        Err(e) => {
            return err_removal(format!(
                "Could not back up {submodule_path}'s own uncommitted changes before removing, refusing: {e}"
            ))
        }
    };

    if let Err(msg) = match run_git(&path, &["submodule", "deinit", "-f", "--", &submodule_path]) {
        Ok(out) if out.ok => Ok(()),
        Ok(out) => Err(git_error_message(&out)),
        Err(e) => Err(e),
    } {
        return err_removal_with_backup(msg, backup_patch);
    }

    match run_git(&path, &["rm", "-f", "--", &submodule_path]) {
        Ok(out) if out.ok => {
            // Defensive fallback for a git version whose `git rm` does NOT
            // auto-strip `.gitmodules` (this codebase's own git 2.53.0 does —
            // see this section's doc comment — so this is expected to be a
            // no-op on the version this was verified against, but keeps the
            // command correct — and, per BUG-3's fix, HONEST about failures —
            // on any installed git or filesystem condition (e.g. .gitmodules
            // temporarily unwritable) that leaves the section behind).
            if let Some(name) = &name {
                if let Err(msg) = ensure_gitmodules_section_removed(&path, name) {
                    // The gitlink itself IS already staged as deleted at this
                    // point (git rm -f above succeeded) — say so, rather than
                    // letting a caller believe NOTHING happened.
                    return err_removal_with_backup(
                        format!(
                            "{submodule_path}'s gitlink was staged for removal, but {msg}. Run `git status` to see \
                             the partial state before retrying"
                        ),
                        backup_patch,
                    );
                }
            }
            ok_removal(
                match &backup_patch {
                    Some(b) => format!("Removed submodule {submodule_path} (backup: {b})."),
                    None => format!("Removed submodule {submodule_path}."),
                },
                backup_patch,
            )
        }
        Ok(out) => err_removal_with_backup(git_error_message(&out), backup_patch),
        Err(e) => err_removal_with_backup(e, backup_patch),
    }
}

/// Fallback for `submodule_remove`: if `.gitmodules` STILL has a
/// `[submodule "<name>"]` section after `git rm -f` (only expected on an
/// older git that doesn't auto-strip it, or a filesystem condition that made
/// `git rm`'s own attempt fail partway — see this section's doc comment),
/// manually strip and re-stage it.
///
/// BUG-3 FIX: previously this used `if let Ok(out)` / `let _ = run_git(...)`
/// for BOTH the strip and the follow-up stage, so either one failing was
/// silently swallowed and `submodule_remove` reported `ok:true` over a half-
/// edited, UNSTAGED `.gitmodules` — the gitlink deletion staged, but the
/// matching `.gitmodules` section still present on disk and not staged
/// either way. Now: first check via a direct read of `.gitmodules` whether
/// the section is even STILL there (the overwhelmingly common case on this
/// codebase's own verified git version is that `git rm -f` already stripped
/// it — `git config --remove-section` on an ALREADY-absent section is itself
/// a normal, expected non-zero exit that must NOT be treated as a failure);
/// only if the section genuinely survives does this attempt to strip it, and
/// ANY failure from either step (the strip itself, or staging that edit) is
/// propagated as `Err` with a message naming which of the two steps failed,
/// rather than swallowed.
fn ensure_gitmodules_section_removed(path: &str, name: &str) -> Result<(), String> {
    let gitmodules_path = std::path::Path::new(path).join(".gitmodules");
    let section_header = format!("[submodule \"{name}\"]");
    let still_present = fs::read_to_string(&gitmodules_path).map(|s| s.contains(&section_header)).unwrap_or(false);
    if !still_present {
        return Ok(());
    }

    let section = format!("submodule.{name}");
    match run_git(path, &["config", "-f", ".gitmodules", "--remove-section", &section]) {
        Ok(out) if out.ok => {}
        Ok(out) => {
            return Err(format!(
                "its [{section}] section could not be stripped from .gitmodules (still present, unstaged): {}",
                git_error_message(&out)
            ))
        }
        Err(e) => {
            return Err(format!(
                "its [{section}] section could not be stripped from .gitmodules (still present, unstaged): {e}"
            ))
        }
    }

    match run_git(path, &["add", "--", ".gitmodules"]) {
        Ok(out) if out.ok => Ok(()),
        Ok(out) => Err(format!(
            "its [{section}] section was stripped from .gitmodules, but staging that edit failed (left unstaged): {}",
            git_error_message(&out)
        )),
        Err(e) => Err(format!(
            "its [{section}] section was stripped from .gitmodules, but staging that edit failed (left unstaged): {e}"
        )),
    }
}

// ---------------------------------------------------------------------------
// M5 (final): foreach — `git submodule foreach <command>` equivalent, driven
// step-by-step from Rust so each submodule's result can be pushed to the
// frontend as "submodule-foreach-progress" while the sweep runs, instead of
// only seeing one final batch result.
//
// This directly mirrors git_bisect.rs's own automated-run machinery
// end-to-end (`BisectRunState` / `run_bisect` / `try_run_bisect` /
// `bisect_run_start` / `bisect_run_cancel`) — including a lesson ALREADY
// LEARNED there rather than repeated here: `BisectRunState` originally
// shipped as a bare cancellation-flag `AtomicBool` with NO mutual-exclusion
// against a second concurrent run, which adversarial review caught as a real
// bug (two concurrent automated runs could interleave and corrupt state) and
// had to be fixed in a follow-up pass with a `compare_exchange`-guarded
// "already running" claim. `SubmoduleForeachState` below copies
// `BisectRunState`'s FINAL, already-fixed shape verbatim from the very
// start — a `running` AtomicBool claimed via `compare_exchange` and released
// on every exit path, PLUS a separate `cancel` AtomicBool polled between
// every submodule iteration and cleared on every exit path — rather than
// needing that identical fix as a follow-up here too.
//
// UNLIKE bisect, there is no good/bad/skip exit-code semantics here:
// `command` is an arbitrary user-supplied shell command run once per
// initialized submodule's own working directory, and only its exit code (0
// vs anything else) decides "ok" vs "failed" — no attempt to distinguish
// "couldn't run at all" the way `classify_exit` does for bisect, since there
// is no bisect-style convergence loop reading meaning INTO the exit code
// here, just pass/fail per submodule.
//
// ONE FAILURE DOES NOT ABORT THE SWEEP — EMPIRICALLY VERIFIED (git 2.53,
// throwaway fixture with 3 submodules, the middle one's command exiting
// non-zero) before relying on it: real `git submodule foreach` with no extra
// flags keeps going and still runs the command in every remaining submodule
// after one fails, only reporting the overall foreach exit code as non-zero
// at the very end. This mirrors that: a "failed" entry for one submodule
// never stops the loop from reaching the rest.
//
// CANCELLATION is checked BETWEEN submodule iterations only, never
// mid-command — the identical, already-documented TOCTOU limitation
// `run_bisect` itself carries (a long-running command already in flight for
// submodule N finishes before cancellation takes effect ahead of submodule
// N+1); every submodule that was never reached once cancellation is observed
// gets a "cancelled" entry rather than being silently dropped from the
// result.
//
// DISCOVERY reuses, rather than re-derives, M1's own BIT-CLASSIFICATION
// helpers (`classify_status`/`submodule_conflicted`, unchanged) — but, as of
// the cyclic-submodule crash fix below, NO LONGER calls M1's
// `submodule_status_inner` wrapper itself for the top-level list the way an
// earlier version of this code did. EMPIRICALLY CONFIRMED (see
// `discover_nested_targets`'s own CRASH FIX doc comment) that doing so was
// itself unsafe: asking libgit2 for even a single TOP-LEVEL submodule's own
// status can stack-overflow if ANYTHING in that submodule's reachable
// nested-submodule subtree is cyclic, at any depth — not only when this code
// goes on to actually recurse into it. So top-level and every deeper
// submodule-of-a-submodule classification now go through the exact same
// safe, taint-aware walk (`discover_nested_targets`, called once from the
// OUTERMOST repo with an empty path prefix — see `submodule_foreach_run`),
// which mirrors `first_dirty_nested_submodule`'s own recursive-discovery
// shape (M4 bug-2 fix, above) — `sub_repo.submodules()`, `open()` each,
// recurse — reused/mirrored here rather than writing a third copy of that
// exact walk, just collecting full (path, status) entries instead of a
// single dirty boolean.
//
// UPDATE (M1 crash fix, added later): the dependency now also runs the OTHER
// way — M1's `submodule_status_inner` was found to be independently
// vulnerable to this exact crash (see its own `check_submodule_safe_for_status`
// doc comment above M2) and now calls straight into `discover_nested_targets`/
// `check_safe_to_recurse` itself, for the identical reason this section
// stopped calling M1's wrapper: computing even one top-level submodule's
// status is unsafe unless its whole reachable subtree is confirmed
// cycle-free first. This is NOT a reintroduction of the old M1<->M5 coupling
// this section's own fix removed — `submodule_status_inner` never calls back
// into `submodule_foreach_run`/`discover_nested_targets`'s TOP-LEVEL entry
// point, it only reuses the safe, side-effect-free cycle-detection PRIMITIVES
// one level down, exactly the way `check_submodule_safe_for_status` is
// documented to.
//
// No Safety-Manager snapshot: `submodule_foreach_start` only ever spawns an
// arbitrary command inside each submodule's OWN already-checked-out working
// directory — it never itself moves a ref, touches the superproject's index/
// HEAD, or mutates any submodule's gitlink. Whatever the user's own command
// happens to do inside a submodule is exactly as uncontrolled/uncapturable
// by a ref snapshot as `bisect_run_start`'s own test command is — identical
// "nothing this command itself does is snapshot-shaped" reasoning already
// used throughout this file.

/// One submodule targeted by a `submodule_foreach_start` sweep, discovered
/// before any command runs — path is root-relative (e.g. "sub/nested" for a
/// submodule-of-a-submodule, exactly how real `git submodule foreach` prints
/// it), status is the same "conflicted"/"removed"/"not-initialized"/
/// "out-of-date"/"dirty"/"clean" vocabulary `SubmoduleInfo::status` uses,
/// consulted only to decide skip-vs-run (never surfaced to the frontend
/// directly — see `SubmoduleForeachEntry::status`, a completely different,
/// pass/fail vocabulary).
struct ForeachTarget {
    path: String,
    status: String,
    /// `Some(reason)` when this target must be treated as "skipped" for a
    /// reason OTHER than the ordinary not-initialized/removed classification
    /// above — specifically, `discover_nested_targets`/its top-level caller
    /// in `submodule_foreach_run` refusing to recurse into this submodule's
    /// OWN nested submodules because doing so was detected to be unsafe (a
    /// cyclic submodule reference, or the hard recursion-depth cap — see
    /// `discover_nested_targets`'s doc comment). `None` for every ordinary
    /// target. When set, `submodule_foreach_run` reports this target as
    /// "skipped" with this message in `stderr`, regardless of `status` —
    /// this submodule's own row is still shown, it just never had a command
    /// run in it and was never recursed into further.
    skip_reason: Option<String>,
}

/// Hard cap on nested-submodule recursion depth, purely as defense-in-depth
/// alongside the canonical-path cycle detection below (`check_safe_to_recurse`)
/// — in case some exotic filesystem condition (e.g. a canonicalization
/// failure this code treats conservatively, or a genuinely absurd, real,
/// non-cyclic 32+-deep chain) lets recursion run away regardless. Chosen
/// generously above any plausible real-world submodule-of-a-submodule
/// nesting depth, so it only ever fires on a runaway/adversarial case.
const MAX_SUBMODULE_RECURSION_DEPTH: usize = 32;

/// CRASH FIX (confirmed empirically: an unbounded-recursion stack overflow,
/// `thread 'main' has overflowed its stack, fatal runtime error: stack
/// overflow`, process exit 134): a nested submodule's `.git` gitfile pointer
/// can be malformed or maliciously crafted to redirect its resolved git
/// directory back at an ancestor already being walked — its own containing
/// repo, or any repo already visited on this sweep. `git2::Submodule::open()`
/// itself does NO cycle detection at all; it just follows the gitfile
/// pointer to whatever repository it names, so a self/ancestor-referencing
/// pointer previously made this function recurse into the EXACT SAME
/// `.gitmodules`/index over and over, forever — reachable from ordinary,
/// untrusted user input via `submodule_foreach_start` (with OR without
/// `recursive: true` — see below) on any third-party repo containing such a
/// submodule, with no need to go through this app's own
/// `submodule_add`/`submodule_update` at all.
///
/// CRITICAL ORDERING, ALSO EMPIRICALLY CONFIRMED WITH A MINIMAL REPRO BEFORE
/// TRUSTING IT: the stack overflow happens INSIDE libgit2's own C
/// implementation of `Repository::submodule_status()` itself when asked
/// about a submodule whose own resolved repository is cyclic — NOT in
/// anything this function's Rust code does after that call returns.
/// `Submodule::open()` alone (no status computation) was verified safe even
/// on the exact same cyclic submodule. This means the cycle check below MUST
/// run strictly BEFORE `repo.submodule_status()` (via `nested_submodule_status`)
/// is ever called for a given submodule — checking afterward (this fix's own
/// first, WRONG attempt) still crashed, because the crashing call had already
/// happened by the time the check ran.
///
/// SECOND EMPIRICAL SURPRISE, ALSO CONFIRMED WITH A MINIMAL REPRO: it is not
/// enough to guard the call for the cyclic node ITSELF — asking libgit2 for
/// the status of ONE OF ITS ANCESTORS crashes too, even though the ancestor's
/// own `.git` gitfile is completely ordinary and uncorrupted. E.g. given
/// `parent` -> submodule `sub` -> submodule `nested`, with only `nested`'s
/// gitfile redirected back at `sub`'s own git directory, `parent
/// .submodule_status("sub", ..)` ALONE — never mind ever asking about
/// `nested` — was confirmed to overflow the stack too (`sub`'s own dirty-
/// status computation transitively walks its reachable workdir, including
/// `nested`, however deep). So `discover_nested_targets` cannot just skip
/// calling status for the cyclic node while trusting its ancestors' OWN
/// already-computed status to be safe — every ancestor up to and including
/// the offending node must be identified as unsafe-to-status-check BEFORE any
/// of them are queried, which is why this function now does a
/// post-order walk: it recurses into a submodule's own children FIRST
/// (`sm.open()` + `check_safe_to_recurse`/depth-check only — always safe, no
/// status calls) and only calls `nested_submodule_status` for a node ONCE
/// its entire reachable subtree, at any depth, is confirmed cycle-free. This
/// is also why `submodule_foreach_run` no longer special-cases the TOP-LEVEL
/// list via M1's `submodule_status_inner` (see this section's own doc
/// comment): that call is exactly as unsafe as any deeper one for the exact
/// same reason.
///
/// Fixed by canonicalizing (`std::fs::canonicalize`) each submodule's own
/// resolved GIT DIRECTORY (`Repository::path()`, exactly what
/// `Submodule::open()` hands back — this, not the working directory, is what
/// determines what `repo.submodules()`/`repo.submodule_status()` will chase
/// NEXT, so it's the correct cycle key: a workdir-only alias with a
/// genuinely distinct, non-cyclic git directory can never re-trigger the
/// same `.gitmodules` read) and tracking the set of canonical paths already
/// visited in a `HashSet` threaded through the whole recursive walk
/// (`visited`, seeded by the caller with the outermost superproject's own
/// canonical git directory — see `submodule_foreach_run`). See
/// `check_safe_to_recurse` for the actual check/insert. `MAX_SUBMODULE_RECURSION_DEPTH`
/// above is an additional, independent depth cap applied alongside this one
/// — defense-in-depth, not a substitute for it.
///
/// Either check failing (a real cycle, an unresolvable path, or the depth cap)
/// reports a distinct "skipped" entry with a clear message for the OFFENDING
/// path (see `ForeachTarget::skip_reason`) rather than silently dropping it OR
/// crashing — `submodule_foreach_run` surfaces it to the caller/frontend as
/// `SubmoduleForeachEntry { status: "skipped", stderr: <message>, .. }`,
/// exactly like every other skip reason already flowing through that same
/// vocabulary. When a DEEPER node is the one actually found unsafe, every
/// ancestor back up to (and including) the top-level submodule ALSO gets its
/// own "skipped" entry (a distinct message naming the deeper path that made it
/// unsafe) instead of a real status — never a guessed "clean"/"ok" for
/// something this code could not actually verify without risking the exact
/// crash being fixed.
///
/// Recursively discover every submodule registered INSIDE `repo`, to any
/// depth (capped, see above) — `repo` may be the OUTERMOST superproject
/// itself (`prefix: ""`, called once from `submodule_foreach_run`) or a
/// submodule's own already-open repository one or more levels down. Mirrors
/// the exact traversal shape `first_dirty_nested_submodule` (M4, above)
/// already uses for its own dirty-content detection one level down (`sub_repo
/// .submodules()`, `open()` each nested one, recurse), reused/mirrored here
/// rather than writing a third copy of that walk — just collecting full
/// (path, status) entries instead of a single dirty boolean. NOTE:
/// `first_dirty_nested_submodule` itself has no analogous crash risk to fix —
/// it never calls `submodule_status` at all (only diffs/status-walks each
/// repo's OWN tree directly), so it was never exposed to this specific
/// libgit2 behavior.
///
/// `prefix` is `repo`'s own path relative to the OUTERMOST repo (`""` for the
/// outermost repo itself, "sub" one level deep, ...) — folded onto each
/// submodule's own path so the result always reads root-relative
/// ("sub"/"sub/nested"), matching real `git submodule foreach`'s own path
/// display, never just the leaf name.
///
/// `recurse` is the user-facing `recursive` flag: when `false`, deeper
/// submodule-of-a-submodule entries are NOT included in the returned `Vec`
/// (matching `git submodule foreach` without `--recursive`) — but this
/// function still WALKS to full depth underneath every returned entry
/// regardless of `recurse`, because (per the second empirical surprise above)
/// that is the only way to know whether it's even safe to compute THAT
/// entry's own status; only whether the deeper results are also *returned* is
/// gated by `recurse`, not whether they're *computed* at all.
///
/// Returns `(targets, subtree_tainted)`: `targets` is this level's entries
/// (plus deeper ones when `recurse`), and `subtree_tainted` is `true` when
/// ANYTHING in `repo`'s own reachable subtree (at any depth, regardless of
/// `recurse`) was found cyclic or past the depth cap — the caller (either
/// this function's own recursive call, or `submodule_foreach_run` for the
/// outermost call) needs this bit to decide whether it is safe to compute
/// ITS OWN status, not just whether to include deeper entries.
///
/// A submodule whose own status can't even be read, or whose nested repo
/// can't be opened, is treated the same conservative way `open_submodule_repo`
/// callers already do elsewhere in this file: never guessed at, just recorded
/// as unreachable (a read failure here maps to "not-initialized", the one
/// status this function's caller already treats as "nothing to run") rather
/// than risking a false "clean"/"ok" classification for a submodule this
/// function genuinely could not inspect.
fn discover_nested_targets(
    repo: &Repository,
    prefix: &str,
    visited: &mut HashSet<std::path::PathBuf>,
    depth: usize,
    recurse: bool,
) -> (Vec<ForeachTarget>, bool) {
    let mut out = Vec::new();
    let mut tainted = false;
    let Ok(submodules) = repo.submodules() else { return (out, false) };
    for sm in submodules {
        let name = sm.name().unwrap_or_default().to_string();
        let sm_path = sm.path().to_string_lossy().to_string();
        let full_path = join_path(prefix, &sm_path);

        // CRASH FIX — MUST happen before `nested_submodule_status` (which
        // calls `repo.submodule_status()`) is ever called below, not after:
        // see this function's own doc comment for the empirically-confirmed
        // reason. `sm.open()` failing just means this submodule isn't
        // checked out at all — nothing to check for a cycle, and definitely
        // nothing unsafe to recurse into — so status is read normally below
        // regardless.
        let Ok(sub_repo) = sm.open() else {
            let status = nested_submodule_status(repo, &name, &sm_path);
            out.push(ForeachTarget { path: full_path, status, skip_reason: None });
            continue;
        };

        if depth >= MAX_SUBMODULE_RECURSION_DEPTH {
            tainted = true;
            out.push(ForeachTarget {
                path: full_path,
                status: "not-initialized".to_string(),
                skip_reason: Some(format!(
                    "reached the maximum nested-submodule recursion depth \
                     ({MAX_SUBMODULE_RECURSION_DEPTH}) — refusing to recurse further \
                     (possible cyclic submodule reference)"
                )),
            });
            continue;
        }

        if let Err(reason) = check_safe_to_recurse(&sub_repo, &full_path, visited) {
            // NEVER call `repo.submodule_status()` (via `nested_submodule_status`)
            // for this target — that is the exact call confirmed to crash on
            // a cyclic submodule.
            tainted = true;
            out.push(ForeachTarget { path: full_path, status: "not-initialized".to_string(), skip_reason: Some(reason) });
            continue;
        }

        // This node's OWN git directory is confirmed unique/non-cyclic — but
        // per the second empirical surprise (see doc comment above), that
        // alone does not make it safe to ask for ITS status yet: something
        // DEEPER in its own subtree might still be cyclic, and that alone is
        // enough to crash a status query for THIS node too. So recurse into
        // its children FIRST (always safe: open+canonicalize only, no status
        // calls) regardless of `recurse`, and only proceed to compute this
        // node's own status once the whole subtree comes back clean.
        let (nested_targets, nested_tainted) = discover_nested_targets(&sub_repo, &full_path, visited, depth + 1, recurse);
        if nested_tainted {
            tainted = true;
            out.push(ForeachTarget {
                path: full_path.clone(),
                status: "not-initialized".to_string(),
                skip_reason: Some(format!(
                    "{full_path} contains a cyclic (or too-deep) nested submodule reference somewhere in its own \
                     subtree — refusing to compute its status"
                )),
            });
            if recurse {
                out.extend(nested_targets);
            }
            continue;
        }

        // Confirmed this node's ENTIRE reachable subtree is cycle-free: safe
        // to ask libgit2 for its real status now.
        let status = nested_submodule_status(repo, &name, &sm_path);
        out.push(ForeachTarget { path: full_path, status, skip_reason: None });
        if recurse {
            out.extend(nested_targets);
        }
    }
    (out, tainted)
}

/// `format!("{prefix}/{leaf}")`, except a `""` prefix (the outermost repo,
/// which has no root-relative path of its own) contributes no leading
/// slash — used so `discover_nested_targets` can be called uniformly from
/// `submodule_foreach_run` with `prefix: ""` for the outermost repo's own
/// direct children, instead of needing a special first-level case.
fn join_path(prefix: &str, leaf: &str) -> String {
    if prefix.is_empty() {
        leaf.to_string()
    } else {
        format!("{prefix}/{leaf}")
    }
}

/// `discover_nested_targets`'s own status classification for one nested
/// submodule (`name`/`sm_path` relative to `repo`) — factored out purely to
/// avoid a third copy of the same conflicted-then-bit-derived logic
/// `submodule_status_inner` and `discover_nested_targets` already both
/// needed inline; NOT itself part of the crash fix (this function is only
/// ever called once the caller has already confirmed it's safe to do so —
/// see `discover_nested_targets`'s doc comment for why that confirmation
/// must happen BEFORE this is called, not after).
fn nested_submodule_status(repo: &Repository, name: &str, sm_path: &str) -> String {
    match repo.submodule_status(name, SubmoduleIgnore::None) {
        Ok(bits) => {
            if submodule_conflicted(repo, sm_path).unwrap_or(false) {
                "conflicted".to_string()
            } else {
                classify_status(bits)
            }
        }
        // Could not read status at all -> treat as skippable rather than
        // guessing "clean" and running an arbitrary command somewhere this
        // function couldn't actually verify is safe to enter.
        Err(_) => "not-initialized".to_string(),
    }
}

/// Shared cycle-detection primitive used by every one of
/// `discover_nested_targets`'s own recursive calls (including its very first
/// one, from `submodule_foreach_run`, against the outermost repo's own direct
/// children) — the identical canonicalize-check-insert sequence right before
/// descending one level further into a submodule's own nested submodules.
/// See `discover_nested_targets`'s doc comment for the full
/// empirically-confirmed crash this fixes.
///
/// Returns `Ok(())` — having inserted `sub_repo`'s canonical git directory
/// into `visited` — when it is safe to recurse into `sub_repo`. Returns
/// `Err(message)` (never inserting anything) when it is NOT: either the path
/// could not be resolved at all (treated conservatively as "might be a cycle
/// we can't verify, refuse rather than guess"), or it resolves to a path
/// already in `visited` (a genuine cycle: this exact git directory — an
/// ancestor's own, or any other repo already visited on this sweep — is
/// already being walked). Either way the caller must record a "skipped"
/// entry carrying this message for `full_path` and must NOT recurse.
fn check_safe_to_recurse(
    sub_repo: &Repository,
    full_path: &str,
    visited: &mut HashSet<std::path::PathBuf>,
) -> Result<(), String> {
    match fs::canonicalize(sub_repo.path()) {
        Ok(canon) if visited.contains(&canon) => Err(format!(
            "cyclic submodule reference detected at {full_path} (its repository resolves to one already being \
             walked in this sweep — its own containing repo, or an ancestor) — refusing to recurse into it"
        )),
        Ok(canon) => {
            visited.insert(canon);
            Ok(())
        }
        Err(e) => Err(format!(
            "{full_path}'s repository path could not be resolved ({e}) — refusing to recurse into it in case of a \
             cyclic submodule reference"
        )),
    }
}

/// Caps so one runaway/chatty submodule command's stdout or stderr can't blow
/// up the progress payload — same truncate-and-flag spirit as `commands.rs`'s
/// `MAX_FILES`/`MAX_LINES_PER_FILE` cap on `commit_detail`'s diff output, just
/// measured in characters for free-form process output rather than diff
/// files/lines (an arbitrary shell command has no "hunk" structure to cap by).
const MAX_OUTPUT_CHARS: usize = 20_000;

fn cap_output(s: String) -> String {
    let total = s.chars().count();
    if total <= MAX_OUTPUT_CHARS {
        return s;
    }
    let head: String = s.chars().take(MAX_OUTPUT_CHARS).collect();
    format!("{head}\n… (truncated, {} more character(s) not shown)", total - MAX_OUTPUT_CHARS)
}

/// Run `command` through a shell (`sh -c` on Unix, `cmd /C` on Windows —
/// identical cross-platform gating to `git_bisect.rs`'s own
/// `run_test_command`) with its current working directory set to `cwd` (a
/// single submodule's own working tree). Returns `Err` only when the shell
/// itself could not be spawned; a nonzero exit is a normal, expected way for
/// the command to report failure and comes back as `Ok` with that code —
/// unlike bisect there is no exit-code convention to interpret here (no
/// good/bad/skip), just the raw code plus captured stdout/stderr.
fn run_foreach_command(cwd: &std::path::Path, command: &str) -> Result<(i32, String, String), String> {
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(command);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(command);
        c
    };
    cmd.current_dir(cwd);
    let output = cmd.output().map_err(|e| format!("Could not run the command: {e}"))?;
    let code = output.status.code().unwrap_or(-1);
    Ok((
        code,
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
        String::from_utf8_lossy(&output.stderr).trim().to_string(),
    ))
}

/// One submodule's result from a `submodule_foreach_start` sweep — the SAME
/// struct is both pushed into the returned `Vec` and emitted verbatim as the
/// "submodule-foreach-progress" event payload as each submodule finishes
/// (mirrors `bisect_run_start`'s own "emit the same struct type as the return
/// value, don't invent a second payload shape" precedent — see `BisectStatus`
/// there).
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleForeachEntry {
    /// Root-relative submodule path (e.g. "sub" or "sub/nested"), exactly
    /// like `SubmoduleInfo::path`/real `git submodule foreach`'s own display.
    pub path: String,
    /// "ok" (exit 0) | "failed" (nonzero exit, OR the shell itself couldn't
    /// even be spawned) | "skipped" (not-initialized/removed — no command
    /// run) | "cancelled" (never reached — a cancellation request was
    /// observed before this submodule's turn).
    pub status: String,
    /// The command's raw process exit code. `None` for "skipped"/"cancelled"
    /// (no command ever ran), and also `None` on the rare "failed" case where
    /// the shell itself could not be spawned at all (no exit code exists).
    pub exit_code: Option<i32>,
    /// Captured stdout, capped by `cap_output` — empty for "skipped"/
    /// "cancelled".
    pub stdout: String,
    /// Captured stderr, capped by `cap_output` — for the shell-could-not-be-
    /// spawned "failed" case this carries the spawn error message instead (no
    /// real stderr exists to capture).
    pub stderr: String,
}

/// State for an in-flight `submodule_foreach_start` sweep, `app.manage()`d in
/// lib.rs — copies `BisectRunState`'s shape field-for-field (see this
/// section's doc comment for why: that shape is already the FIXED one, not
/// the original bare-cancellation-flag version). `running` is the real,
/// structurally-enforced mutual-exclusion lock (`try_start`'s
/// `compare_exchange`); `cancel` is a plain signal polled between submodule
/// iterations. Exactly one `SubmoduleForeachState` per app, mirroring
/// `BisectRunState`'s own "one automated run at a time" scope.
#[derive(Default)]
pub struct SubmoduleForeachState {
    cancel: AtomicBool,
    running: AtomicBool,
}

impl SubmoduleForeachState {
    fn request_cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }
    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
    fn clear_cancel(&self) {
        self.cancel.store(false, Ordering::SeqCst);
    }
    /// Atomically claim the "a sweep is in flight" guard — see
    /// `BisectRunState::try_start`'s doc comment for why `compare_exchange`
    /// (not a plain load-then-store) is what makes this a REAL lock rather
    /// than a check-then-act race.
    fn try_start(&self) -> bool {
        self.running.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok()
    }
    /// Release the claim. Must run on every exit path out of a sweep that
    /// successfully claimed it.
    fn finish(&self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

/// The core foreach sweep, independent of any running Tauri app — split out
/// from the `#[tauri::command]` exactly like `run_bisect` is split from
/// `bisect_run_start`, so it's directly unit-testable without a real
/// AppHandle/State (see tests/submodule.rs). `should_cancel` is polled once
/// per submodule iteration, BEFORE that submodule's command would run (see
/// this section's doc comment for why not mid-command); `on_progress` fires
/// once per submodule — skipped, cancelled, or actually run — with the exact
/// same `SubmoduleForeachEntry` this function eventually returns for that
/// submodule.
pub fn submodule_foreach_run(
    path: &str,
    command: &str,
    recursive: bool,
    should_cancel: impl Fn() -> bool,
    mut on_progress: impl FnMut(&SubmoduleForeachEntry),
) -> Result<Vec<SubmoduleForeachEntry>, String> {
    let repo = crate::trust::open_repo(path).map_err(|e| format!("Cannot open repository: {}", e.message()))?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "Repository has no working directory (bare repository?).".to_string())?
        .to_path_buf();

    // CRASH FIX: seed the cycle-detection set with the OUTERMOST
    // superproject's own canonical git directory before any recursion starts
    // — closes the case where a top-level submodule's gitfile points back at
    // ITS OWN containing (outermost) repo, not just at some deeper ancestor
    // discovered along the way. See `discover_nested_targets`'s doc comment
    // for the full empirically-confirmed crash this whole `visited` set
    // fixes, and `check_safe_to_recurse` for the shared check this and every
    // recursive descent below use before entering a submodule's own nested
    // submodules.
    let mut visited: HashSet<std::path::PathBuf> = HashSet::new();
    if let Ok(canon) = fs::canonicalize(repo.path()) {
        visited.insert(canon);
    }

    // CRASH FIX: the top-level list is now discovered through the SAME safe,
    // taint-aware walk as every deeper submodule-of-a-submodule level
    // (`discover_nested_targets`, called here against the outermost repo
    // itself with an empty path prefix) — NOT via M1's `submodule_status_inner`
    // the way an earlier version of this code did. See `discover_nested_targets`'s
    // own doc comment, and this section's top doc comment, for why reusing
    // that M1 wrapper directly for the top level was itself found unsafe:
    // EMPIRICALLY CONFIRMED that even a single top-level submodule's own
    // status query can crash if anything in ITS reachable subtree, at any
    // depth, is cyclic. The second return value (whether the outermost repo's
    // own reachable forest was tainted anywhere) is intentionally discarded
    // here — there is no ancestor above the outermost repo to report it to;
    // any tainted node along the way already has its own "skipped" entry
    // inside `targets`.
    let (targets, _root_tainted) = discover_nested_targets(&repo, "", &mut visited, 0, recursive);

    let mut out = Vec::with_capacity(targets.len());
    for (i, target) in targets.iter().enumerate() {
        // Checked BETWEEN every iteration, including before the very first —
        // see this section's doc comment for the documented not-mid-command
        // TOCTOU limitation this shares with `run_bisect`.
        if should_cancel() {
            for remaining in &targets[i..] {
                let entry = SubmoduleForeachEntry {
                    path: remaining.path.clone(),
                    status: "cancelled".to_string(),
                    exit_code: None,
                    stdout: String::new(),
                    stderr: String::new(),
                };
                on_progress(&entry);
                out.push(entry);
            }
            return Ok(out);
        }

        let entry = if let Some(reason) = &target.skip_reason {
            // CRASH FIX: a cyclic submodule reference or a hard recursion-
            // depth-cap refusal (see `discover_nested_targets`'s doc comment)
            // — reported the same "skipped" way as not-initialized/removed
            // below, just with a clear message in `stderr` instead of an
            // empty one, and checked FIRST since `target.status` here is
            // still whatever this submodule's own ordinary classification
            // was (e.g. "clean") — it's the recursion into it, not the
            // submodule itself, that was refused.
            SubmoduleForeachEntry {
                path: target.path.clone(),
                status: "skipped".to_string(),
                exit_code: None,
                stdout: String::new(),
                stderr: reason.clone(),
            }
        } else if target.status == "not-initialized" || target.status == "removed" {
            SubmoduleForeachEntry {
                path: target.path.clone(),
                status: "skipped".to_string(),
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
            }
        } else {
            let cwd = workdir.join(&target.path);
            match run_foreach_command(&cwd, command) {
                Ok((code, stdout, stderr)) => SubmoduleForeachEntry {
                    path: target.path.clone(),
                    // No good/bad/skip semantics here — just pass/fail.
                    status: if code == 0 { "ok".to_string() } else { "failed".to_string() },
                    exit_code: Some(code),
                    stdout: cap_output(stdout),
                    stderr: cap_output(stderr),
                },
                Err(e) => SubmoduleForeachEntry {
                    path: target.path.clone(),
                    status: "failed".to_string(),
                    exit_code: None,
                    stdout: String::new(),
                    stderr: cap_output(e),
                },
            }
        };
        // Never abort the sweep because one submodule's command failed — see
        // this section's doc comment for the empirical verification behind
        // that being real git's own default too.
        on_progress(&entry);
        out.push(entry);
    }

    Ok(out)
}

/// Claim `state`'s "already running" guard (see
/// `SubmoduleForeachState::try_start`) and, ONLY if the claim succeeds, run
/// `submodule_foreach_run` to completion, always releasing the guard
/// afterward. Returns `None` — and does not call `submodule_foreach_run` AT
/// ALL — when another sweep is already in flight: a second concurrent
/// `submodule_foreach_start` must refuse cleanly rather than spinning up a
/// second loop that could run commands in the same submodules concurrently.
/// Split out from the `#[tauri::command]` so it's directly unit-testable
/// without a real AppHandle/State (mirrors `try_run_bisect`'s own split from
/// `bisect_run_start`; see tests/submodule.rs).
pub fn try_run_submodule_foreach(
    state: &SubmoduleForeachState,
    path: &str,
    command: &str,
    recursive: bool,
    should_cancel: impl Fn() -> bool,
    on_progress: impl FnMut(&SubmoduleForeachEntry),
) -> Option<Result<Vec<SubmoduleForeachEntry>, String>> {
    if !state.try_start() {
        return None;
    }
    state.clear_cancel(); // a stale cancel from a previous sweep must never leak into this one
    let result = submodule_foreach_run(path, command, recursive, should_cancel, on_progress);
    state.clear_cancel(); // always leave the flag clear on the way out, whatever the reason
    state.finish(); // release the sweep-in-progress claim on every exit path, mirroring the above
    Some(result)
}

/// Run `command` (via a shell) once in every initialized submodule's own
/// working directory (`recursive:true` also descends into a
/// submodule-of-a-submodule), emitting a `"submodule-foreach-progress"` event
/// with each submodule's `SubmoduleForeachEntry` as it completes and
/// returning the full list at the end. Refuses cleanly (no sweep attempted)
/// if another sweep is already in flight for this app — see
/// `try_run_submodule_foreach`.
/// JS call: `invoke("submodule_foreach_start", { path, command, recursive })`.
#[tauri::command]
#[specta::specta]
pub fn submodule_foreach_start(
    app: AppHandle<Wry>,
    state: State<SubmoduleForeachState>,
    path: String,
    command: String,
    recursive: bool,
) -> Result<Vec<SubmoduleForeachEntry>, String> {
    let outcome = try_run_submodule_foreach(
        &state,
        &path,
        &command,
        recursive,
        || state.is_cancelled(),
        |entry| {
            let _ = app.emit("submodule-foreach-progress", entry);
        },
    );
    match outcome {
        Some(result) => result,
        None => Err(
            "A submodule foreach sweep is already in progress — cancel it before starting another.".to_string(),
        ),
    }
}

/// Request that an in-flight `submodule_foreach_start` sweep stop before its
/// next submodule. Always callable (mirrors `bisect_run_cancel`'s own
/// always-callable escape-hatch spirit), though this only sets a flag rather
/// than mutating repo state.
/// JS call: `invoke("submodule_foreach_cancel")`.
#[tauri::command]
#[specta::specta]
pub fn submodule_foreach_cancel(state: State<SubmoduleForeachState>) -> Result<(), String> {
    state.request_cancel();
    Ok(())
}

