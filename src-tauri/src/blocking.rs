//! `#[tauri::command]` functions that are plain `fn` (not `async fn`) run
//! INLINE on Tauri's main thread — the same thread driving the window's
//! event loop, redraws, and every other command's IPC delivery (see Tauri's
//! own "Calling Rust from the Frontend" docs on synchronous vs. async
//! commands). A git2/subprocess call whose cost scales with repository size
//! (checkout, log, blame, rebase, ...) run that way freezes the ENTIRE app —
//! not just the row that triggered it — for as long as the call takes.
//!
//! [`run_blocking`] is the fix: every command whose body touches the repo
//! must be `async fn` and route its body through here, moving the actual
//! work onto Tauri's dedicated blocking-task thread pool so the main thread
//! stays free the whole time.

/// Runs `f` on Tauri's blocking-task thread pool and awaits its result —
/// the `async fn` wrapper this returns to is what keeps the calling command
/// off the main thread; `f` itself is free to call git2/`std::process`
/// exactly as it did when the command was a plain sync `fn`.
pub async fn run_blocking<T, F>(f: F) -> T
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.expect("blocking git task panicked")
}
