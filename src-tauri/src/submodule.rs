//! Submodule status (M1 of 4 — read-only). init/update/add/sync/deinit/remove/
//! foreach are separate later milestones; this module only *reports*.
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

use git2::SubmoduleIgnore;
use serde::Serialize;

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
