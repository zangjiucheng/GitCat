//! Live refresh: watch the open repo's git-dir for changes made OUTSIDE the
//! app (terminal commits, another tool, a background `git fetch`, a hook)
//! and tell the frontend to reload — previously GitCat only ever refreshed
//! itself after ITS OWN mutations, so anything done elsewhere left the graph
//! silently stale until the user manually reopened the repo.
//!
//! Watches the git-dir ROOT (non-recursive — see `start_watching`'s own
//! comment on why not just the `HEAD` file path) + `refs/` (recursive),
//! resolved via git2 (not a naive `<path>/.git` join) so this is correct even
//! when `.git` is a gitfile pointing elsewhere (worktrees/submodules).
//! Between the two, virtually every state-changing git operation touches at
//! least one: commit/checkout/merge/rebase/reset move a ref and/or HEAD;
//! branch/tag create-or-delete touches refs/heads or refs/tags.
//! `is_relevant` below still filters to just HEAD/refs events, so watching
//! the root doesn't widen what triggers a refresh — it only makes the HEAD
//! side of that filter more robust. Deliberately does NOT watch objects/ (can
//! hold many thousands of loose-object files in a large repo — recursively
//! watching it risks exhausting inotify's per-user watch-descriptor limit on
//! Linux) or the index (staged-but-uncommitted changes aren't shown by this
//! app's commit-graph view at all).
//!
//! GitCat's OWN mutations also touch HEAD/refs, so this fires after them
//! too — redundant with the explicit reloadGraph() call every mutation
//! already makes on success, but harmless: just one extra debounced refresh.
//!
//! One repo watched at a time, tracked in Tauri-managed state
//! (`app.manage(WatchState::default())` in lib.rs): watch_repo replaces
//! whatever was previously watched (the old Debouncer's Drop impl stops it),
//! unwatch_repo clears it. Both called from the frontend around the same
//! open/close points as Safety.refresh()/bootEmpty() — see legacy/main.ts.

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter, State, Wry};

const DEBOUNCE: Duration = Duration::from_millis(400);

#[derive(Default)]
pub struct WatchState(Mutex<Option<Debouncer<RecommendedWatcher>>>);

fn is_relevant(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n == "HEAD") || path.components().any(|c| c.as_os_str() == "refs")
}

/// Core watcher setup, independent of any running Tauri app — `on_change` is
/// called (from the debouncer's own background thread) whenever a relevant
/// path changes. Split out from the `watch_repo` command so it's directly
/// unit-testable (a `#[tauri::command]` needing a real `AppHandle`/`State`
/// isn't callable from a plain integration test the way this codebase's
/// other command functions are — see tests/watch.rs).
pub fn start_watching(path: &str, on_change: impl Fn() + Send + 'static) -> Result<Debouncer<RecommendedWatcher>, String> {
    let repo = crate::trust::open_repo(path).map_err(|e| format!("cannot open repository: {}", e.message()))?;
    let git_dir = repo.path().to_path_buf();

    let mut debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        if events.iter().any(|e| is_relevant(&e.path)) {
            on_change();
        }
    })
    .map_err(|e| e.to_string())?;

    // ADVERSARIALLY-FOUND FIX: watch the git-dir ROOT non-recursively rather
    // than the exact `HEAD` file path. Git updates HEAD via the same
    // lock-then-rename pattern it uses for refs — `notify`'s own docs warn
    // that a single-file watch isn't guaranteed to survive the watched path
    // being renamed/replaced (a well-documented inotify limitation on
    // Linux); watching the PARENT directory instead is exactly what those
    // docs recommend, and non-recursive here still only sees DIRECT children
    // (HEAD, index, COMMIT_EDITMSG, refs/ itself, …) — it does NOT descend
    // into objects/, preserving the same watch-descriptor-exhaustion
    // avoidance `is_relevant`'s filtering already relied on. Extra
    // non-matching events (e.g. `index`/`COMMIT_EDITMSG` touches) are
    // harmless: `is_relevant` below still only reacts to HEAD/refs.
    debouncer
        .watcher()
        .watch(&git_dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    // refs/ always exists after `git init`, but don't fail watch_repo over a
    // missing/unusual layout — the git-dir root watch above still catches
    // checkouts/commits via HEAD either way.
    let _ = debouncer.watcher().watch(&git_dir.join("refs"), RecursiveMode::Recursive);

    Ok(debouncer)
}

/// BUG FIX: was a plain (non-async) `fn` — `start_watching` calls
/// `trust::open_repo`, the same git2 `Repository::open` (and, on a
/// dubious-ownership WSL/UNC path, the same subprocess fallback) every other
/// read command's fix already had to account for, so arming the watcher on
/// repo-open could stall the whole window for as long as that open takes.
/// `async fn` + `run_blocking` moves just the `start_watching` call onto
/// Tauri's blocking-task thread pool; `state` is still updated on the main
/// thread afterward since a borrowed `State<'_, T>` can't be moved into the
/// `'static` closure `run_blocking` requires — mirrors `terminal_spawn`'s own
/// shape for a command that also needs `State` after the blocking part
/// completes.
#[tauri::command]
#[specta::specta]
pub async fn watch_repo(app: AppHandle<Wry>, state: State<'_, WatchState>, path: String) -> Result<(), String> {
    let handle = app.clone();
    let debouncer = crate::blocking::run_blocking(move || {
        start_watching(&path, move || {
            let _ = handle.emit("repo-changed", ());
        })
    })
    .await?;
    *state.0.lock().unwrap() = Some(debouncer);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn unwatch_repo(state: State<WatchState>) {
    *state.0.lock().unwrap() = None;
}
