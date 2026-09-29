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
use tauri::{AppHandle, Manager, State, Wry};

use crate::i18n_err::{ierr, ierrp};

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

/// What to run, and where, for a repo at `path` — the whole platform decision,
/// kept pure so it can be asserted without spawning anything (`get_argv`,
/// `get_cwd` and `is_default_prog` are all public on `CommandBuilder`). A
/// machine with no WSL installed can still check the WSL branch is built right,
/// which is the only part of this that a test here can reach.
///
/// The ordinary case is the user's own shell (`new_default_prog()` — resolves
/// `$SHELL`/the passwd-db entry on unix, the platform default on Windows; see
/// `portable-pty`'s own `get_shell()`, not reimplemented here) with its cwd set
/// to the repo.
///
/// A repo living inside a WSL distro is reached over a UNC share
/// (`\\wsl.localhost\<distro>\...`), and that case cannot go through the
/// ordinary branch for two independent reasons:
///
/// 1. cmd.exe — the Windows default, so what `new_default_prog()` resolves to —
///    refuses a UNC working directory outright. It prints "UNC paths are not
///    supported" and starts in `C:\Windows` instead, which is #42's own symptom
///    (measured directly: a process started with `\\localhost\C$\Temp` as its
///    working directory reports `CWD=C:\Windows`).
/// 2. Even if it could, a Windows shell sitting on a 9p mount is the wrong
///    tool. Its `git` is the Windows build reaching into the distro's
///    filesystem — exactly what `wsl::git_command` exists to avoid for every
///    other git call this app makes.
///
/// So a WSL repo gets the distro's own shell, already in the repo, via
/// `wsl.exe -d <distro> --cd <linux path>`: the same routing decision
/// `wsl::git_command` makes, one layer up. `--cd` is what sets the directory
/// INSIDE the distro; the outer process keeps whatever cwd it inherits, since
/// nothing Windows-side needs one.
///
/// The verbatim-prefix strip is belt and braces. #42's own fix means
/// `repo_registry::normalize` no longer stores that shape, but a path arriving
/// with it would silently reopen the same bug, and one `strip_prefix` is a lot
/// cheaper than trusting every caller upstream to have done it.
///
/// `shell` is the drawer's own explicit override (see `wsl::list_distros`'s
/// own doc comment for why it exists — a user with more than one WSL distro
/// installed can otherwise never get a shell in anything but whichever one a
/// repo's own path happens to resolve to):
///  - `None` — auto, exactly the behavior described above: a WSL-hosted repo
///    gets its own distro cd'd into the repo, anything else gets the native
///    shell.
///  - `Some("")` — force the native default shell EVEN for a WSL-hosted
///    repo (the picker's own "Default" entry).
///  - `Some(distro)` — force that WSL distro's shell. Only `--cd`s into the
///    repo's own path INSIDE the distro when `distro` is the SAME one the
///    repo is actually hosted in (case-insensitive, matching `wsl_target`'s
///    own host-matching) — a repo hosted in one distro has no meaningful
///    path inside a DIFFERENT one, so picking any other installed distro
///    (or picking a distro for a non-WSL repo) lands in that distro's own
///    home directory instead of guessing at a translation.
fn pty_command_for(path: &str, shell: Option<&str>) -> CommandBuilder {
    let path = crate::windows::strip_windows_verbatim_prefix(path.to_string());
    let wsl = crate::wsl::wsl_target(&path);

    if let Some(distro) = shell {
        if distro.is_empty() {
            let mut cmd = CommandBuilder::new_default_prog();
            cmd.cwd(&path);
            return cmd;
        }
        let mut cmd = CommandBuilder::new("wsl.exe");
        cmd.arg("-d");
        cmd.arg(distro);
        if let Some((repo_distro, linux_path)) = &wsl {
            if repo_distro.eq_ignore_ascii_case(distro) {
                cmd.arg("--cd");
                cmd.arg(linux_path);
            }
        }
        return cmd;
    }

    if let Some((distro, linux_path)) = wsl {
        let mut cmd = CommandBuilder::new("wsl.exe");
        cmd.arg("-d");
        cmd.arg(&distro);
        cmd.arg("--cd");
        cmd.arg(&linux_path);
        return cmd;
    }
    let mut cmd = CommandBuilder::new_default_prog();
    cmd.cwd(&path);
    cmd
}

