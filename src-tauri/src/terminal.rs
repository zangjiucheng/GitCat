//! "Open Terminal" — launches the OS's own terminal application at a repo's
//! root, repo-global (not per-submodule), reachable from the Tools menu/⌘K
//! alongside every other simple, no-modal action (Apply Patch/Force Push —
//! see applypatch.svelte.ts/forcepush.svelte.ts). Replaces the old
//! submodule "run a command in every submodule" (`git submodule foreach`)
//! bulk-runner feature, which this app no longer has: dropping to a real
//! shell is a simpler, more familiar escape hatch than an in-app command
//! runner.
//!
//! No Safety-Manager snapshot: this only ever spawns an external GUI
//! application — it never touches the repo's refs/index/working tree
//! itself, same "nothing this action does is snapshot-shaped" reasoning
//! used throughout this codebase (e.g. `tool_settings.rs`'s `open_diff_tool`).
//!
//! `terminal_candidates` is a pure, `AppHandle`-free function (same
//! testability split as `tool_settings.rs`'s `open_diff_tool`/
//! `open_diff_tool_inner`) that takes the target OS as an explicit
//! parameter rather than branching on `cfg!(target_os = ..)` internally —
//! unlike `git_bisect.rs`'s `run_test_command`/`submodule.rs`'s (removed)
//! `run_foreach_command`, which only ever need ONE shell command shape and
//! so branch on the real compile-time target, this needs its *test suite*
//! to verify all three platforms' argument shapes from a single dev
//! machine, not just whichever OS happens to run `cargo test`.
//!
//! macOS and Windows each have exactly one obvious candidate (`open -a
//! Terminal <path>`; `cmd /C start cmd`, letting the spawned process's own
//! `current_dir` become the new console's cwd — `start` inherits it).
//! Linux has no OS-standard "the terminal app" the way macOS/Windows do, so
//! `open_terminal_inner` tries an ordered list of common terminal emulators
//! and returns success on the first one that actually spawns.

use std::process::Command;

/// One candidate external command to try, as (program, args) — CWD is set
/// separately by the caller via `Command::current_dir`, not baked into
/// `args`, since not every terminal emulator reliably accepts a positional
/// directory argument the way macOS's `open` does.
///
/// `os` is `std::env::consts::OS`'s own vocabulary ("macos" / "windows" /
/// anything else, treated as Linux/other-Unix) — passed explicitly (not
/// read via `cfg!` inside this function) so every branch is directly
/// unit-testable regardless of which platform actually runs `cargo test`.
fn terminal_candidates(os: &str, path: &str) -> Vec<(String, Vec<String>)> {
    match os {
        "macos" => vec![("open".to_string(), vec!["-a".to_string(), "Terminal".to_string(), path.to_string()])],
        "windows" => vec![("cmd".to_string(), vec!["/C".to_string(), "start".to_string(), "cmd".to_string()])],
        _ => vec![
            ("x-terminal-emulator".to_string(), vec![]),
            ("gnome-terminal".to_string(), vec![]),
            ("konsole".to_string(), vec![]),
            ("xterm".to_string(), vec![]),
        ],
    }
}

/// Tries each of `terminal_candidates(os, path)` in order, `.current_dir(path)`
/// on every one (macOS's `open` ignores it — the path argument already tells
/// it where to open — but setting it anyway is harmless), and returns as
/// soon as one successfully spawns. `Command::spawn()` is fire-and-forget
/// (matches `open_diff_tool_inner`'s own `.spawn()`, never `.status()`/
/// `.output()`): a terminal window is a long-lived process this command has
/// no reason to wait on.
fn open_terminal_inner(os: &str, path: &str) -> Result<(), String> {
    let candidates = terminal_candidates(os, path);
    let mut errors = Vec::with_capacity(candidates.len());
    for (program, args) in &candidates {
        match Command::new(program).args(args).current_dir(path).spawn() {
            Ok(_) => return Ok(()),
            Err(e) => errors.push(format!("{program}: {e}")),
        }
    }
    Err(format!("Could not open a terminal — tried: {}", errors.join("; ")))
}

/// JS: `commands.openTerminal(path)`.
#[tauri::command]
#[specta::specta]
pub fn open_terminal(path: String) -> Result<(), String> {
    if let Err(e) = crate::trust::open_repo(&path) {
        return Err(format!("Cannot open repository: {}", e.message()));
    }
    open_terminal_inner(std::env::consts::OS, &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_candidate_opens_terminal_app_at_the_given_path() {
        let candidates = terminal_candidates("macos", "/repo/a");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].0, "open");
        assert_eq!(candidates[0].1, vec!["-a", "Terminal", "/repo/a"]);
    }

    #[test]
    fn windows_candidate_starts_a_new_console_relying_on_current_dir_for_cwd() {
        let candidates = terminal_candidates("windows", "C:\\repo\\a");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].0, "cmd");
        assert_eq!(candidates[0].1, vec!["/C", "start", "cmd"]);
        // The path is deliberately NOT baked into the args here — see this
        // function's own doc comment for why CWD is set uniformly by the
        // caller instead.
        assert!(!candidates[0].1.iter().any(|a| a.contains("repo")));
    }

    #[test]
    fn linux_tries_an_ordered_fallback_list_of_common_terminal_emulators() {
        let candidates = terminal_candidates("linux", "/repo/a");
        let programs: Vec<&str> = candidates.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(programs, vec!["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]);
    }

    #[test]
    fn unknown_os_falls_back_to_the_same_linux_candidate_list() {
        let candidates = terminal_candidates("freebsd", "/repo/a");
        assert_eq!(candidates.len(), 4);
    }

    // `open_terminal_inner`'s actual spawn-loop is deliberately NOT unit
    // tested beyond `terminal_candidates` above: `Command::spawn()` only
    // confirms the OS could START a process, not that it did anything
    // useful — EMPIRICALLY CONFIRMED while writing this test suite, an
    // earlier version asserted "no real terminal emulator exists in this
    // test environment" and failed on a dev machine with XQuartz installed
    // (`xterm` exists and spawns successfully, then immediately dies from
    // "no X server", which `.spawn()` can't observe either way — it's
    // fire-and-forget). Whether any given candidate binary exists (and
    // whether it can actually open a window) is entirely host-dependent,
    // exactly like `tool_settings.rs`'s `open_diff_tool`/
    // `open_diff_tool_inner` never unit-tests its own real subprocess
    // launch either (see that function's own doc comment).
}
