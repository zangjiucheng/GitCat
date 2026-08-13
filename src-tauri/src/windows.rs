//! Multi-window: every GitCat window is a genuinely separate OS PROCESS — a
//! fresh invocation of this same executable, optionally pointed at a
//! specific repo — never an additional window inside an already-running
//! process. An earlier draft used Tauri's own multi-window API
//! (`WebviewWindowBuilder` adding a second window to THIS process, with
//! `WatchState`/`GraphLoadState`/`BisectRunState` keyed by window label so
//! the two windows' backend state didn't collide): that approach never
//! correctly wired up pointer-hover interaction on the graph canvas in the
//! second window (a real, confirmed regression), and — independently of
//! that bug — isn't what a "second window" should mean anyway: a genuinely
//! separate process is fully independent (its own backend, memory, crash
//! domain) with NO possibility of the two ever interfering, which a shared-
//! process design can only approximate by hand-keying every piece of state.
//!
//! Every process still creates exactly ONE window, itself, from `run()`'s
//! own `.setup()` hook (`create_initial_window` below) rather than relying
//! on a `tauri.conf.json`-declared window: `tauri.conf.json` deliberately
//! declares zero windows (`"app.windows": []`) so this is the one place a
//! window's title/size is defined, since the URL it loads needs to vary
//! per-process (the `?repo=` query param below) based on THIS process's own
//! `argv[1]` — a static JSON config can't express that.
//!
//! Repo hand-off: `?repo=<percent-encoded path>` on the window's own
//! `index.html` URL, read synchronously by `legacy/main.ts`'s boot sequence
//! before it ever decides between `openRepo(...)` and `bootEmpty()` — this
//! is unchanged from the same-process design's own URL trick, just now
//! sourced from argv instead of always being present/absent based on which
//! code path created the window.

use std::path::Path;
use std::process::Command;

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder, Wry};

use crate::procutil::NoConsoleWindowExt;

const WINDOW_TITLE: &str = "GitCat";
const WINDOW_W: f64 = 1440.0;
const WINDOW_H: f64 = 900.0;
const WINDOW_MIN_W: f64 = 960.0;
const WINDOW_MIN_H: f64 = 600.0;

fn enc(p: &str) -> String {
    percent_encoding::utf8_percent_encode(p, percent_encoding::NON_ALPHANUMERIC).to_string()
}

/// What this process was launched to open, derived from its `argv[1]`.
#[cfg_attr(test, derive(Debug))]
enum InitialArg {
    /// No path argument — a plain double-click launch, or `spawn_new_window(None)`.
    None,
    /// An existing git repo at this path — open it (`?repo=`).
    Repo(String),
    /// A path WAS given but it is not a git repo (or can't be resolved) — still
    /// open a window, but hand the frontend a hint to show (`?repoError=`).
    NotRepo(String),
}

fn window_url(arg: &InitialArg) -> WebviewUrl {
    match arg {
        InitialArg::Repo(p) => WebviewUrl::App(format!("index.html?repo={}", enc(p)).into()),
        InitialArg::NotRepo(p) => WebviewUrl::App(format!("index.html?repoError={}", enc(p)).into()),
        InitialArg::None => WebviewUrl::App("index.html".into()),
    }
}

/// Classify this process's repo argument. Pure over its input so it can be
/// unit-tested; `initial_arg()` below feeds it `std::env::args().nth(1)` (read
/// directly, not from Tauri state, since it's needed before the app/window even
/// exists).
///
/// `code .`-style ergonomics: a RELATIVE path is resolved against the launch CWD
/// (normalizing `.`/`..`/symlinks) so `gitcat .` and `gitcat ../other` work from
/// a terminal; an ABSOLUTE path is used verbatim (no canonicalization) so a repo
/// handed over by `spawn_new_window` keeps the exact identity the registry tracks
/// it under. A leading-`-` arg is ignored — nothing here takes flags, and
/// askpass mode is env-gated, not argv-gated (see askpass.rs). A path that
/// resolves to a real git repo is `Repo`; one that exists but isn't a repo, or
/// can't be resolved at all, is `NotRepo` so the user is told rather than left
/// staring at a window that silently opened nothing.
/// Turn a Windows extended-length "verbatim" path back into its ordinary form.
///
/// `std::fs::canonicalize` on Windows always returns a verbatim path: a normal
/// drive path comes back as `\\?\C:\…`, and a UNC/network/WSL share as
/// `\\?\UNC\server\share\…`. That prefix is valid for the Win32 file APIs, but
/// almost everything downstream expects the plain form: libgit2's own path
/// splitting, `git.exe -C`, the `\\wsl.localhost\…` detector in `wsl.rs`, the
/// repo registry's path-equality checks, and the path shown in the UI. The GUI
/// never produces a verbatim path (it opens absolute paths as-is), so a
/// `gitcat .`-style relative launch — the one code path that runs through
/// `canonicalize` — was the only way one ever reached the app.
///
/// Maps `\\?\UNC\server\share` back to `\\server\share` (so a WSL repo becomes
/// the `\\wsl.localhost\<distro>\…` form `wsl::wsl_target` understands) and
/// `\\?\C:\…` back to `C:\…`. A path without the prefix (every non-Windows
/// path, and any already-plain input) is returned untouched, so this is safe to
/// call unconditionally. Pure string work, unit-tested on every platform.
pub(crate) fn strip_windows_verbatim_prefix(p: String) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = p.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        p
    }
}

