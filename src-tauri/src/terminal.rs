//! Built-in terminal — a real PTY-backed shell session embedded in GitCat's
//! own UI (a bottom drawer, see `src/islands/terminal`), replacing the
//! earlier "Open Terminal" which just shelled out to the OS's own Terminal
//! app: a terminal that's actually part of the app (no window-switching, no
//! guessing which external terminal emulator is installed on Linux) is a
//! meaningfully better fit for a Tools-menu/⌘K action than launching a
//! separate GUI window ever was.
//!
//! One session per id, tracked in `TerminalRegistry` (Tauri-managed state,
//! `Mutex<HashMap<id, TerminalSession>>` — same "one Mutex-guarded map,
//! looked up by an opaque id" shape as `watch::WatchState`). Each
//! `terminal_spawn` starts a dedicated reader thread that streams the PTY's
//! raw output to the frontend over the `"terminal-output"` event until the
//! shell exits (then fires `"terminal-exit"` once) — no typed/generated
//! event helper exists in this codebase for backend-push events (see
//! `git_bisect.rs`'s own `"bisect-run-progress"` emit); the frontend
//! subscribes via the same raw `window.__TAURI__.event.listen` every other
//! listener here does (see `bisect.svelte.ts`'s own doc comment).
//!
//! Output is base64-encoded, not lossy-UTF8 text: a single `read()` chunk can
//! split a multi-byte UTF-8 sequence (or an ANSI escape sequence) right at
//! its boundary, and only a real terminal parser — xterm.js, on the frontend
//! — is built to reassemble a byte stream like that; encoding it as text on
//! this side would risk corrupting exactly the bytes that split across two
//! reads. Input travels the other direction as plain UTF-8 text instead:
//! xterm.js's own `onData` callback already hands back valid text (including
//! the escape sequences it generates for arrow/function keys), so there's
//! nothing to decode on this side.
//!
//! `open_pty_shell` is a pure, `AppHandle`/`State`-free function (same
//! testability split as this file's own old `open_terminal_inner`, and as
//! `git_bisect.rs`'s `run_bisect`/`try_run_bisect` wrappers around
//! `bisect_run_start`) — it's the only part of this file worth a real
//! spawn-a-shell-and-read-its-output test; `terminal_write`/
//! `terminal_resize`/`terminal_kill` are thin `State<TerminalRegistry>`
//! lookups with nothing more to unit-test than `watch.rs`'s equally thin
//! `State<WatchState>` commands already go without.

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State, Wry};

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct TerminalRegistry(Mutex<HashMap<String, TerminalSession>>);

impl TerminalRegistry {
    /// Called once, on app exit (`RunEvent::ExitRequested` in `lib.rs::run`)
    /// — without this, a shell left open in the drawer would otherwise
    /// become an orphaned background process once GitCat itself quits,
    /// since nothing else in this process tree would ever kill it.
    pub fn kill_all(&self) {
        for (_, mut session) in self.0.lock().unwrap().drain() {
            let _ = session.child.kill();
        }
    }
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
struct TerminalOutputEvent {
    id: String,
    /// Raw PTY bytes, base64-encoded — see this module's own doc comment.
    data: String,
}

#[derive(Clone, Serialize)]
struct TerminalExitEvent {
    id: String,
}

/// Spawns the user's own shell (`CommandBuilder::new_default_prog()` —
/// resolves `$SHELL`/the passwd-db entry on unix, the platform default on
/// Windows; see the vendored `portable-pty` `cmdbuilder.rs`'s own
/// `get_shell()`, not reimplemented here) with its cwd set to `path`.
/// `trust::open_repo` gates this exactly like every other command that
/// touches a repo path — a terminal is a much more powerful escape hatch
/// than any git operation this app performs, so it gets no exemption.
fn open_pty_shell(path: &str) -> Result<TerminalSession, String> {
    if let Err(e) = crate::trust::open_repo(path) {
        return Err(format!("Cannot open repository: {}", e.message()));
    }
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new_default_prog();
    cmd.cwd(path);
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // Dropping our own copy of the slave side is required on unix: as long
    // as ANY fd for the slave stays open in this process — even one nobody
    // reads or writes through — the kernel never delivers EOF to the
    // master's reader after the child exits, so the reader thread
    // `terminal_spawn` starts below would block on read() forever instead
    // of noticing the shell closed.
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    Ok(TerminalSession { master: pair.master, writer, child })
}

/// JS: `commands.terminalSpawn(path)`. Returns the new session's id, which
/// every other command below takes to address it.
#[tauri::command]
#[specta::specta]
pub fn terminal_spawn(app: AppHandle<Wry>, registry: State<TerminalRegistry>, path: String) -> Result<String, String> {
    let session = open_pty_shell(&path)?;
    let mut reader = session.master.try_clone_reader().map_err(|e| e.to_string())?;
    let id = format!("term-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));

    registry.0.lock().unwrap().insert(id.clone(), session);

    let app_for_thread = app.clone();
    let id_for_thread = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app_for_thread.emit("terminal-output", TerminalOutputEvent { id: id_for_thread.clone(), data });
                }
                Err(_) => break,
            }
        }
        let _ = app_for_thread.emit("terminal-exit", TerminalExitEvent { id: id_for_thread.clone() });
    });

    Ok(id)
}

