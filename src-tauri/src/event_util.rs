//! Emit a global Tauri event SAFELY from any thread.
//!
//! Calling [`tauri::Emitter::emit`] directly from a BACKGROUND thread holds
//! Tauri's webviews mutex while blocking on the main thread to run the delivery
//! JS (`Webview::eval`). If the main thread is concurrently handling an IPC call
//! that needs that same mutex (`AppManager::get_webview`), the two wait on each
//! other forever — a real UI freeze seen on this app (a `fetch` streaming
//! `sync-progress` while the file-watcher's `repo-changed` flood drove
//! main-thread IPC; caught by a live `sample` of the frozen process). The
//! `graph-batch` stream hit the same bug class first (commit f72549c).
//!
//! `menu.rs` emits `menu-action` from the MAIN thread and never deadlocks, which
//! proves emitting ON the main thread is safe — the blocking `eval` path only
//! happens for an OFF-main-thread emit. So this marshals the emit onto the main
//! thread via [`tauri::AppHandle::run_on_main_thread`]: the background caller
//! returns immediately holding NO lock, and the emit runs inline on the main
//! thread, taking and releasing the webviews mutex within one event-loop turn —
//! never across a thread hop, so it cannot deadlock. EVERY background-thread
//! event in this app goes through here — `sync-progress`,
//! `bisect-run-progress`, `repo-changed`, `terminal-output`/`terminal-exit`,
//! and `graph-batch` too.
//!
//! `graph-batch` was the exception until it wasn't, and this doc claimed
//! otherwise for a while: it was moved to an `ipc::Channel` first, because that
//! stream is the hottest one here, and then moved BACK, because a Channel is
//! bound to the webview that created it and so delivered nothing in a second
//! app INSTANCE — multi-window opens a whole separate process, and the new
//! window's graph just stayed blank. `commands.rs`'s own `stream_graph` comment
//! has always recorded that; this module's did not.
//!
//! What `graph-batch` does use, and nothing else here needs, is
//! [`emit_str_on_main`] — see its doc comment for which thread ends up paying
//! for `serde_json`.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Wry};

/// Emit `event` with `payload` to all listeners, always from the main thread
/// (see the module doc for why direct off-thread `emit` deadlocks). Fire and
/// forget: a failed marshal/emit is dropped, matching every call site's existing
/// `let _ = app.emit(...)`.
pub fn emit_on_main<S: Serialize + Clone + Send + 'static>(app: &AppHandle<Wry>, event: &'static str, payload: S) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = handle.emit(event, payload);
    });
}

/// Emit `event` with a payload the CALLER has already serialized, always from
/// the main thread.
///
/// Same deadlock-avoiding marshal as [`emit_on_main`]. The difference is which
/// thread pays for `serde_json`. [`emit_on_main`] hands Tauri the value itself,
/// and Tauri serializes it inside `EmitArgs::new` (`tauri::event::EmitArgs`,
/// `payload: serde_json::to_string(payload)?`) — which, because the emit has
/// already been marshalled by then, runs ON THE MAIN THREAD. This one takes the
/// JSON already built and goes through `Emitter::emit_str`, whose
/// `EmitArgs::new_str` just moves the `String` into place. Both paths end in the
/// same `EmitArgs.payload` field and the same `emit_js_script`, so the bytes the
/// webview receives are identical; only the thread that produced them differs.
///
/// Worth using only where serialization is big enough to notice — on a
/// widely-branched repo a full `graph-batch` is ~2 MB of JSON and ~2.8 ms to
/// build in a release build, and that is the STEADY state for such a repo, not
/// a rare peak (see `commands.rs`'s `MAX_GAP_SEGMENTS_PER_BATCH`). For a
/// `sync-progress` tick it would be noise.
///
/// `payload` must be the JSON of the payload OBJECT — exactly what
/// `serde_json::to_string(&value)` returns. Do NOT hand a `String` to
/// [`emit_on_main`] instead: that serializes the string AS a JSON string, and
/// the frontend gets a quoted blob where it expects an object. Both spellings
/// compile and only this one is right, which is the whole reason this function
/// exists rather than a comment at the call site.
pub fn emit_str_on_main(app: &AppHandle<Wry>, event: &'static str, payload: String) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = handle.emit_str(event, payload);
    });
}
