//! Command-line argument handling for the `gitcat` binary.
//!
//! GitCat is a GUI app, but it is also launched from a terminal (`gitcat .`,
//! see `cli_shim.rs`), so it has to behave like a command-line tool for the
//! handful of things people type at one: `--version`, `--help`, and a typo'd
//! flag. Those are answered here, from `main()`, BEFORE Tauri starts and before
//! `instance_focus` can forward the launch to an already-open window — the
//! process prints and exits without ever creating a window.
//!
//! Everything else is a launch: [`parse`] returns [`CliAction::Launch`] with the
//! repo path (if any) and the two flags GitCat passes to its own child
//! processes (`--new-window` and `--commit=<sha>`, see `windows.rs`). Anything
//! after a bare `--` is positional, so a directory whose name starts with `-`
//! can still be opened with `gitcat -- -weird` (or `gitcat ./-weird`).
//!
//! Windows: release builds are GUI-subsystem (`windows_subsystem = "windows"`
//! in `main.rs`), so the process starts with no stdout/stderr at all. Before
//! printing, [`attach_parent_console`] attaches to the terminal that launched
//! us, so `gitcat.exe --version` actually shows its output there.

/// What a `gitcat` invocation asked for.
#[derive(Debug, PartialEq, Eq)]
pub enum CliAction {
    /// `--version` / `-V`: print the version and exit 0.
    Version,
    /// `--help` / `-h`: print usage and exit 0.
    Help,
    /// An unknown option or a stray argument: print the message and usage to
    /// stderr and exit 2.
    Error(String),
    /// Start the app.
    Launch(LaunchArgs),
}

/// The parts of argv a normal launch uses.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct LaunchArgs {
    /// The repo/directory to open, verbatim as given (classified later by
    /// `windows::classify_initial_arg`).
    pub path: Option<String>,
    /// `--new-window`: skip the already-open-repo focus dedup (#39).
    pub new_window: bool,
    /// `--commit=<sha>`: open the window on this commit's diff.
    pub commit: Option<String>,
}

/// Classify argv (WITHOUT the program name). Pure, so it is unit-tested below.
pub fn parse<I: IntoIterator<Item = String>>(args: I) -> CliAction {
    let mut launch = LaunchArgs::default();
    let mut positional_only = false;
    for arg in args {
        if positional_only || !arg.starts_with('-') {
            // An empty argument (e.g. `gitcat ""`) has always meant "no repo".
            if arg.is_empty() {
                continue;
            }
            if launch.path.is_some() {
                return CliAction::Error(format!("unexpected extra argument '{arg}'"));
            }
            launch.path = Some(arg);
            continue;
        }
        match arg.as_str() {
            "--" => positional_only = true,
            "-V" | "--version" => return CliAction::Version,
            "-h" | "--help" => return CliAction::Help,
            "--new-window" => launch.new_window = true,
            // macOS LaunchServices on older systems appends a process serial
            // number (`-psn_0_12345`) to apps it launches; it is not ours to
            // reject.
            a if a.starts_with("-psn_") => {}
            a => match a.strip_prefix("--commit=") {
                Some(sha) if !sha.is_empty() => launch.commit = Some(sha.to_string()),
                _ => return CliAction::Error(format!("unknown option '{a}'")),
            },
        }
    }
    CliAction::Launch(launch)
}

/// The `--version` line.
pub fn version_text() -> String {
    format!("gitcat {}", crate::version::HOST_VERSION)
}

/// The `--help` text. Kept in step with what [`parse`] accepts, minus the two
/// internal flags GitCat passes to its own child processes (`--new-window`,
/// `--commit=`): the PATH launchers in `cli_shim.rs` run any leading option in
/// the foreground, so those aren't meant to be typed.
pub fn usage_text() -> String {
    format!(
        "GitCat {} - a cozy, safety-first desktop Git client\n\
\n\
Usage:\n\
\x20 gitcat              Open GitCat\n\
\x20 gitcat <path>       Open the repository at <path> (e.g. `gitcat .`)\n\
\x20 gitcat -- <path>    Open a path that starts with '-'\n\
\n\
Options:\n\
\x20 -h, --help          Print this help and exit\n\
\x20 -V, --version       Print the version and exit\n",
        crate::version::HOST_VERSION
    )
}

/// The process's own launch arguments. Only ever reached for a launch: `main`
/// has already handled (and exited on) every other [`CliAction`].
pub fn launch_args() -> LaunchArgs {
    match parse(std::env::args().skip(1)) {
        CliAction::Launch(l) => l,
        _ => LaunchArgs::default(),
    }
}

/// Called first thing in `main` (after the askpass check): answers
/// `--version` / `--help` / bad flags and exits; returns for a normal launch.
pub fn handle_non_launch_args() {
    use std::io::Write;
    let (code, text, to_stderr) = match parse(std::env::args().skip(1)) {
        CliAction::Launch(_) => return,
        CliAction::Version => (0, format!("{}\n", version_text()), false),
        CliAction::Help => (0, usage_text(), false),
        CliAction::Error(msg) => (2, format!("gitcat: {msg}\n\n{}", usage_text()), true),
    };
    attach_parent_console();
    if to_stderr {
        let mut e = std::io::stderr().lock();
        let _ = e.write_all(text.as_bytes());
        let _ = e.flush();
    } else {
        let mut o = std::io::stdout().lock();
        let _ = o.write_all(text.as_bytes());
        let _ = o.flush();
    }
    std::process::exit(code);
}

