//! "Install the `gitcat` command in PATH" — a VS Code `code`-style launcher,
//! installed on demand from ⌘K / Settings, so `gitcat <folder>` works from any
//! terminal without hunting for the binary inside the installed app.
//!
//! All three desktop platforms are supported, each with its own idiom:
//!
//!   - **macOS**: writes a launcher to `/usr/local/bin/gitcat` (on the default
//!     PATH — see `/etc/paths`). The launcher opens the app through
//!     LaunchServices (`open -n -a`) rather than exec'ing the Mach-O directly:
//!     `open` returns immediately so the terminal isn't blocked for the app's
//!     whole lifetime, and LaunchServices activates the window so its keyboard
//!     layer works from the first keystroke (a direct exec leaves it unfocused
//!     until clicked — see `windows.rs`'s own long comment on the same trap).
//!     Because `open` starts the app with a different working directory, the
//!     launcher resolves a relative path against the caller's CWD first, so
//!     `gitcat .` still works. Falls back to a single osascript admin prompt
//!     when `/usr/local/bin` isn't user-writable (a non-Homebrew Mac).
//!
//!   - **Linux**: writes a launcher to `~/.local/bin/gitcat` (user-owned, no
//!     root needed, conventionally on PATH). It backgrounds the app with
//!     `nohup … &` so the terminal returns right away; the app inherits the
//!     shell's working directory, so a relative path resolves without any extra
//!     work. For an AppImage it targets `$APPIMAGE` (the stable outer path),
//!     not `current_exe()` (which points into the ephemeral mount).
//!
//!   - **Windows**: writes a `gitcat.cmd` shim to
//!     `%LOCALAPPDATA%\Microsoft\WindowsApps` (user-writable and on PATH by
//!     default). It uses `start "" /D "%CD%"` so the terminal isn't blocked and
//!     the new process is pinned to the caller's directory for relative paths.
//!     It ALSO best-effort installs a Linux launcher into every detected WSL
//!     distro (`~/.local/bin/gitcat`), so `gitcat .` works from a WSL shell too
//!     — the `.cmd` shim can't run there (WSL interop only executes PE binaries,
//!     not batch files). That launcher converts the repo path with `wslpath -w`
//!     and hands the resulting `\\wsl.localhost\<distro>\...` path to the Windows
//!     app, which already routes a WSL repo through `wsl.exe` (see `wsl.rs`).
//!     WSL being absent, or a single distro failing, is not an error — the
//!     Windows `.cmd` is the primary result and is what the reported path names.
//!
//! The script-building is kept in pure functions (compiled and unit-tested on
//! every platform via `cfg(any(target_os = …, test))`), so the fiddly launcher
//! text is verified even where that platform's `install()` glue can't compile.

/// JS: `commands.installCliShim()` — the ⌘K "Install 'gitcat' command" action
/// and the Settings ▸ Command line button. Returns the installed path on
/// success, or a human-readable error to surface as a Tama toast / inline note.
#[tauri::command]
#[specta::specta]
pub fn install_cli_shim() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        return macos_install();
    }
    #[cfg(target_os = "linux")]
    {
        return linux_install();
    }
    #[cfg(target_os = "windows")]
    {
        return windows_install();
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        return Err("Installing the gitcat command from the app isn't supported on this platform yet.".to_string());
    }
}

// ── Pure launcher builders (compiled + unit-tested on every platform) ────────

