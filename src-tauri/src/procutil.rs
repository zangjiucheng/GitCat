//! Shared `std::process::Command` helper — suppresses the console window
//! Windows otherwise flashes open for every subprocess a GUI app spawns
//! (`git`, `wsl.exe`, `cmd`/`sh` for a bisect test-command, ...). GitCat has
//! no attached console of its own (it's a windowed GUI app), so without
//! this, Windows creates a brand-new one for each spawned child and tears
//! it down when the child exits — visible as a black window flashing open
//! and closing, worse the more subprocesses run in a short span (e.g. the
//! periodic auto-fetch timer, or a rebase replaying many commits each via
//! their own `git` invocation).
//!
//! A no-op on every other platform: this is a Windows-only annoyance (Unix
//! shells don't spawn a NEW terminal window per child process the way
//! Windows' console subsystem does).

use std::process::Command;

pub trait NoConsoleWindowExt {
    /// Suppress the console window this child would otherwise flash open on
    /// Windows. Does nothing on any other platform. Chain right after
    /// `Command::new(...)`, same as any other builder method.
    fn no_console_window(&mut self) -> &mut Self;
}

impl NoConsoleWindowExt for Command {
    #[cfg(windows)]
    fn no_console_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (0x08000000) — documented Win32 process creation
        // flag: https://learn.microsoft.com/windows/win32/procthread/process-creation-flags
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        self.creation_flags(CREATE_NO_WINDOW)
    }

    #[cfg(not(windows))]
    fn no_console_window(&mut self) -> &mut Self {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_console_window_is_chainable_and_still_runs_the_command() {
        // Not asserting anything Windows-specific here (this test runs on
        // whatever platform CI/the dev machine actually is) — just proving
        // the trait method chains cleanly and doesn't break a real spawn.
        let out = Command::new(if cfg!(windows) { "cmd" } else { "true" })
            .no_console_window()
            .args(if cfg!(windows) { vec!["/C", "exit 0"] } else { vec![] })
            .output()
            .expect("failed to spawn");
        assert!(out.status.success());
    }
}