/// Give a GUI-subsystem process somewhere to print. No-op when stdout/stderr
/// already exist (a debug build is console-subsystem; output redirected to a
/// file or pipe, or relayed by WSL interop, arrives as inherited handles).
#[cfg(windows)]
fn attach_parent_console() {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Console::{
        AttachConsole, GetConsoleScreenBufferInfo, GetStdHandle, SetStdHandle, ATTACH_PARENT_PROCESS,
        CONSOLE_SCREEN_BUFFER_INFO, STD_ERROR_HANDLE, STD_HANDLE, STD_OUTPUT_HANDLE,
    };
    let missing = |which: STD_HANDLE| {
        // SAFETY: GetStdHandle has no preconditions.
        let h = unsafe { GetStdHandle(which) };
        h.is_null() || h == INVALID_HANDLE_VALUE
    };
    if !missing(STD_OUTPUT_HANDLE) && !missing(STD_ERROR_HANDLE) {
        return;
    }
    // SAFETY: plain Win32 call; failure (no parent console, e.g. launched from
    // Explorer) just leaves us with nowhere to print, which is fine.
    if unsafe { AttachConsole(ATTACH_PARENT_PROCESS) } == 0 {
        return;
    }
    // Fill any std handle the attach didn't populate with the console itself.
    // The opened handle is deliberately leaked: it must outlive the process's
    // last write, and the process exits right after.
    for which in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        if missing(which) {
            if let Ok(f) = std::fs::OpenOptions::new().read(true).write(true).open("CONOUT$") {
                use std::os::windows::io::IntoRawHandle;
                // SAFETY: a valid, owned console handle we never close.
                unsafe { SetStdHandle(which, f.into_raw_handle() as _) };
            }
        }
    }
    // An interactive cmd/PowerShell does not wait for a GUI-subsystem program,
    // so its next prompt may already be on screen with the cursor after it.
    // Start on a fresh line rather than appending to the prompt. (The `.cmd`
    // shim runs the exe in the foreground for flags, so there the shell waits
    // and the cursor is already at column 0.)
    let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
    // SAFETY: valid out-pointer to a zeroed struct of the right type.
    let ok = unsafe { GetConsoleScreenBufferInfo(GetStdHandle(STD_OUTPUT_HANDLE), &mut info) } != 0;
    if ok && info.dwCursorPosition.X != 0 {
        use std::io::Write;
        let _ = std::io::stdout().write_all(b"\n");
    }
}

#[cfg(not(windows))]
fn attach_parent_console() {}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(args: &[&str]) -> CliAction {
        parse(args.iter().map(|s| s.to_string()))
    }

    fn launch(path: Option<&str>, new_window: bool, commit: Option<&str>) -> CliAction {
        CliAction::Launch(LaunchArgs {
            path: path.map(str::to_string),
            new_window,
            commit: commit.map(str::to_string),
        })
    }

    #[test]
    fn version_and_help_flags() {
        assert_eq!(p(&["--version"]), CliAction::Version);
        assert_eq!(p(&["-V"]), CliAction::Version);
        assert_eq!(p(&["--help"]), CliAction::Help);
        assert_eq!(p(&["-h"]), CliAction::Help);
        // Wherever they appear, and first one wins.
        assert_eq!(p(&[".", "--version"]), CliAction::Version);
        assert_eq!(p(&["--help", "--version"]), CliAction::Help);
    }

    #[test]
    fn unknown_flags_are_errors_not_paths() {
        assert!(matches!(p(&["--verison"]), CliAction::Error(m) if m.contains("--verison")));
        assert!(matches!(p(&["-v"]), CliAction::Error(_)));
        assert!(matches!(p(&["-"]), CliAction::Error(_)));
        assert!(matches!(p(&[".", "--bogus"]), CliAction::Error(_)));
        // `--commit` needs a value.
        assert!(matches!(p(&["--commit="]), CliAction::Error(_)));
        assert!(matches!(p(&["--commit"]), CliAction::Error(_)));
    }

    #[test]
    fn plain_launches() {
        assert_eq!(p(&[]), launch(None, false, None));
        assert_eq!(p(&[""]), launch(None, false, None));
        assert_eq!(p(&["."]), launch(Some("."), false, None));
        assert_eq!(p(&[r"C:\src\repo"]), launch(Some(r"C:\src\repo"), false, None));
        assert_eq!(p(&["./-weird"]), launch(Some("./-weird"), false, None));
    }

    #[test]
    fn double_dash_makes_everything_positional() {
        assert_eq!(p(&["--", "-weird"]), launch(Some("-weird"), false, None));
        assert_eq!(p(&["--", "--version"]), launch(Some("--version"), false, None));
        assert_eq!(p(&["--new-window", "--", "-x"]), launch(Some("-x"), true, None));
        assert!(matches!(p(&["--", "a", "b"]), CliAction::Error(_)));
    }

    #[test]
    fn internal_launch_flags_in_any_order() {
        // The shapes windows::spawn_new_window produces.
        assert_eq!(p(&["/r", "--new-window"]), launch(Some("/r"), true, None));
        assert_eq!(
            p(&["/r", "--new-window", "--commit=abc"]),
            launch(Some("/r"), true, Some("abc"))
        );
        assert_eq!(
            p(&["--new-window", "--commit=abc", "--", "/r"]),
            launch(Some("/r"), true, Some("abc"))
        );
        // macOS process-serial-number arg is ignored.
        assert_eq!(p(&["-psn_0_12345"]), launch(None, false, None));
    }

    #[test]
    fn extra_positional_is_an_error() {
        assert!(matches!(p(&["a", "b"]), CliAction::Error(m) if m.contains("'b'")));
    }

    #[test]
    fn texts_name_the_version_and_every_flag() {
        assert_eq!(version_text(), format!("gitcat {}", env!("CARGO_PKG_VERSION")));
        let u = usage_text();
        for needle in ["gitcat <path>", "gitcat -- <path>", "--help", "--version", "-h", "-V"] {
            assert!(u.contains(needle), "usage is missing {needle}");
        }
    }
}
