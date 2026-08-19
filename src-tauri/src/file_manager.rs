//! "Show in <file manager>" / "Open in <file manager>" — the two context-menu
//! actions that hand a path to the desktop's own file browser (Explorer,
//! Finder, or whatever the Linux session provides).
//!
//! These go through Rust even though `@tauri-apps/plugin-opener` ships a JS
//! binding for both, and `revealItemInDir` is already allowed by this app's
//! `opener:default` capability. The OPEN half is the reason: it needs
//! `allow-open-path`, and that permission's scope check (`scope.rs`'s
//! `is_path_allowed`) ends in `self.allowed.iter().any(...)`, which is false
//! for an empty allow list — so the capability would also have to carry one,
//! and the only list broad enough for "whichever repo the user has open" is
//! `**`. That grants the webview the right to ask the OS to open ANY path
//! with its default application, and this app runs third-party plugin code in
//! that webview (see `plugin_exec.rs`). Keeping both actions here puts them
//! behind `trust::open_repo` instead — the same gate `terminal.rs` uses for
//! the considerably more powerful shell it spawns.
//!
//! Both commands take the repo path and a repo-RELATIVE path (the form every
//! file list in the app already holds, and the form git itself prints), empty
//! for the repo itself. Joining them here keeps the join and its containment
//! check in one testable place rather than repeated in each caller's Svelte.

use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, Wry};
use tauri_plugin_opener::OpenerExt;

use crate::i18n_err::ierrp;

/// A path in the form the desktop shell accepts, not merely the form the
/// Win32 file APIs accept.
///
/// The two plugin calls below disagree about the Windows extended-length
/// `\\?\C:\…` form: `reveal_item_in_dir` puts its argument through
/// `dunce::simplified`, which drops the prefix, while `open_path` only stats
/// the path (which succeeds — that is exactly what the prefix is for) and
/// then hands it to `ShellExecute`, which does not understand it. Same input,
/// one works and one does not.
///
/// Nothing upstream should hand us that form today: `repo_registry::normalize`
/// and the `gitcat .` argument classifier both strip it (see
/// `windows::strip_windows_verbatim_prefix`, and #42 for what happens when a
/// path in this form reaches something that cannot take it). So this is the
/// invariant held where it is relied on, rather than a fix for a path anyone
/// has seen arrive. A no-op for every other input, on every platform.
fn shell_path(repo: &str) -> String {
    crate::windows::strip_windows_verbatim_prefix(repo.to_string())
}

/// Join a repo-relative path onto its repo, refusing anything that would
/// escape.
///
/// Callers pass paths that came from this app's own file lists, so a
/// traversal here would be a bug rather than an attack — but the check is two
/// lines and the failure it prevents (revealing, or opening, a file outside
/// the repo the user trusted) is the kind that is embarrassing to explain
/// afterwards.
///
/// Rejects an absolute `relative`, any `..`, and a Windows drive prefix.
/// Plain `.` components are dropped rather than refused: they are harmless
/// and `Path::components` produces them for a leading `./`.
///
/// The repo base goes through [`shell_path`] first, so the joined result is a
/// form the shell will accept.
fn resolve_in_repo(repo: &str, relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if rel.is_absolute() {
        return Err(format!("refusing an absolute path where a repo-relative one was expected: {relative}"));
    }
    let mut out = PathBuf::from(shell_path(repo));
    for c in rel.components() {
        match c {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            // ParentDir, RootDir and Prefix all mean this is not the
            // repo-relative path it claimed to be.
            _ => return Err(format!("refusing a path that escapes the repository: {relative}")),
        }
    }
    Ok(out)
}

/// JS: `commands.revealPathInFileManager(repo, relative)` — a file row's
/// "Show in <file manager>": opens the containing folder with the file
/// selected. `async` + `run_blocking` because the trust gate is a git2
/// `Repository::open`, exactly as in `terminal_spawn`.
#[tauri::command]
#[specta::specta]
pub async fn reveal_path_in_file_manager(app: AppHandle<Wry>, repo: String, relative: String) -> Result<(), String> {
    let target = crate::blocking::run_blocking(move || {
        if let Err(e) = crate::trust::open_repo(&repo) {
            return Err(ierrp("err_misc.cannot_open_repo_cap", &[("detail", e.message())]));
        }
        resolve_in_repo(&repo, &relative)
    })
    .await?;
    app.opener().reveal_item_in_dir(target).map_err(|e| e.to_string())
}

