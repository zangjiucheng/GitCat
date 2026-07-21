//! Repo-root text-file editors (backlog #14, final item): view/edit a repo's
//! own .gitignore / .mailmap from inside GitCat.
//!
//! Deliberately NOT a generic "read/write an arbitrary path" command — that
//! would be a much bigger security surface than this feature needs. `file_name`
//! is checked against an explicit allow-list of exactly the two names this
//! feature edits; anything else is rejected outright before any path is ever
//! joined or touched. Path resolution reuses the `repo.workdir()` join pattern
//! already established in reflog.rs/submodule.rs — a bare repo (no working
//! tree) refuses cleanly rather than panicking.
//!
//! No Safety-Manager snapshot: neither command touches a ref, the index, or
//! HEAD — this is a plain workdir text-file edit, identical in kind (and
//! identical in "nothing for Undo to protect") to any edit made in an
//! external editor between GitCat sessions.
//!
//! Missing file (neither exists yet) reads as empty content, not an error —
//! the common first-time-use case (creating a .gitignore/.mailmap for the
//! first time) — matching repo_registry.rs's/tool_settings.rs's own
//! "missing app-config file => empty/default, not an error" convention,
//! applied here to a repo file instead of an app-config file.

use git2::Repository;
use serde::Serialize;
use std::path::PathBuf;

/// The ONLY two file names this module will ever read or write. Anything
/// else is rejected before a path is even constructed.
const ALLOWED_FILES: &[&str] = &[".gitignore", ".mailmap"];

fn validate_file_name(file_name: &str) -> Result<(), String> {
    if ALLOWED_FILES.contains(&file_name) {
        Ok(())
    } else {
        Err(format!(
            "Not an editable repo file: {file_name:?} (only .gitignore and .mailmap are supported)."
        ))
    }
}

fn open(path: &str) -> Result<Repository, String> {
    crate::trust::open_repo(path).map_err(|e| format!("cannot open repository: {}", e.message()))
}

/// Both names are flat, single-component filenames (no `/`) straight from
/// `ALLOWED_FILES` — a plain `Path::join` is sufficient (unlike submodule.rs's
/// `join_native_relative`, there is no multi-component relative path to walk).
fn resolve_path(repo: &Repository, file_name: &str) -> Result<PathBuf, String> {
    repo.workdir()
        .map(|wd| wd.join(file_name))
        .ok_or_else(|| "This repository has no working tree.".to_string())
}

/// Refuse if `file_path` is a symlink — an adversarial review found that a
/// plain `fs::read_to_string`/`fs::write` (which both follow symlinks)
/// let a `.gitignore`/`.mailmap` symlinked to a path OUTSIDE the repo
/// silently disclose that outside file's content into the editor, or
/// silently overwrite it on Save. This codebase already fixed this exact
/// bug class elsewhere (workdir.rs's `backup_untracked_bytes`, submodule.rs's
/// "BUG-4 FIX") by using `fs::symlink_metadata` (which does NOT follow the
/// link) instead of a plain metadata/read/write call — same fix here, just
/// refusing outright rather than backing the link up, since there is no
/// legitimate reason for either of these two files to be a symlink.
/// A NotFound result (nothing there yet) is fine — not a symlink at all.
fn refuse_if_symlink(file_path: &std::path::Path, file_name: &str) -> Result<(), String> {
    match std::fs::symlink_metadata(file_path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(format!("{file_name} is a symlink — refusing to read or write through it for safety."))
        }
        _ => Ok(()), // doesn't exist, or exists and is a plain file: fine either way
    }
}

/// Result of [`write_repo_file`] — deliberately its own minimal shape (just
/// `ok`/`message`), NOT `git_write::WriteResult`: that type carries
/// `backup_ref`/`conflicting_files` this command never populates (no
/// snapshot, no conflicts possible) — reusing it would only carry dead
/// fields, against this codebase's "one type per module once the shape
/// genuinely differs" precedent (see submodule.rs's own
/// `SubmoduleRemovalResult` doc comment).
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoFileResult {
    pub ok: bool,
    pub message: String,
}

/// Read `file_name`'s current content (repo-root only). Missing file => `Ok("")`,
/// never an error — see module doc comment.
/// JS: `commands.readRepoFile(path, fileName)` -> `Result<string, string>`.
///
/// BUG FIX: was a plain (non-async) `fn`. Its body calls `open` -> `crate::trust::open_repo`,
/// which does a git2 `Repository::open` and, on the dubious-ownership retry path, shells out
/// to `git config --global --add safe.directory` twice via `safety::run_git` before retrying —
/// real blocking work on a slow, network, or WSL-bridged path. A plain `fn` `#[tauri::command]`
/// runs that inline on Tauri's main thread, freezing the whole app window (not just this
/// editor pane) for as long as it takes. `async fn` + `run_blocking` matches
/// `dashboard_repo_status`'s/`workdir_status`'s own established fix.
#[tauri::command]
#[specta::specta]
pub async fn read_repo_file(path: String, file_name: String) -> Result<String, String> {
    crate::blocking::run_blocking(move || read_repo_file_inner(&path, &file_name)).await
}

fn read_repo_file_inner(path: &str, file_name: &str) -> Result<String, String> {
    validate_file_name(file_name)?;
    let repo = open(path)?;
    let file_path = resolve_path(&repo, file_name)?;
    refuse_if_symlink(&file_path, file_name)?;
    match std::fs::read_to_string(&file_path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("Could not read {file_name}: {e}")),
    }
}

/// Overwrite `file_name` with `content` verbatim (repo-root only).
/// JS: `commands.writeRepoFile(path, fileName, content)` -> `RepoFileResult`.
///
/// BUG FIX: was a plain (non-async) `fn`, for the identical reason as `read_repo_file`
/// above — it opens the repo through the same `open` -> `crate::trust::open_repo` path,
/// which can block on a git2 `Repository::open` plus (on the ownership-retry path) a
/// synchronous `git config --global` subprocess call. `async fn` + `run_blocking` keeps
/// that off Tauri's main thread the same way.
#[tauri::command]
#[specta::specta]
pub async fn write_repo_file(path: String, file_name: String, content: String) -> RepoFileResult {
    crate::blocking::run_blocking(move || write_repo_file_inner(&path, &file_name, &content)).await
}

fn write_repo_file_inner(path: &str, file_name: &str, content: &str) -> RepoFileResult {
    if let Err(e) = validate_file_name(file_name) {
        return RepoFileResult { ok: false, message: e };
    }
    let repo = match open(path) {
        Ok(r) => r,
        Err(e) => return RepoFileResult { ok: false, message: e },
    };
    let file_path = match resolve_path(&repo, file_name) {
        Ok(p) => p,
        Err(e) => return RepoFileResult { ok: false, message: e },
    };
    if let Err(e) = refuse_if_symlink(&file_path, file_name) {
        return RepoFileResult { ok: false, message: e };
    }
    match std::fs::write(&file_path, content.as_bytes()) {
        Ok(()) => RepoFileResult { ok: true, message: format!("Saved {file_name}.") },
        Err(e) => RepoFileResult { ok: false, message: format!("Could not write {file_name}: {e}") },
    }
}