/// Spawns a shell for the repo at `path` — see [`pty_command_for`] for which
/// shell, and where.
///
/// `trust::open_repo` gates this exactly like every other command that
/// touches a repo path — a terminal is a much more powerful escape hatch
/// than any git operation this app performs, so it gets no exemption.
///
/// `shell` — see [`pty_command_for`]'s own doc comment.
fn open_pty_shell(path: &str, shell: Option<&str>) -> Result<TerminalSession, String> {
    if let Err(e) = crate::trust::open_repo(path) {
        return Err(ierrp("err_misc.cannot_open_repo_cap", &[("detail", e.message())]));
    }
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let cmd = pty_command_for(path, shell);
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

/// JS: `commands.terminalSpawn(path, shell)`. Returns the new session's id,
/// which every other command below takes to address it. `shell` is the
/// drawer's own shell-picker choice — see [`pty_command_for`]'s own doc
/// comment for what `None`/`Some("")`/`Some(distro)` each mean.
///
/// BUG FIX: was a plain (non-async) `fn` — `open_pty_shell` calls
/// `trust::open_repo` before ever touching a PTY, the same git2 `Repository::
/// open` (and, on a dubious-ownership WSL/UNC path, the same subprocess
/// `safety::run_git` fallback) every other read command's fix already had to
/// account for, so opening the terminal drawer could stall the whole window
/// for as long as that open takes. `async fn` + `run_blocking` moves the
/// spawn itself onto Tauri's blocking-task thread pool, matching `watch_repo`'s
/// own established shape for a command that also needs `State` after the
/// blocking part completes.
#[tauri::command]
#[specta::specta]
pub async fn terminal_spawn(
    app: AppHandle<Wry>,
    registry: State<'_, TerminalRegistry>,
    path: String,
    shell: Option<String>,
) -> Result<String, String> {
    let session = crate::blocking::run_blocking(move || open_pty_shell(&path, shell.as_deref())).await?;
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
                    crate::event_util::emit_on_main(&app_for_thread, "terminal-output", TerminalOutputEvent { id: id_for_thread.clone(), data });
                }
                Err(_) => break,
            }
        }
        // The shell exited on its own (never via terminal_kill, the ONLY
        // other place that removes an entry) — without this, every session
        // that ends this way would sit in the registry forever: a dead
        // `Child`/`MasterPty` pair nothing else will ever clean up, for the
        // rest of the app's lifetime. Removing it here, right where EOF was
        // actually observed, means terminal_write/terminal_resize against
        // this id correctly start reporting "session ended" immediately
        // afterward too, instead of finding a stale entry that looks alive.
        if let Some(registry) = app_for_thread.try_state::<TerminalRegistry>() {
            registry.0.lock().unwrap().remove(&id_for_thread);
        }
        crate::event_util::emit_on_main(&app_for_thread, "terminal-exit", TerminalExitEvent { id: id_for_thread.clone() });
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
    let session = map.get_mut(&id).ok_or_else(|| ierr("err_misc.terminal_session_ended"))?;
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
    let session = map.get(&id).ok_or_else(|| ierr("err_misc.terminal_session_ended"))?;
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

