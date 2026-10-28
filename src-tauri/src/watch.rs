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
//! whatever was previously watched (dropping the old RepoWatcher stops it),
//! unwatch_repo clears it. Both called from the frontend around the same
//! open/close points as Safety.refresh()/bootEmpty() — see legacy/main.ts.

use std::path::Path;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::event::EventKind;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, State, Wry};

const DEBOUNCE: Duration = Duration::from_millis(400);
/// A steady stream of changes (a long rebase) still reloads this often.
const DEBOUNCE_MAX: Duration = Duration::from_secs(2);

/// A live watch on one repository. Dropping it stops the watch: the watcher
/// goes, its event sender with it, and the debounce thread sees the channel
/// close and exits.
pub struct RepoWatcher {
    _watcher: RecommendedWatcher,
}

#[derive(Default)]
pub struct WatchState(Mutex<Option<RepoWatcher>>);

/// Whether an event can mean something changed. On Linux, notify (8.x) watches
/// IN_OPEN too, so merely READING `HEAD` or a ref is an event; with
/// notify-debouncer-mini, which drops the kind, that read looked exactly like a
/// change. GitCat's own refresh reads HEAD, so each refresh queued the next: a
/// repo open on Linux re-ran the (cheap) fast refresh every ~400 ms forever.
fn is_change(kind: &EventKind) -> bool {
    !matches!(kind, EventKind::Access(_))
}

/// Whether a change at `rel` — a path RELATIVE to the git dir or the common
/// dir — should reload the graph: `HEAD`, or anything under `refs/` except
/// GitCat's own namespaces.
///
/// GitCat's own refs (`refs/gitgui/…` safety snapshots, `refs/gitcat/…` the
/// 2.0 op log) are NOT shown in the graph and are written by the app itself —
/// notably the on-repo-open auto-prune (see pruneSnapshotsPerPolicy). Reacting
/// to them would pointlessly reload the graph, and during a large repo's
/// initial stream that RESTARTS the whole load.
///
/// Relative, not absolute: matching on any path component named `gitgui` or
/// `refs` meant a repo that merely LIVED under such a directory
/// (`~/src/gitgui/app`) never refreshed, and one under a `refs` directory
/// reloaded on every index write.
fn is_relevant(rel: &Path) -> bool {
    let rel = rel.to_string_lossy().replace('\\', "/");
    if rel == "HEAD" {
        return true;
    }
    // The namespace directory itself counts too: creating `refs/gitcat/` is an
    // event at `refs/gitcat`, with no trailing slash.
    let internal = crate::safety::INTERNAL_REF_PREFIXES.iter().any(|p| rel.starts_with(p) || rel == p.trim_end_matches('/'));
    rel.starts_with("refs/") && !internal
}

/// `path` relative to whichever of `roots` contains it.
fn relative_to<'a>(path: &'a Path, roots: &[std::path::PathBuf]) -> Option<&'a Path> {
    roots.iter().find_map(|r| path.strip_prefix(r).ok())
}