fn classify_initial_arg(raw: Option<String>) -> InitialArg {
    let raw = match raw {
        Some(r) if !r.is_empty() && !r.starts_with('-') => r,
        _ => return InitialArg::None,
    };
    let abs = if Path::new(&raw).is_absolute() {
        raw.clone()
    } else {
        // Relative: resolve against the CWD. canonicalize requires the path to
        // exist, so a bogus relative arg falls through to the NotRepo hint with
        // its original text (the most useful thing to show the user).
        //
        // On Windows canonicalize returns an extended-length "verbatim" path
        // (`\\?\C:\…`); strip that prefix back to the ordinary form the rest of
        // the app expects (see `strip_windows_verbatim_prefix`). Without this,
        // `gitcat .` opened a `\\?\C:\…` repo that libgit2 mishandled and the
        // graph came up blank — while `gitcat C:\abs\path` (kept verbatim above,
        // never canonicalized) and every GUI open worked, since only a relative
        // arg reaches canonicalize.
        match std::fs::canonicalize(&raw).ok().and_then(|p| p.to_str().map(str::to_string)) {
            Some(a) => strip_windows_verbatim_prefix(a),
            None => return InitialArg::NotRepo(raw),
        }
    };
    // Validate with the SAME opener every backend read uses — `trust::open_repo`,
    // which auto-trusts libgit2's "dubious ownership" refusal for WSL/UNC/network
    // paths (see trust.rs) and is what `load_graph` and the setup wizard's
    // pick-a-repo step both go through. A raw `Repository::open` here would reject
    // a valid WSL/network repo the app opens fine, wrongly hinting "not a git
    // repository" for both `gitcat <wsl-path>` and the Dashboard's "Open in New
    // Window" (which routes through this same classifier via spawn_new_window).
    if crate::trust::open_repo(&abs).is_ok() {
        InitialArg::Repo(abs)
    } else {
        InitialArg::NotRepo(abs)
    }
}

fn initial_arg() -> InitialArg {
    classify_initial_arg(std::env::args().nth(1))
}

/// Called once, from `run()`'s own `.setup()` hook — creates THIS process's
/// one and only window, labeled "main" (matching `capabilities/default.json`'s
/// existing `"windows": ["main"]` scope — every process's own window reuses
/// this same label; labels are process-scoped, not global, so there's no
/// collision to worry about), pointed at whichever repo (if any) this
/// process was launched with.
pub fn create_initial_window(app: &AppHandle<Wry>) -> tauri::Result<()> {
    let arg = initial_arg();
    // #39: if this repo is already open in another window — and this launch
    // isn't the explicit "Open in New Window" action (which passes `--new-window`,
    // see spawn_new_window) — raise that window and exit instead of duplicating
    // it. `gitcat <same repo>` run twice now focuses the first window.
    if let InitialArg::Repo(p) = &arg {
        if !std::env::args().any(|a| a == "--new-window") && crate::instance_focus::focus_if_open(app, p) {
            std::process::exit(0);
        }
    }
    // Best-effort terminal hint for `gitcat <not-a-repo>`, visible when launched
    // from a shell (a GUI double-click has no attached terminal — there the
    // in-app hint via ?repoError=, surfaced by legacy/main.ts's boot dispatch,
    // is the real one).
    if let InitialArg::NotRepo(p) = &arg {
        eprintln!("gitcat: {p} is not a git repository");
    }
    // #39: bind this window's focus listener and register the launch repo BEFORE
    // building the (comparatively slow) webview — otherwise a re-launch during
    // window creation / the initial graph load finds no entry and duplicates the
    // window, which is the impatient `gitcat . ; gitcat .` case this targets. The
    // focus handler resolves the "main" window lazily when a ping actually
    // arrives (seconds later, once it's built), so listening first is safe.
    // set_open_repo keeps the entry current across in-place repo switches.
    crate::instance_focus::start_listener(app);
    if let InitialArg::Repo(p) = &arg {
        crate::instance_focus::register(app, p);
    }
    WebviewWindowBuilder::new(app, "main", window_url(&arg))
        .title(WINDOW_TITLE)
        .inner_size(WINDOW_W, WINDOW_H)
        .min_inner_size(WINDOW_MIN_W, WINDOW_MIN_H)
        .center()
        .build()?;
    Ok(())
}

