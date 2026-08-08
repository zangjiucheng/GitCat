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

/// macOS launcher body. `bundle` is the absolute path to the `.app`, baked in at
/// install time so it keeps working even when GitCat isn't in `/Applications`.
#[cfg(any(target_os = "macos", test))]
fn macos_launcher(bundle: &str) -> String {
    format!(
        r#"#!/bin/sh
# GitCat command-line launcher. Installed by GitCat (Settings > Command line, or
# the "Install 'gitcat' command" action). Re-run that to point it at a moved or
# updated app.
#
# Opens GitCat through LaunchServices so the terminal returns right away and the
# new window takes keyboard focus. A relative path is resolved against the
# current directory first, because `open` starts the app from a different one.
BUNDLE="{bundle}"
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
    format!(
        r#"#!/bin/sh
# GitCat command-line launcher. Installed by GitCat (Settings > Command line, or
# the "Install 'gitcat' command" action). Re-run that after moving or updating
# the app.
#
# Runs GitCat in the background so this terminal returns right away. The app
# inherits this shell's working directory, so a relative path (gitcat .)
# resolves against where you ran it.
nohup "{bin}" "$@" >/dev/null 2>&1 &
"#
    )
}

/// Windows `gitcat.cmd` shim. `exe` is the absolute path to `gitcat.exe`. CRLF
/// line endings for a batch file.
#[cfg(any(target_os = "windows", test))]
fn windows_cmd_shim(exe: &str) -> String {
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
    // Single-quote the paths so the shell treats them literally; a temp or
    // target path here never contains a single quote.
    let shell =
        format!("mkdir -p /usr/local/bin && cp '{staged}' '{TARGET}' && chmod 755 '{TARGET}'");
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
    Ok(target.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_launcher_is_non_blocking_and_focus_correct() {
        let s = macos_launcher("/Applications/GitCat.app");
        assert!(s.starts_with("#!/bin/sh"));
        assert!(s.contains(r#"BUNDLE="/Applications/GitCat.app""#));
        // LaunchServices launch = non-blocking + correct keyboard focus.
        assert!(s.contains("open -n -a"));
        // A relative path is anchored to the caller's CWD before hand-off.
        assert!(s.contains(r#"cd "$target""#));
        // The repo path reaches the app as its argv.
        assert!(s.contains("--args"));
    }

    #[test]
    fn macos_launcher_bakes_bundle_path_verbatim() {
        let s = macos_launcher("/Users/me/Apps/GitCat.app");
        assert!(s.contains(r#"BUNDLE="/Users/me/Apps/GitCat.app""#));
    }

    #[test]
    fn linux_launcher_backgrounds_and_keeps_args() {
        let s = unix_launcher("/usr/bin/gitcat");
        assert!(s.starts_with("#!/bin/sh"));
        // Backgrounded (non-blocking) + detached from SIGHUP.
        assert!(s.contains("nohup \"/usr/bin/gitcat\""));
        assert!(s.contains(r#""$@""#));
        assert!(s.trim_end().ends_with('&'));
    }

    #[test]
    fn linux_launcher_handles_an_appimage_path_with_spaces() {
        let s = unix_launcher("/home/me/Apps/GitCat x86_64.AppImage");
        assert!(s.contains(r#"nohup "/home/me/Apps/GitCat x86_64.AppImage" "$@""#));
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
}
