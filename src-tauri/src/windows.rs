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

use std::process::Command;

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder, Wry};

use crate::procutil::NoConsoleWindowExt;

const WINDOW_TITLE: &str = "GitCat";

/// Env marker set on a process spawned by `spawn_new_window` so its own
/// `create_initial_window` knows to force-focus its window (see there for
/// why a spawned window otherwise never gets keyboard focus). Deliberately an
/// env var, not an argv flag: `initial_repo_arg()` reads the repo path from
/// `argv[1]`, and a positional flag there would collide with it.
const SPAWNED_MARKER: &str = "GITCAT_SPAWNED";
const WINDOW_W: f64 = 1440.0;
const WINDOW_H: f64 = 900.0;
const WINDOW_MIN_W: f64 = 960.0;
const WINDOW_MIN_H: f64 = 600.0;

fn window_url(repo_path: Option<&str>) -> WebviewUrl {
    match repo_path {
        Some(p) => {
            let encoded = percent_encoding::utf8_percent_encode(p, percent_encoding::NON_ALPHANUMERIC).to_string();
            WebviewUrl::App(format!("index.html?repo={encoded}").into())
        }
        None => WebviewUrl::App("index.html".into()),
    }
}

/// This PROCESS's own repo argument (`argv[1]`) — `None` for a normal
/// double-click launch, `Some(path)` when spawned by `spawn_new_window`
/// below. Read directly from `std::env::args()` (not any Tauri state) since
/// it's needed before the app/window even exists.
fn initial_repo_arg() -> Option<String> {
    std::env::args().nth(1)
}

/// Called once, from `run()`'s own `.setup()` hook — creates THIS process's
/// one and only window, labeled "main" (matching `capabilities/default.json`'s
/// existing `"windows": ["main"]` scope — every process's own window reuses
/// this same label; labels are process-scoped, not global, so there's no
/// collision to worry about), pointed at whichever repo (if any) this
/// process was launched with.
pub fn create_initial_window(app: &AppHandle<Wry>) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, "main", window_url(initial_repo_arg().as_deref()))
        .title(WINDOW_TITLE)
        .inner_size(WINDOW_W, WINDOW_H)
        .min_inner_size(WINDOW_MIN_W, WINDOW_MIN_H)
        .center()
        .focused(true)
        .build()?;

    // A process launched by `spawn_new_window` below does NOT reliably become
    // the frontmost/key window on its own: it's a separate OS process spawned
    // by an already-active GitCat, and the OS (macOS especially) keeps the
    // PARENT app active, so the child's window appears but its webview never
    // receives keyboard focus. Every window-level keydown — the whole vim-nav
    // layer (j/k/gg/G, Enter-to-open-diff), plus ⌘K — is then dead in that
    // window until the user clicks into it (a click activates the window,
    // which is why the mouse "works" there but the keyboard doesn't). The
    // build-time `.focused(true)` hint isn't enough across a process boundary;
    // an explicit `set_focus()` after build activates THIS process's app and
    // makes its window key (tao's macOS impl issues activateIgnoringOtherApps
    // + makeKeyAndOrderFront), so the keyboard works immediately.
    //
    // Gated on the `GITCAT_SPAWNED` marker `spawn_new_window` sets, so this
    // ONLY force-activates windows we deliberately spawned: a normally-
    // launched PRIMARY window is already frontmost via the OS, and
    // force-activating it (activateIgnoringOtherApps is aggressive) would yank
    // focus back if the user happened to tab away during the app's launch.
    if std::env::var_os(SPAWNED_MARKER).is_some() {
        let _ = window.set_focus();
    }
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
    let mut cmd = Command::new(exe);
    if let Some(p) = repo_path {
        cmd.arg(p);
    }
    // Tells the child's `create_initial_window` to force-focus its window —
    // a spawned process doesn't become key on its own, leaving its keyboard
    // (vim-nav, ⌘K) dead until clicked. See create_initial_window's own note.
    cmd.env(SPAWNED_MARKER, "1");
    cmd.no_console_window();
    if let Err(e) = cmd.spawn() {
        eprintln!("failed to launch a new GitCat process: {e}");
    }
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