/// Spawns a FRESH, fully independent GitCat process — not an additional
/// window inside this one (see this module's own doc comment for why).
/// `std::process::Command::spawn()` creates a genuinely separate process
/// with no ongoing relationship to this one afterward: closing, crashing, or
/// quitting either process has zero effect on the other, unlike Tauri's own
/// multi-window API (one shared backend/AppHandle/process across every
/// window it creates). Fire-and-forget: nothing here waits for or tracks the
/// spawned process, and a failure (e.g. the exe got moved/deleted out from
/// under a running instance — vanishingly rare) is only logged, not
/// surfaced back to whichever menu click or IPC call triggered this, same
/// as every other best-effort fire-and-forget spawn in this codebase
/// (`watch_repo`'s own callers, `track_repo_opened`).
pub fn spawn_new_window(repo_path: Option<&str>) {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("failed to resolve GitCat's own executable path: {e}");
            return;
        }
    };
    // macOS: launch the new instance the OS-sanctioned way — `open -n`, i.e.
    // via LaunchServices — rather than exec'ing the Mach-O directly. Running
    // the binary directly with Command::spawn produces a process macOS never
    // registers as a first-class "running application": its window appears but
    // is never made key/active, so the ENTIRE keyboard layer (vim-nav
    // j/k/gg/G, Enter-to-open-diff, ⌘K) is dead in it until the user clicks in
    // — and any manual activateIgnoringOtherApps workaround only fights the
    // OTHER, same-bundle-id instance, breaking the parent window's focus
    // instead. `open -n` hands the second instance to LaunchServices, which
    // activates it correctly and lets the window server manage focus between
    // the two instances the normal way — a genuine independent instance, the
    // way double-clicking the app again (or VS Code's own New Window) behaves.
    // `--args <repo>` reaches the new instance as its `argv`, so
    // `initial_repo_arg()` reads it exactly as it does for a direct spawn.
    // Only for a real `.app` bundle; an unbundled `cargo tauri dev` binary
    // falls through to the plain spawn below.
    #[cfg(target_os = "macos")]
    if let Some(bundle) = macos_app_bundle(&exe) {
        let mut cmd = Command::new("open");
        cmd.arg("-n").arg("-a").arg(&bundle);
        if let Some(p) = repo_path {
            // `--new-window` after the repo reaches the new instance's argv and
            // tells it to skip the #39 already-open dedup — this is the explicit
            // "Open in New Window" action, which SHOULD get its own window.
            cmd.arg("--args").arg(p).arg("--new-window");
        }
        match cmd.spawn() {
            Ok(_) => return,
            Err(e) => eprintln!("`open -n` failed ({e}); falling back to a direct spawn"),
        }
    }

    // Windows / Linux (and the macOS dev/unbundled fallback): a plain child
    // process. On these platforms a freshly-created top-level window takes
    // foreground on its own, so no LaunchServices dance is needed.
    let mut cmd = Command::new(&exe);
    if let Some(p) = repo_path {
        cmd.arg(p).arg("--new-window"); // explicit new window: skip the #39 dedup
    }
    cmd.no_console_window();
    if let Err(e) = cmd.spawn() {
        eprintln!("failed to launch a new GitCat process: {e}");
    }
}

/// The `.app` bundle this executable lives inside, when it's a real macOS
/// bundle (`<Name>.app/Contents/MacOS/<bin>`) — `None` for an unbundled
/// binary such as `cargo tauri dev`'s `target/debug/gitcat`, where `open -a`
/// has no bundle to launch and the caller falls back to a direct spawn.
#[cfg(target_os = "macos")]
pub(crate) fn macos_app_bundle(exe: &std::path::Path) -> Option<std::path::PathBuf> {
    let macos = exe.parent()?; // <Name>.app/Contents/MacOS
    let contents = macos.parent()?; // <Name>.app/Contents
    let bundle = contents.parent()?; // <Name>.app
    let looks_like_bundle = macos.file_name().and_then(|n| n.to_str()) == Some("MacOS")
        && contents.file_name().and_then(|n| n.to_str()) == Some("Contents")
        && bundle.extension().and_then(|e| e.to_str()) == Some("app");
    looks_like_bundle.then(|| bundle.to_path_buf())
}