/// Core watcher setup, independent of any running Tauri app — `on_change` is
/// called (from the debounce thread) once per burst of relevant changes: after
/// [`DEBOUNCE`] of quiet, or every [`DEBOUNCE_MAX`] while they keep coming. Split out from the `watch_repo` command so it's directly
/// unit-testable (a `#[tauri::command]` needing a real `AppHandle`/`State`
/// isn't callable from a plain integration test the way this codebase's
/// other command functions are — see tests/watch.rs).
pub fn start_watching(path: &str, on_change: impl Fn() + Send + 'static) -> Result<RepoWatcher, String> {
    let repo = crate::trust::open_repo(path).map_err(|e| format!("cannot open repository: {}", e.message()))?;
    let git_dir = repo.path().to_path_buf();
    // A linked worktree's git dir (`.git/worktrees/<name>`) holds only its own
    // HEAD; the branches it shows live in the common dir's `refs/`.
    let common_dir = repo.commondir().to_path_buf();
    // Events may arrive with either spelling of a path (a canonicalized one on
    // macOS's /private/var, a \\?\-prefixed one on Windows), so match against
    // both forms of each root.
    let mut roots = vec![git_dir.clone(), common_dir.clone()];
    roots.extend([&git_dir, &common_dir].iter().filter_map(|p| std::fs::canonicalize(p).ok()));
    // Longest first, so a worktree's git dir (inside the common dir) wins.
    roots.sort_by_key(|r| std::cmp::Reverse(r.as_os_str().len()));
    roots.dedup();

    let (tx, rx) = mpsc::channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if is_change(&event.kind) && event.paths.iter().any(|p| relative_to(p, &roots).is_some_and(is_relevant)) {
            let _ = tx.send(());
        }
    })
    .map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        // recv() fails once the watcher (and with it the sender) is dropped.
        while rx.recv().is_ok() {
            let burst = Instant::now();
            loop {
                let left = DEBOUNCE_MAX.saturating_sub(burst.elapsed());
                match rx.recv_timeout(DEBOUNCE.min(left)) {
                    Ok(()) if !left.is_zero() => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    _ => break,
                }
            }
            on_change();
        }
    });

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
    watcher
        .watch(&git_dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    // refs/ always exists after `git init`, but don't fail watch_repo over a
    // missing/unusual layout — the git-dir root watch above still catches
    // checkouts/commits via HEAD either way.
    let _ = watcher.watch(&git_dir.join("refs"), RecursiveMode::Recursive);
    if common_dir != git_dir {
        let _ = watcher.watch(&common_dir.join("refs"), RecursiveMode::Recursive);
    }

    Ok(RepoWatcher { _watcher: watcher })
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
    let watcher = crate::blocking::run_blocking(move || {
        start_watching(&path, move || {
            log::info!("[watch] relevant git-dir change → emit repo-changed");
            crate::event_util::emit_on_main(&handle, "repo-changed", ());
        })
    })
    .await?;
    *state.0.lock().unwrap() = Some(watcher);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn unwatch_repo(state: State<WatchState>) {
    *state.0.lock().unwrap() = None;
}

#[cfg(test)]
mod is_relevant_tests {
    use super::is_relevant;
    use std::path::Path;

    #[test]
    fn head_and_branch_refs_are_relevant() {
        assert!(is_relevant(Path::new("HEAD")));
        assert!(is_relevant(Path::new("refs/heads/main")));
        assert!(is_relevant(Path::new("refs/remotes/origin/main")));
        assert!(is_relevant(Path::new("refs/tags/v1")));
        assert!(is_relevant(Path::new("refs\\heads\\main")), "Windows separators");
    }

    #[test]
    fn gitcat_refs_and_unrelated_paths_are_not() {
        // GitCat's own refs — must NOT trigger a reload (the on-open auto-prune
        // writes these; reacting restarts a big load).
        assert!(!is_relevant(Path::new("refs/gitgui/backup/2026-07-24T00-00")));
        assert!(!is_relevant(Path::new("refs/gitgui/HEAD")));
        assert!(!is_relevant(Path::new("refs/gitcat/oplog")));
        assert!(!is_relevant(Path::new("refs/gitcat/pending/abc")));
        assert!(!is_relevant(Path::new("refs/gitcat")), "creating the namespace directory");
        assert!(!is_relevant(Path::new("refs/gitgui")));
        assert!(is_relevant(Path::new("refs/gitcatalog/x")), "only the exact namespaces");
        // Neither do non-ref housekeeping files.
        assert!(!is_relevant(Path::new("index")));
        assert!(!is_relevant(Path::new("packed-refs")));
        assert!(!is_relevant(Path::new("COMMIT_EDITMSG")));
        assert!(!is_relevant(Path::new("logs/HEAD")), "a reflog append is not a HEAD move by itself");
    }

    #[test]
    fn paths_are_judged_relative_to_the_git_dir_not_absolutely() {
        use super::relative_to;
        // A repo living under directories named `gitgui` or `refs`.
        let roots = vec![std::path::PathBuf::from("/home/me/gitgui/app/.git")];
        let head = Path::new("/home/me/gitgui/app/.git/HEAD");
        assert!(relative_to(head, &roots).is_some_and(is_relevant), "the old any-component check ignored this repo");
        let roots = vec![std::path::PathBuf::from("/srv/refs/app/.git")];
        let index = Path::new("/srv/refs/app/.git/index");
        assert!(!relative_to(index, &roots).is_some_and(is_relevant), "the old check reloaded on every index write");
        assert!(relative_to(Path::new("/elsewhere/HEAD"), &roots).is_none());
    }
}

#[cfg(test)]
mod is_change_tests {
    use super::is_change;
    use notify::event::{AccessKind, AccessMode, CreateKind, EventKind, ModifyKind};

    #[test]
    fn reads_are_not_changes_and_writes_are() {
        assert!(!is_change(&EventKind::Access(AccessKind::Open(AccessMode::Read))));
        assert!(!is_change(&EventKind::Access(AccessKind::Close(AccessMode::Read))));
        assert!(is_change(&EventKind::Create(CreateKind::File)));
        assert!(is_change(&EventKind::Modify(ModifyKind::Any)));
        assert!(is_change(&EventKind::Any), "an unknown kind is treated as a change");
    }
}