/// JS: `commands.terminalWrite(id, data)` — `data` is plain UTF-8 text (see
/// this module's own doc comment for why only the OUTPUT direction is
/// base64). A session that's already gone (e.g. the shell exited on its own
/// right before this call landed) is reported as an error rather than
/// silently ignored, unlike `terminal_kill`'s own idempotent close, since a
/// keystroke that silently went nowhere is exactly the kind of "why isn't
/// anything happening" confusion this app just fixed for the diff/history
/// loading-indicator gap.
#[tauri::command]
#[specta::specta]
pub fn terminal_write(registry: State<TerminalRegistry>, id: String, data: String) -> Result<(), String> {
    let mut map = registry.0.lock().unwrap();
    let session = map.get_mut(&id).ok_or_else(|| "This terminal session has already ended.".to_string())?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

/// JS: `commands.terminalResize(id, cols, rows)` — called by the frontend's
/// `FitAddon` whenever the drawer's own size changes (mount, window resize,
/// drag-to-resize), so the shell's own idea of the terminal size (anything
/// that cares, e.g. `$COLUMNS`, a full-screen TUI like `less`/`vim`) tracks
/// what's actually visible.
#[tauri::command]
#[specta::specta]
pub fn terminal_resize(registry: State<TerminalRegistry>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = registry.0.lock().unwrap();
    let session = map.get(&id).ok_or_else(|| "This terminal session has already ended.".to_string())?;
    session.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

/// JS: `commands.terminalKill(id)` — ends the session and drops it from the
/// registry. Idempotent: a session that's already gone is a no-op success,
/// not an error, since "close a thing that's already closed" is a UI action
/// (the drawer's own × button), not a report of the session's own liveness.
#[tauri::command]
#[specta::specta]
pub fn terminal_kill(registry: State<TerminalRegistry>, id: String) -> Result<(), String> {
    if let Some(mut session) = registry.0.lock().unwrap().remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal real repo directory, just enough for `trust::open_repo`'s
    /// gate to accept it — NOT `tests/common::TempRepo` (that lives one
    /// level up in the separate integration-test crate, unreachable from a
    /// unit test compiled into the lib crate itself; also considerably more
    /// than this file needs, which is only ever "a path that IS a repo",
    /// never a commit/branch inside one). Auto-removed on drop.
    struct TempGitDir(std::path::PathBuf);

    impl TempGitDir {
        fn init() -> Self {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("gitcat-terminal-test-{}-{}", std::process::id(), nanos));
            std::fs::create_dir_all(&dir).expect("mkdir temp repo");
            let status = std::process::Command::new("git").arg("-C").arg(&dir).args(["init", "-q"]).status().expect("run git init");
            assert!(status.success(), "git init should succeed");
            TempGitDir(dir)
        }
        fn path(&self) -> String {
            self.0.to_string_lossy().to_string()
        }
    }

    impl Drop for TempGitDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // A real end-to-end round trip: spawn a real shell (whatever
    // `$SHELL`/the passwd-db resolves to on the machine actually running
    // `cargo test` — same "host-dependent but real" tradeoff this file's old
    // `terminal_candidates` tests explicitly avoided by never spawning
    // anything for real; here the whole point IS the spawn, so there's no
    // meaningful test without one), write a command, and read its echoed
    // output back out via a channel-bounded reader thread (never a bare
    // blocking `read()` on the test's own thread — the shell's startup time
    // is host-dependent, and a blocking read doesn't honor a deadline once
    // it's already inside the call).
    #[test]
    fn open_pty_shell_spawns_a_real_shell_and_round_trips_a_command() {
        let repo = TempGitDir::init();
        let mut session = open_pty_shell(&repo.path()).expect("should spawn a real shell");
        let mut reader = session.master.try_clone_reader().expect("should clone a reader");
        session.writer.write_all(b"echo hello_gitcat_terminal\n").expect("should write to the shell");

        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut collected = String::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        collected.push_str(&String::from_utf8_lossy(&buf[..n]));
                        if collected.contains("hello_gitcat_terminal") {
                            let _ = tx.send(collected.clone());
                            return;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = tx.send(collected);
        });

        let collected = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap_or_default();
        assert!(collected.contains("hello_gitcat_terminal"), "expected echoed output, got: {collected:?}");

        let _ = session.child.kill();
    }

    #[test]
    fn open_pty_shell_refuses_a_dubious_ownership_path_before_ever_touching_a_pty() {
        // Not `.unwrap_err()` — `TerminalSession`'s trait-object fields (a
        // `Box<dyn MasterPty>` in particular) don't implement `Debug`, which
        // `unwrap_err()` requires of the `Ok` type regardless of which
        // variant is actually present.
        match open_pty_shell("/no/such/path/at/all") {
            Err(e) => assert!(e.contains("Cannot open repository")),
            Ok(_) => panic!("expected a nonexistent path to be refused before spawning anything"),
        }
    }

    #[test]
    fn kill_all_empties_the_registry_and_terminates_every_session() {
        let registry = TerminalRegistry::default();
        let repo = TempGitDir::init();
        let session = open_pty_shell(&repo.path()).expect("should spawn a real shell");
        registry.0.lock().unwrap().insert("term-1".to_string(), session);

        registry.kill_all();

        assert!(registry.0.lock().unwrap().is_empty());
    }
}