/// POSIX single-quote a string so it's safe to bake into an `sh` script no
/// matter what it contains: wrap in single quotes, and turn each embedded
/// single quote into the `'\''` idiom (close quote, escaped quote, reopen).
/// Single quotes disable every shell metacharacter ($, `, \, "...), so an
/// install path with any of them can't break or hijack the launcher.
#[cfg(any(unix, target_os = "windows", test))]
fn sh_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// macOS launcher body. `bundle` is the absolute path to the `.app`, baked in at
/// install time so it keeps working even when GitCat isn't in `/Applications`.
#[cfg(any(target_os = "macos", test))]
fn macos_launcher(bundle: &str) -> String {
    let bundle = sh_single_quote(bundle);
    format!(
        r#"#!/bin/sh
# GitCat command-line launcher. Installed by GitCat (Settings > Command line, or
# the "Install 'gitcat' command" action). Re-run that to point it at a moved or
# updated app.
#
# Opens GitCat through LaunchServices so the terminal returns right away and the
# new window takes keyboard focus. A relative path is resolved against the
# current directory first, because `open` starts the app from a different one.
BUNDLE={bundle}
if [ $# -eq 0 ]; then
  exec open -n -a "$BUNDLE"
fi
target="$1"
case "$target" in
  -*) exec open -n -a "$BUNDLE" ;;
  /*) ;;
  *) resolved=$(cd "$target" 2>/dev/null && pwd); [ -n "$resolved" ] && target="$resolved" ;;
esac
exec open -n -a "$BUNDLE" --args "$target"
"#
    )
}

/// Linux launcher body. `bin` is the absolute path to the binary (or the
/// AppImage). Backgrounds it so the terminal returns; the app inherits this
/// shell's working directory, so `gitcat .` resolves without extra work.
#[cfg(any(target_os = "linux", test))]
fn unix_launcher(bin: &str) -> String {
    let bin = sh_single_quote(bin);
    format!(
        r#"#!/bin/sh
# GitCat command-line launcher. Installed by GitCat (Settings > Command line, or
# the "Install 'gitcat' command" action). Re-run that after moving or updating
# the app.
#
# Runs GitCat in the background so this terminal returns right away. The app
# inherits this shell's working directory, so a relative path (gitcat .)
# resolves against where you ran it.
nohup {bin} "$@" >/dev/null 2>&1 &
"#
    )
}

/// Windows `gitcat.cmd` shim. `exe` is the absolute path to `gitcat.exe`. CRLF
/// line endings for a batch file. A Windows filename can't contain `"`, `<`,
/// `>`, or `|`, so quoting covers everything except `%`, which batch expands —
/// double it to keep a path like `C:\100%\gitcat.exe` literal.
#[cfg(any(target_os = "windows", test))]
fn windows_cmd_shim(exe: &str) -> String {
    let exe = exe.replace('%', "%%");
    format!(
        "@echo off\r\n\
rem GitCat command-line launcher. Installed by GitCat (Settings > Command line,\r\n\
rem or the \"Install 'gitcat' command\" action). Re-run that after moving or\r\n\
rem updating the app.\r\n\
rem\r\n\
rem `start` returns immediately so this terminal isn't blocked; /D pins the new\r\n\
rem process to the current directory so a relative path (gitcat .) resolves here.\r\n\
start \"\" /D \"%CD%\" \"{exe}\" %*\r\n"
    )
}

/// The Linux `gitcat` launcher installed *inside* a WSL distro (at
/// `~/.local/bin/gitcat`), so `gitcat .` works from a WSL shell too. The Windows
/// `.cmd` shim can't be run from inside WSL — interop only executes PE binaries,
/// not batch files — so a WSL user needs a native launcher that reaches back out
/// to the Windows app.
///
/// `win_exe` is gitcat.exe's Windows path (`C:\…\gitcat.exe`), baked in and
/// translated to the distro's own mount point with `wslpath -u` at RUN time (so
/// it survives a distro with a non-default `/mnt` root). A directory argument is
/// resolved to an absolute path and converted to the Windows-side form with
/// `wslpath -w`: a repo on the distro's own filesystem becomes
/// `\\wsl.localhost\<distro>\…` (which the app routes through `wsl.exe`, see
/// `wsl.rs`), and a repo under `/mnt/c/…` becomes a plain `C:\…`. Backgrounded
/// with `nohup … &` so the WSL terminal returns immediately, matching the native
/// Linux launcher.
#[cfg(any(target_os = "windows", test))]
fn wsl_launcher(win_exe: &str) -> String {
    let win_exe = sh_single_quote(win_exe);
    format!(
        r#"#!/bin/sh
# GitCat command-line launcher for WSL. Installed by GitCat on Windows (Settings
# > Command line, or the "Install 'gitcat' command" action) into each detected
# WSL distro. Re-run that after moving or updating the app.
#
# Launches the Windows GitCat via interop, converting the repo path to the
# Windows-side form the app understands. nohup + & so this terminal returns
# right away.
exe=$(wslpath -u {win_exe})
if [ $# -eq 0 ]; then
  nohup "$exe" >/dev/null 2>&1 &
  exit 0
fi
target="$1"
case "$target" in
  -*) nohup "$exe" "$target" >/dev/null 2>&1 &
      exit 0 ;;
  *) resolved=$(cd "$target" 2>/dev/null && pwd); [ -n "$resolved" ] && target="$resolved" ;;
esac
win=$(wslpath -w "$target" 2>/dev/null) || win="$target"
nohup "$exe" "$win" >/dev/null 2>&1 &
"#
    )
}

/// Parse the distro names out of `wsl.exe -l -q`'s output.
///
/// That command emits UTF-16LE (a long-standing `wsl.exe` quirk), so decode that
/// when the bytes look like it — ASCII names show up as interleaved NUL bytes —
/// and otherwise fall back to UTF-8 so a future UTF-8 `wsl.exe` still parses. One
/// distro name per line; a leading BOM, stray NULs and surrounding whitespace are
/// trimmed. `docker-desktop`/`docker-desktop-data` are Docker's service distros,
/// not user environments, so they're dropped (VS Code skips them too). Pure, so
/// it's unit-tested on every platform.
#[cfg(any(target_os = "windows", test))]
fn parse_wsl_list(raw: &[u8]) -> Vec<String> {
    let odd_zeros = raw.iter().skip(1).step_by(2).filter(|&&b| b == 0).count();
    let looks_utf16 = raw.len() >= 4 && odd_zeros * 4 >= raw.len();
    let text = if looks_utf16 {
        let u16s: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&u16s)
    } else {
        String::from_utf8_lossy(raw).into_owned()
    };
    text.lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}' || c == '\0'))
        .filter(|l| !l.is_empty())
        .filter(|l| {
            let lc = l.to_ascii_lowercase();
            lc != "docker-desktop" && lc != "docker-desktop-data"
        })
        .map(|l| l.to_string())
        .collect()
}

// ── Per-platform install glue ────────────────────────────────────────────────

/// Write an executable text file (create parents, chmod 755). macOS + Linux.
#[cfg(unix)]
fn write_exec_unix(target: &std::path::Path, body: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut f = std::fs::File::create(target)?;
    f.write_all(body.as_bytes())?;
    f.flush()?;
    std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o755))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_install() -> Result<String, String> {
    const TARGET: &str = "/usr/local/bin/gitcat";
    let exe = std::env::current_exe()
        .map_err(|e| format!("Couldn't find GitCat's own program file: {e}"))?;
    // Follow any symlink to the real binary; also confirms it exists.
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    let bundle = crate::windows::macos_app_bundle(&exe).ok_or_else(|| {
        "This only works from an installed GitCat.app. It looks like you're running an unbundled build (for example `cargo tauri dev`).".to_string()
    })?;
    let bundle = bundle
        .to_str()
        .ok_or_else(|| "GitCat's install path isn't valid UTF-8.".to_string())?;

    let script = macos_launcher(bundle);
    let target = std::path::PathBuf::from(TARGET);
    match write_exec_unix(&target, &script) {
        Ok(()) => Ok(TARGET.to_string()),
        // /usr/local/bin is root-owned on a non-Homebrew Mac — fall back to a
        // single native admin prompt rather than failing.
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            macos_admin_install(&script).map(|()| TARGET.to_string())
        }
        Err(e) => Err(format!("Couldn't write {TARGET}: {e}")),
    }
}

/// Fallback when `/usr/local/bin` isn't writable by the current user: stage the
/// script in a temp file and copy it into place with a single osascript admin
/// prompt (the native "GitCat wants to make changes" password dialog).
#[cfg(target_os = "macos")]
fn macos_admin_install(script: &str) -> Result<(), String> {
    const TARGET: &str = "/usr/local/bin/gitcat";
    let staged = std::env::temp_dir().join("gitcat-cli-launcher");
    write_exec_unix(&staged, script).map_err(|e| format!("Couldn't stage the launcher: {e}"))?;
    let staged = staged
        .to_str()
        .ok_or_else(|| "Temp path isn't valid UTF-8.".to_string())?;
    // Single-quote every path (via the same helper the launchers use) so the
    // elevated shell treats them literally, whatever $TMPDIR expands to.
    let staged_q = sh_single_quote(staged);
    let target_q = sh_single_quote(TARGET);
    let shell =
        format!("mkdir -p /usr/local/bin && cp {staged_q} {target_q} && chmod 755 {target_q}");
    // Wrap in an AppleScript string literal (escape backslashes then quotes).
    let apple = format!(
        "do shell script \"{}\" with administrator privileges",
        shell.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&apple)
        .output()
        .map_err(|e| format!("Couldn't run the admin helper (osascript): {e}"));
    let _ = std::fs::remove_file(staged);
    let out = out?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        // Clicking Cancel on the password dialog is AppleScript error -128.
        if err.contains("-128") || err.contains("User canceled") {
            Err("Installation was cancelled.".to_string())
        } else {
            Err(format!(
                "Couldn't install with administrator privileges: {}",
                err.trim()
            ))
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_install() -> Result<String, String> {
    // An AppImage exposes its own outer path via $APPIMAGE; current_exe() points
    // into the ephemeral mount there, so it must NOT be baked in. A .deb/.rpm or
    // raw binary has a stable current_exe().
    let bin = match std::env::var("APPIMAGE") {
        Ok(p) if !p.is_empty() => p,
        _ => {
            let exe = std::env::current_exe()
                .map_err(|e| format!("Couldn't find GitCat's own program file: {e}"))?;
            let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
            exe.to_str()
                .ok_or_else(|| "GitCat's install path isn't valid UTF-8.".to_string())?
                .to_string()
        }
    };

    let home = std::env::var("HOME")
        .map_err(|_| "Couldn't find your home directory ($HOME).".to_string())?;
    let target = std::path::PathBuf::from(home).join(".local/bin/gitcat");
    let script = unix_launcher(&bin);
    write_exec_unix(&target, &script)
        .map_err(|e| format!("Couldn't write {}: {e}", target.display()))?;
    Ok(target.display().to_string())
}

#[cfg(target_os = "windows")]
fn windows_install() -> Result<String, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Couldn't find GitCat's own program file: {e}"))?;
    // Don't canonicalize on Windows — it returns a `\\?\` verbatim path that
    // `start` mishandles. current_exe() is already absolute.
    let exe = exe
        .to_str()
        .ok_or_else(|| "GitCat's install path isn't valid UTF-8.".to_string())?;

    // %LOCALAPPDATA%\Microsoft\WindowsApps is user-writable and on PATH by
    // default on Windows 10/11 (it's where App execution aliases live), so a
    // shim there is reachable from a fresh terminal with no PATH edit.
    let local = std::env::var("LOCALAPPDATA")
        .map_err(|_| "Couldn't find %LOCALAPPDATA%.".to_string())?;
    let dir = std::path::PathBuf::from(local)
        .join("Microsoft")
        .join("WindowsApps");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    let target = dir.join("gitcat.cmd");
    std::fs::write(&target, windows_cmd_shim(exe))
        .map_err(|e| format!("Couldn't write {}: {e}", target.display()))?;

    // Best-effort: also install a Linux launcher into each detected WSL distro so
    // `gitcat .` works from a WSL shell. WSL being absent, or a distro failing,
    // must NOT fail the whole install — the `.cmd` above is the primary result
    // and is what the returned path names. Outcomes are logged, not surfaced.
    install_wsl_launchers(exe);

    Ok(target.display().to_string())
}

/// Install the WSL launcher (see [`wsl_launcher`]) into every detected distro's
/// `~/.local/bin/gitcat`. Entirely best-effort: no WSL, no distros, a timeout, or
/// a per-distro failure all just log and move on — the caller has already written
/// the Windows `.cmd` shim, which is the primary result.
///
/// The launcher is staged once in a Windows temp file; each distro then reads it
/// through its own `wslpath -u` translation and copies it into place. Going
/// through a file (rather than piping the script on stdin) lets EVERY `wsl.exe`
/// call here run under [`output_with_timeout`] — `wsl.exe` interop has been
/// observed hanging forever for real users (see that helper's own doc), and an
/// unbounded call would strand the install with the spinner up. `~/.local/bin` is
/// on PATH by default on Debian/Ubuntu (their `~/.profile` adds it when the
/// directory exists), so a fresh WSL shell finds it, matching the native Linux
/// install.
#[cfg(target_os = "windows")]
fn install_wsl_launchers(win_exe: &str) {
    use crate::procutil::{output_with_timeout, NoConsoleWindowExt};
    use std::time::Duration;

    // `wsl.exe -l -q` lists installed distros. Missing wsl.exe (the feature isn't
    // installed), a non-zero exit (no distros), or a timeout => nothing to do.
    // Generous ceiling: the WSL service can be cold on first use.
    let mut list_cmd = std::process::Command::new("wsl.exe");
    list_cmd.args(["-l", "-q"]).no_console_window();
    let distros = match output_with_timeout(list_cmd, Duration::from_secs(15)) {
        Ok(out) if out.status.success() => parse_wsl_list(&out.stdout),
        _ => return,
    };
    if distros.is_empty() {
        return;
    }

    // A fixed temp name (like macos_admin_install's own staging file) — a button
    // click can't realistically race itself. LF is preserved (Rust's fs::write
    // doesn't translate line endings), which matters: a CRLF shebang would make
    // the distro reject the script with "bad interpreter".
    let staged = std::env::temp_dir().join("gitcat-wsl-launcher");
    if std::fs::write(&staged, wsl_launcher(win_exe)).is_err() {
        return;
    }
    let staged_win = match staged.to_str() {
        Some(s) => s,
        None => {
            let _ = std::fs::remove_file(&staged);
            return;
        }
    };
    // Single-quote the Windows temp path so `wslpath -u` receives it literally,
    // whatever %TEMP% expands to.
    let install = format!(
        r#"mkdir -p "$HOME/.local/bin" && cp "$(wslpath -u {})" "$HOME/.local/bin/gitcat" && chmod 755 "$HOME/.local/bin/gitcat""#,
        sh_single_quote(staged_win)
    );
    for distro in &distros {
        let mut cmd = std::process::Command::new("wsl.exe");
        // Uniform &str elements: distro/install are String, the rest are literals.
        cmd.args(["-d", distro.as_str(), "-e", "sh", "-c", install.as_str()])
            .no_console_window();
        match output_with_timeout(cmd, Duration::from_secs(20)) {
            Ok(out) if out.status.success() => eprintln!("gitcat: installed the WSL launcher into {distro}"),
            Ok(out) => eprintln!(
                "gitcat: couldn't install the WSL launcher into {distro}: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ),
            Err(e) => eprintln!("gitcat: couldn't install the WSL launcher into {distro}: {e}"),
        }
    }
    let _ = std::fs::remove_file(&staged);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_launcher_is_non_blocking_and_focus_correct() {
        let s = macos_launcher("/Applications/GitCat.app");
        assert!(s.starts_with("#!/bin/sh"));
        // Single-quoted so an arbitrary install path can't break the script.
        assert!(s.contains("BUNDLE='/Applications/GitCat.app'"));
        // LaunchServices launch = non-blocking + correct keyboard focus.
        assert!(s.contains("open -n -a"));
        // A relative path is anchored to the caller's CWD before hand-off.
        assert!(s.contains(r#"cd "$target""#));
        // The repo path reaches the app as its argv.
        assert!(s.contains("--args"));
    }

    #[test]
    fn macos_launcher_neutralizes_shell_metacharacters_in_the_path() {
        // A `$` in the bundle path must NOT be expanded — single quotes keep it
        // literal, so the launcher still resolves the real bundle.
        let s = macos_launcher("/Users/me/$HOME weird/GitCat.app");
        assert!(s.contains("BUNDLE='/Users/me/$HOME weird/GitCat.app'"));
    }

    #[test]
    fn linux_launcher_backgrounds_and_keeps_args() {
        let s = unix_launcher("/usr/bin/gitcat");
        assert!(s.starts_with("#!/bin/sh"));
        // Backgrounded (non-blocking) + detached from SIGHUP, path single-quoted.
        assert!(s.contains("nohup '/usr/bin/gitcat'"));
        assert!(s.contains(r#""$@""#));
        assert!(s.trim_end().ends_with('&'));
    }

    #[test]
    fn linux_launcher_handles_an_appimage_path_with_spaces() {
        let s = unix_launcher("/home/me/Apps/GitCat x86_64.AppImage");
        assert!(s.contains(r#"nohup '/home/me/Apps/GitCat x86_64.AppImage' "$@""#));
    }

    #[test]
    fn sh_single_quote_escapes_an_embedded_single_quote() {
        // The classic hazard: a path segment that itself contains a quote.
        assert_eq!(sh_single_quote("/Users/o'brien/x"), r"'/Users/o'\''brien/x'");
        assert_eq!(sh_single_quote("plain"), "'plain'");
    }

    #[test]
    fn windows_shim_is_non_blocking_and_cwd_pinned() {
        let s = windows_cmd_shim(r"C:\Program Files\GitCat\gitcat.exe");
        assert!(s.starts_with("@echo off"));
        // Non-blocking launch, pinned to the caller's directory, forwarding argv.
        assert!(s.contains(r#"start "" /D "%CD%" "C:\Program Files\GitCat\gitcat.exe" %*"#));
        // Batch files want CRLF line endings.
        assert!(s.contains("\r\n"));
    }

    #[test]
    fn windows_shim_doubles_percent_in_the_path() {
        // `%` is batch's one in-quotes metacharacter; a path with it must be
        // doubled so `start` still receives the real path.
        let s = windows_cmd_shim(r"C:\100%\gitcat.exe");
        assert!(s.contains(r#""C:\100%%\gitcat.exe""#));
    }

    #[test]
    fn wsl_launcher_translates_paths_and_backgrounds() {
        let s = wsl_launcher(r"C:\Program Files\GitCat\gitcat.exe");
        assert!(s.starts_with("#!/bin/sh"));
        // The exe path is single-quoted (spaces/metacharacters kept literal) and
        // translated to the distro's own mount point at run time.
        assert!(s.contains(r#"exe=$(wslpath -u 'C:\Program Files\GitCat\gitcat.exe')"#));
        // The repo argument is converted to the Windows-side path the app expects.
        assert!(s.contains(r#"win=$(wslpath -w "$target""#));
        // Non-blocking: the WSL terminal returns right away.
        assert!(s.contains("nohup \"$exe\""));
    }

    #[test]
    fn wsl_launcher_neutralizes_shell_metacharacters_in_the_exe_path() {
        // A `$` in the baked path must stay literal — single quotes see to that.
        let s = wsl_launcher(r"C:\weird$name\gitcat.exe");
        assert!(s.contains(r#"wslpath -u 'C:\weird$name\gitcat.exe'"#));
    }

    #[test]
    fn parse_wsl_list_decodes_utf16le_and_filters_service_distros() {
        // `wsl.exe -l -q` emits UTF-16LE; docker's service distros are dropped.
        let raw: Vec<u8> = "Ubuntu\r\ndocker-desktop\r\nDebian\r\ndocker-desktop-data\r\n"
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        assert_eq!(parse_wsl_list(&raw), vec!["Ubuntu".to_string(), "Debian".to_string()]);
    }

    #[test]
    fn parse_wsl_list_strips_a_utf16_bom() {
        let raw: Vec<u8> = "\u{feff}Ubuntu\r\n".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(parse_wsl_list(&raw), vec!["Ubuntu".to_string()]);
    }

    #[test]
    fn parse_wsl_list_empty_and_utf8_fallback() {
        assert!(parse_wsl_list(&[]).is_empty());
        // A defensive UTF-8 fallback for a hypothetical future non-UTF-16 wsl.exe.
        assert_eq!(parse_wsl_list(b"Ubuntu\nDebian\n"), vec!["Ubuntu".to_string(), "Debian".to_string()]);
    }
}
