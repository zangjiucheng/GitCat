//! "Install the `gitcat` command in PATH" — a VS Code `code`-style shell
//! launcher, installed on demand from ⌘K / Settings.
//!
//! macOS only for now: the Linux packages (`.deb`/`.rpm`) already drop the
//! binary on PATH, and Windows is a planned follow-up. On macOS the app
//! installs into `/Applications/GitCat.app` and nothing puts a `gitcat` command
//! on PATH, so this writes a small launcher script to `/usr/local/bin/gitcat`
//! (a directory on the default macOS PATH — see `/etc/paths`).
//!
//! The launcher opens the app through LaunchServices (`open -n -a`) rather than
//! exec'ing the Mach-O directly, for two reasons: `open` returns immediately so
//! the terminal isn't blocked for the app's whole lifetime, and LaunchServices
//! activates the new instance correctly so its keyboard layer works from the
//! first keystroke — a direct exec leaves the window unfocused until it's
//! clicked (see `windows.rs`'s own long comment on the same trap). Because
//! `open` starts the app with a different working directory, the launcher
//! resolves a relative path against the caller's CWD first, so `gitcat .` works.

/// JS: `commands.installCliShim()` — the ⌘K "Install 'gitcat' command" action
/// and the Settings ▸ Command line button. Returns the installed path on
/// success, or a human-readable error to surface as a Tama toast / inline note.
#[tauri::command]
#[specta::specta]
pub fn install_cli_shim() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        return macos::install();
    }
    #[cfg(not(target_os = "macos"))]
    {
        return Err("Installing the gitcat command from the app is only available on macOS right now. On Linux the .deb/.rpm package already puts gitcat on your PATH; on Windows, add the GitCat install folder to your PATH by hand.".to_string());
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    /// On the default macOS PATH (`/etc/paths` lists `/usr/local/bin`), so a
    /// launcher here is reachable from a fresh login shell without the user
    /// editing any dotfile.
    const TARGET: &str = "/usr/local/bin/gitcat";

    pub fn install() -> Result<String, String> {
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

        let script = launcher_script(bundle);
        let target = PathBuf::from(TARGET);

        match write_launcher(&target, &script) {
            Ok(()) => Ok(TARGET.to_string()),
            // /usr/local/bin is root-owned on a non-Homebrew Mac — fall back to a
            // single native admin prompt rather than failing.
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                install_with_admin(&script).map(|()| TARGET.to_string())
            }
            Err(e) => Err(format!("Couldn't write {TARGET}: {e}")),
        }
    }

    /// The launcher written to `/usr/local/bin/gitcat`. `bundle` is the absolute
    /// path to the `.app`, baked in at install time so it keeps working even if
    /// GitCat isn't in `/Applications`.
    fn launcher_script(bundle: &str) -> String {
        format!(
            r#"#!/bin/sh
# GitCat command-line launcher. Installed by GitCat (Settings > Command line,
# or the "Install 'gitcat' command" action). Re-run that to point it at a moved
# or updated app.
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

    fn write_launcher(target: &Path, script: &str) -> std::io::Result<()> {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut f = std::fs::File::create(target)?;
        f.write_all(script.as_bytes())?;
        f.flush()?;
        std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o755))?;
        Ok(())
    }

    /// Fallback when `/usr/local/bin` isn't writable by the current user: stage
    /// the script in a temp file and copy it into place with a single osascript
    /// admin prompt (the native "GitCat wants to make changes" password dialog).
    fn install_with_admin(script: &str) -> Result<(), String> {
        let staged = std::env::temp_dir().join("gitcat-cli-launcher");
        write_launcher(&staged, script)
            .map_err(|e| format!("Couldn't stage the launcher: {e}"))?;
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
        let out = Command::new("osascript")
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

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn launcher_bakes_bundle_and_stays_non_blocking() {
            let s = launcher_script("/Applications/GitCat.app");
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
        fn launcher_bundle_path_is_interpolated_verbatim() {
            let s = launcher_script("/Users/me/Apps/GitCat.app");
            assert!(s.contains(r#"BUNDLE="/Users/me/Apps/GitCat.app""#));
        }
    }
}