/// JS: `commands.listWslDistros()` — every registered WSL distro's name, for
/// the terminal drawer's own shell picker. See [`crate::wsl::list_distros`]'s
/// own doc comment for why an empty list is the normal, non-error answer on
/// a machine with no WSL install at all.
#[tauri::command]
#[specta::specta]
pub async fn list_wsl_distros() -> Vec<String> {
    crate::blocking::run_blocking(crate::wsl::list_distros).await
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
        let mut session = open_pty_shell(&repo.path(), None).expect("should spawn a real shell");
        let mut reader = session.master.try_clone_reader().expect("should clone a reader");

        // Play enough of a terminal for the shell to start talking.
        //
        // ConPTY opens by asking the terminal where its cursor is — a Device
        // Status Report, `ESC[6n` — and BLOCKS until something answers. In the
        // app xterm.js answers automatically, which is why the drawer works;
        // this test IS the terminal, and answering is not optional. Measured:
        // without the reply the master side yields exactly those four bytes
        // and nothing else — not even cmd.exe's banner — however long you
        // wait. With it, ~290 bytes arrive at once: banner, prompt, echo, all.
        //
        // Windows-only on purpose. No unix pty asks this, and there the escape
        // would not be consumed by anything — it would land in the line buffer
        // and end up prefixed to the command, which happens to still satisfy
        // the assertion below (via the shell's "not found" message quoting it)
        // while testing nothing at all.
        #[cfg(windows)]
        session.writer.write_all(b"\x1b[1;1R").expect("should answer the cursor-position query");
        // CRLF, not LF: cmd.exe submits a line on CR. A unix pty translates CR
        // to NL on input (ICRNL), so this reads the same on both.
        session.writer.write_all(b"echo hello_gitcat_terminal\r\n").expect("should write to the shell");
        session.writer.flush().expect("should flush");

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
        match open_pty_shell("/no/such/path/at/all", None) {
            Err(e) => assert!(e.contains("err_misc.cannot_open_repo_cap")),
            Ok(_) => panic!("expected a nonexistent path to be refused before spawning anything"),
        }
    }

    // #42. These assert the command that WOULD be spawned, not a spawn: the WSL
    // branch cannot be executed on a machine without a distro installed, and the
    // part that was wrong was which command got built, not how it ran.
    fn argv(cmd: &CommandBuilder) -> Vec<String> {
        cmd.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn an_ordinary_repo_gets_the_default_shell_cwd_to_the_repo() {
        let cmd = pty_command_for("/home/me/proj", None);
        assert!(cmd.is_default_prog(), "an ordinary path must use the user's own shell");
        assert_eq!(cmd.get_cwd().map(|c| c.to_string_lossy().into_owned()), Some("/home/me/proj".to_string()));
    }

    // The reported bug: cmd.exe rejects a verbatim path as a working directory
    // and starts in C:\Windows. repo_registry no longer stores that shape, but
    // this must not depend on that.
    #[test]
    fn a_verbatim_windows_path_is_reduced_before_it_becomes_a_cwd() {
        let cmd = pty_command_for(r"\\?\C:\Users\me\proj", None);
        assert!(cmd.is_default_prog());
        assert_eq!(
            cmd.get_cwd().map(|c| c.to_string_lossy().into_owned()),
            Some(r"C:\Users\me\proj".to_string()),
            "a \\\\?\\ cwd is exactly what cmd.exe refuses"
        );
    }

    // A WSL repo is a UNC share, which cmd.exe refuses just as flatly — and a
    // Windows shell would be the wrong shell for it anyway.
    #[test]
    fn a_wsl_repo_gets_the_distros_own_shell_at_the_repo() {
        let cmd = pty_command_for(r"\\wsl.localhost\Ubuntu\home\me\proj", None);
        assert!(!cmd.is_default_prog(), "a WSL repo must not fall through to the Windows default shell");
        assert_eq!(argv(&cmd), vec!["wsl.exe", "-d", "Ubuntu", "--cd", "/home/me/proj"]);
        assert!(cmd.get_cwd().is_none(), "--cd sets the directory inside the distro; the outer process needs no cwd");
    }

    // The same repo as stored by a build that predates the repo_registry fix.
    #[test]
    fn a_wsl_repo_in_verbatim_unc_form_routes_the_same_way() {
        let cmd = pty_command_for(r"\\?\UNC\wsl.localhost\Debian\srv\app", None);
        assert_eq!(argv(&cmd), vec!["wsl.exe", "-d", "Debian", "--cd", "/srv/app"]);
    }

    // A real network share is NOT WSL: routing it through wsl.exe would be
    // nonsense, so it stays on the ordinary branch. cmd.exe still cannot take a
    // UNC cwd there — that is a separate gap, deliberately not papered over here.
    #[test]
    fn a_plain_network_share_is_not_treated_as_wsl() {
        let cmd = pty_command_for(r"\\server\share\repo", None);
        assert!(cmd.is_default_prog());
    }

    // -- explicit shell picker (`shell: Some(...)`) --------------------------

    #[test]
    fn an_empty_shell_override_forces_native_even_on_a_wsl_repo() {
        let cmd = pty_command_for(r"\\wsl.localhost\Ubuntu\home\me\proj", Some(""));
        assert!(cmd.is_default_prog(), "Some(\"\") is the picker's own \"Default\" choice");
        assert_eq!(cmd.get_cwd().map(|c| c.to_string_lossy().into_owned()), Some(r"\\wsl.localhost\Ubuntu\home\me\proj".to_string()));
    }

    #[test]
    fn a_shell_override_matching_the_repos_own_distro_still_cds_into_it() {
        let cmd = pty_command_for(r"\\wsl.localhost\Ubuntu\home\me\proj", Some("Ubuntu"));
        assert_eq!(argv(&cmd), vec!["wsl.exe", "-d", "Ubuntu", "--cd", "/home/me/proj"]);
    }

    // Case-insensitive to match wsl_target's own UNC host matching (Windows
    // paths, and the picker's own values, both trace back to the same
    // `wsl -l -q` listing either way).
    #[test]
    fn a_shell_override_matches_the_repos_distro_case_insensitively() {
        let cmd = pty_command_for(r"\\wsl.localhost\Ubuntu\home\me\proj", Some("UBUNTU"));
        assert_eq!(argv(&cmd), vec!["wsl.exe", "-d", "UBUNTU", "--cd", "/home/me/proj"]);
    }

    #[test]
    fn a_shell_override_for_a_different_distro_than_the_repos_own_lands_in_its_home_dir() {
        // The repo lives in Ubuntu; picking Debian instead has no meaningful
        // path to cd into there, so this must NOT guess at a translation.
        let cmd = pty_command_for(r"\\wsl.localhost\Ubuntu\home\me\proj", Some("Debian"));
        assert_eq!(argv(&cmd), vec!["wsl.exe", "-d", "Debian"]);
    }

    #[test]
    fn a_shell_override_for_a_non_wsl_repo_lands_in_the_distros_home_dir() {
        let cmd = pty_command_for(r"C:\Users\me\proj", Some("Ubuntu"));
        assert_eq!(argv(&cmd), vec!["wsl.exe", "-d", "Ubuntu"]);
    }

    #[test]
    fn kill_all_empties_the_registry_and_terminates_every_session() {
        let registry = TerminalRegistry::default();
        let repo = TempGitDir::init();
        let session = open_pty_shell(&repo.path(), None).expect("should spawn a real shell");
        registry.0.lock().unwrap().insert("term-1".to_string(), session);

        registry.kill_all();

        assert!(registry.0.lock().unwrap().is_empty());
    }
}