/// JS: `commands.openRepoInNewWindow(path)` — the Dashboard's "Open in New
/// Window" row action (see `src/islands/dashboard/dashboard.svelte.ts`'s
/// `openRepositoryInNewWindow`). Deliberately synchronous/non-async:
/// `Command::spawn()` itself is non-blocking (it doesn't wait for the child
/// process to do anything), so there's no work here that needs Tauri's
/// blocking-task thread pool. Never touches `bridge.openRepo` (the calling
/// window's OWN repo/state) — the whole point is a second, independent
/// process, not switching the current one.
#[tauri::command]
#[specta::specta]
pub fn open_repo_in_new_window(path: String) {
    spawn_new_window(Some(&path));
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
    use std::path::PathBuf;

    // A fresh, unique temp dir path (not created). Nanosecond + pid keeps
    // parallel test runs from colliding — same pattern as the temp dirs the
    // rest of the backend's tests use.
    fn unique_tmp(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("gitcat-initialarg-{tag}-{}-{nanos}", std::process::id()))
    }

    #[test]
    fn none_for_no_arg_empty_or_flag() {
        assert!(matches!(classify_initial_arg(None), InitialArg::None));
        assert!(matches!(classify_initial_arg(Some(String::new())), InitialArg::None));
        assert!(matches!(classify_initial_arg(Some("--help".into())), InitialArg::None));
        assert!(matches!(classify_initial_arg(Some("-v".into())), InitialArg::None));
    }

    #[test]
    fn repo_for_an_existing_git_repo_kept_verbatim() {
        let dir = unique_tmp("repo");
        std::fs::create_dir_all(&dir).unwrap();
        Repository::init(&dir).unwrap();
        let abs = dir.to_str().unwrap().to_string();
        // Absolute path passed through verbatim (no canonicalization), so the
        // opened path is exactly what the caller gave — see classify's doc.
        assert!(matches!(classify_initial_arg(Some(abs.clone())), InitialArg::Repo(p) if p == abs));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn not_repo_for_a_plain_directory() {
        let dir = unique_tmp("plain");
        std::fs::create_dir_all(&dir).unwrap();
        let abs = dir.to_str().unwrap().to_string();
        assert!(matches!(classify_initial_arg(Some(abs.clone())), InitialArg::NotRepo(p) if p == abs));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn not_repo_for_a_missing_absolute_path() {
        let missing = unique_tmp("missing").to_str().unwrap().to_string();
        assert!(matches!(classify_initial_arg(Some(missing.clone())), InitialArg::NotRepo(p) if p == missing));
    }

    #[test]
    fn verbatim_prefix_stripped_to_ordinary_form() {
        // A drive-letter verbatim path (what `gitcat .` produced on Windows,
        // and the reason the graph came up blank) collapses to the plain path.
        assert_eq!(strip_windows_verbatim_prefix(r"\\?\C:\Users\me\proj".into()), r"C:\Users\me\proj");
        // A UNC/WSL share verbatim path collapses to the `\\host\…` form that
        // wsl::wsl_target recognizes, so `gitcat .` inside a WSL directory opens
        // the right repo instead of a mangled one.
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\UNC\wsl.localhost\Ubuntu\home\me\proj".into()),
            r"\\wsl.localhost\Ubuntu\home\me\proj"
        );
        assert_eq!(strip_windows_verbatim_prefix(r"\\?\UNC\server\share\dir".into()), r"\\server\share\dir");
        // Anything without the prefix (every Unix path, any already-plain input)
        // is returned untouched — safe to call unconditionally.
        assert_eq!(strip_windows_verbatim_prefix("/home/me/proj".into()), "/home/me/proj");
        assert_eq!(strip_windows_verbatim_prefix(r"C:\already\plain".into()), r"C:\already\plain");
        assert_eq!(strip_windows_verbatim_prefix(r"\\wsl.localhost\Ubuntu\x".into()), r"\\wsl.localhost\Ubuntu\x");
    }

    #[test]
    fn window_url_carries_repo_vs_error_vs_none() {
        assert!(matches!(window_url(&InitialArg::None), WebviewUrl::App(p) if p.to_str() == Some("index.html")));
        let repo = window_url(&InitialArg::Repo("/tmp/x y".into()));
        assert!(matches!(&repo, WebviewUrl::App(p) if p.to_str().unwrap().starts_with("index.html?repo=") && p.to_str().unwrap().contains("%20")));
        let err = window_url(&InitialArg::NotRepo("/tmp/x y".into()));
        assert!(matches!(&err, WebviewUrl::App(p) if p.to_str().unwrap().starts_with("index.html?repoError=")));
    }
}