/// JS: `commands.openDirInFileManager(repo, relative)` — the topbar repo
/// chip's and a folder row's "Open in <file manager>".
///
/// `open_path`, not the reveal above: revealing a directory opens its PARENT
/// with the directory merely selected, and a folder is a thing you want to be
/// INSIDE. That distinction is the whole reason the two labels use different
/// verbs (see `legacy/platform.ts`).
///
/// An empty `relative` means the repo itself, which is what the repo chip
/// passes. `resolve_in_repo` already drops the nothing-at-all case, so the
/// chip and a folder row go through one command rather than two that would
/// have to be kept in step.
#[tauri::command]
#[specta::specta]
pub async fn open_dir_in_file_manager(app: AppHandle<Wry>, repo: String, relative: String) -> Result<(), String> {
    let path = crate::blocking::run_blocking(move || {
        if let Err(e) = crate::trust::open_repo(&repo) {
            return Err(ierrp("err_misc.cannot_open_repo_cap", &[("detail", e.message())]));
        }
        resolve_in_repo(&repo, &relative)
    })
    .await?;
    // `open_path` takes a String where `reveal_item_in_dir` takes a Path, so
    // this one has to come back out. Nothing can be lost: both halves arrived
    // as Rust `String`s and are therefore already UTF-8, and the join only
    // concatenates components of them.
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_a_repo_relative_path_onto_its_repo() {
        let out = resolve_in_repo("/home/me/proj", "src/main.rs").expect("a plain relative path joins");
        assert_eq!(out, Path::new("/home/me/proj").join("src").join("main.rs"));
    }

    // The repo chip's own "Open in <file manager>" passes an empty relative,
    // so one command serves both it and a folder row. An empty path has no
    // components at all, which is why this needs no special case above — but
    // it is the whole reason the two callers can share, so it is pinned.
    #[test]
    fn an_empty_relative_means_the_repo_itself() {
        assert_eq!(resolve_in_repo("/home/me/proj", "").expect("empty joins"), Path::new("/home/me/proj"));
        assert_eq!(resolve_in_repo("/home/me/proj", ".").expect("a bare dot joins"), Path::new("/home/me/proj"));
    }

    // A directory is an ordinary relative path — nothing about the join cares
    // that the target is a folder, and a trailing slash (which a tree node's
    // path never has, but a caller could) must not produce a stray component.
    #[test]
    fn joins_a_directory_the_same_way() {
        assert_eq!(resolve_in_repo("/repo", "src/islands").expect("joins"), Path::new("/repo").join("src").join("islands"));
        assert_eq!(resolve_in_repo("/repo", "src/islands/").expect("joins"), Path::new("/repo").join("src").join("islands"));
    }

    // `Path::components` yields CurDir for a leading "./", and git itself
    // never prints one — but a caller trimming a prefix can produce it, and
    // refusing would be a pointless failure.
    fn dropped(p: &str) -> PathBuf {
        resolve_in_repo("/repo", p).expect("should join")
    }
    #[test]
    fn a_leading_dot_segment_is_dropped_rather_than_refused() {
        assert_eq!(dropped("./src/main.rs"), Path::new("/repo").join("src").join("main.rs"));
    }

    // The point of the check: these are the shapes that would put the
    // revealed item outside the repo the user actually trusted.
    #[test]
    fn refuses_anything_that_leaves_the_repo() {
        assert!(resolve_in_repo("/home/me/proj", "../secrets").is_err());
        assert!(resolve_in_repo("/home/me/proj", "src/../../secrets").is_err());
        assert!(resolve_in_repo("/home/me/proj", "/etc/passwd").is_err());
    }

    // A drive-qualified path is refused where it can actually denote a drive:
    // on Windows `C:\Windows\System32` is absolute, so the guard above rejects
    // it before any component is looked at.
    //
    // Off Windows the same string is not a path at all. Backslash is an
    // ordinary filename character there, so it arrives as ONE Normal
    // component — `Component::Prefix` is Windows-only and never appears — and
    // git can legitimately track a file named exactly that. Refusing it would
    // be a false positive on a real file, and there is nothing to refuse it
    // for: the join still lands inside the repo, which is the property this
    // function exists to guarantee. So that is what gets asserted instead.
    //
    // (An earlier version of this asserted Err on both platforms, on the
    // reasoning that a drive letter becomes a Prefix component off Windows.
    // It does not, and Linux CI said so: `Ok("C:\\repo/C:\\Windows\\System32")`.)
    #[test]
    fn a_drive_qualified_path_is_refused_on_windows_and_contained_elsewhere() {
        let out = resolve_in_repo(r"C:\repo", r"C:\Windows\System32");
        #[cfg(windows)]
        assert!(out.is_err(), "a drive-qualified path is absolute on Windows: {out:?}");
        #[cfg(not(windows))]
        assert_eq!(
            out.expect("off Windows this is an ordinary, if odd, filename"),
            Path::new(r"C:\repo").join(r"C:\Windows\System32"),
            "it must still land inside the repo"
        );
    }

    // A repo stored in the Windows extended-length form joins into an
    // ordinary path, so `open_path`'s ShellExecute gets something it can use
    // and the two commands agree with each other. Asserted on every platform:
    // it is pure string work, and the rule should not be able to regress on
    // the platform CI does not run it on.
    #[test]
    fn an_extended_length_repo_path_is_reduced_to_the_ordinary_form() {
        assert_eq!(shell_path(r"\\?\C:\Users\me\proj"), r"C:\Users\me\proj");
        assert_eq!(shell_path(r"\\?\UNC\wsl.localhost\Ubuntu\home\me\proj"), r"\\wsl.localhost\Ubuntu\home\me\proj");
        assert_eq!(shell_path("/home/me/proj"), "/home/me/proj");

        let out = resolve_in_repo(r"\\?\C:\repo", "src/main.rs").expect("should join");
        assert_eq!(out, Path::new(r"C:\repo").join("src").join("main.rs"));
    }

    // Spaces, dots and non-ASCII are ordinary in real filenames and must not
    // be confused with traversal.
    #[test]
    fn ordinary_awkward_filenames_still_join() {
        assert!(resolve_in_repo("/repo", "a dir/two words.txt").is_ok());
        assert!(resolve_in_repo("/repo", "docs/.gitkeep").is_ok());
        assert!(resolve_in_repo("/repo", "문서/설계.md").is_ok());
        assert!(resolve_in_repo("/repo", "..hidden-but-not-traversal").is_ok());
    }
}
