//! SSH askpass helper — the actual fix for `git_remote.rs`'s own
//! `git_error_message`-only "Host key verification failed" hint: this makes
//! the hint unnecessary in the common case, instead of just explaining it.
//!
//! Every git subprocess this app spawns has `stdin(Stdio::null())` and no
//! console window (see `wsl::git_command`), so the `ssh` child it launches
//! for a remote operation has NO terminal to interactively ask "are you
//! sure you want to continue connecting (yes/no)?" on the first connection
//! to a host it's never seen before — it fails closed instead
//! ("Host key verification failed."). Investigated why GitExtensions
//! doesn't hit this on the same machine: it ships its own tiny SSH_ASKPASS
//! helper program (`GitExtSshAskPass.exe`, confirmed via its own embedded
//! strings — literally `(yes/no)` and "Enter your OpenSSH passphrase:") and
//! points the `SSH_ASKPASS` env var at it. OpenSSH (8.4+) invokes whatever
//! `SSH_ASKPASS` points at — passing the exact question as that program's
//! one CLI argument — for ANY interactive question it can't otherwise ask,
//! not just passphrase prompts, reading the answer back from that
//! program's stdout. This module is GitCat's own version of that helper.
//!
//! Rather than shipping a SEPARATE compiled binary (the way GitExtensions
//! does), this re-execs GitCat's OWN executable — the exact same
//! `std::env::current_exe()` pattern `windows.rs`'s `spawn_new_window`
//! already established for a different reason (a brand-new independent
//! window). `wsl::git_command` points `SSH_ASKPASS` at this same exe and
//! sets [`ENV_MARKER`] alongside it; `main()` checks that marker BEFORE
//! ever touching Tauri's own boot sequence, and if set, the entire process
//! lifetime is [`run_and_exit`] below — nothing else in this binary ever
//! runs. No new packaging/bundling surface, no second binary to keep in
//! sync with the app's own version.
//!
//! `rfd::MessageDialog` (not a full Tauri window) is deliberate: this needs
//! to pop ONE synchronous native dialog and exit — no event loop, no
//! webview, nothing else. It's already a transitively-locked dependency
//! (tauri-plugin-dialog's own file-picker backend), so this promotes it to
//! a direct one rather than adding something new to the tree.
//!
//! SCOPE: only wired into the PLAIN (non-WSL) branch of `wsl::git_command`
//! for now. A WSL-routed repo's `ssh` runs INSIDE the distro, so
//! `SSH_ASKPASS` would need to point at a WSL-mounted path to this same
//! .exe (`/mnt/c/...`) AND travel through the same `env VAR=val` argv-prefix
//! trick `GIT_TERMINAL_PROMPT` already uses there (a bare `Command::env` on
//! the outer `wsl.exe` process does NOT cross into the distro's own
//! environment — see `wsl::git_command`'s own doc comment) — real,
//! separate work with its own WSL-side testing this session's environment
//! couldn't reliably do. A WSL repo still only gets `git_remote.rs`'s
//! existing text hint for now, not this interactive flow.
//!
//! SCOPE (2): only the yes/no host-key-confirmation shape is handled.
//! `rfd` has no password/text-entry dialog at all, so a passphrase prompt
//! is deliberately left alone — [`handle`] detects it doesn't look like a
//! yes/no question and exits non-zero without showing anything, which is
//! EXACTLY what happens today with no askpass configured at all. Not a
//! regression for that case, just not a fix for it either (see
//! `git_remote.rs`'s existing WSL ssh-agent hint for that failure mode
//! instead).

/// Set alongside `SSH_ASKPASS` on the git subprocess (see `wsl::git_command`)
/// — `main()` checks this BEFORE booting Tauri at all. A dedicated marker
/// rather than just "did we get exactly one CLI arg": `windows.rs`'s own
/// `initial_repo_arg()` already reads `args().nth(1)` as an ORDINARY repo
/// path for the multi-window `?repo=` feature — this marker is what keeps
/// "ssh re-launched me to ask a question" unambiguous from "a user/shortcut
/// launched me with a repo path", not the mere presence of one argument.
pub const ENV_MARKER: &str = "GITCAT_SSH_ASKPASS";

pub fn is_askpass_invocation() -> bool {
    std::env::var_os(ENV_MARKER).is_some()
}

/// The entire reason THIS process instance exists when spawned as ssh's own
/// askpass helper: read the question ssh passed as this process's one CLI
/// argument, answer it (or decline to), and exit — main() calls this
/// instead of ever reaching `gitcat_lib::run()`. Never returns.
pub fn run_and_exit() -> ! {
    let prompt = std::env::args().nth(1).unwrap_or_default();
    std::process::exit(handle(&prompt));
}

/// Exit code convention matches what OpenSSH itself expects from any
/// askpass helper: 0 with an answer printed to stdout, non-zero (with
/// nothing printed) to signal "couldn't get an answer" — the SAME outcome
/// ssh already reaches on its own with no askpass configured at all, so
/// every path this function declines to handle is a no-op, never a new
/// failure mode.
fn handle(prompt: &str) -> i32 {
    if !looks_like_host_key_confirmation(prompt) {
        return 1;
    }
    // Never anything other than the exact literal "yes"/"no": OpenSSH loops
    // re-asking (and, per a documented real-world combination with
    // StrictHostKeyChecking=ask, can loop INDEFINITELY) on anything else —
    // so `_` below (a closed dialog, a titlebar X, anything but an explicit
    // Yes click) has to resolve to a definite "no", never silence.
    let answer = match rfd::MessageDialog::new()
        .set_title("GitCat — SSH host key")
        .set_description(prompt)
        .set_level(rfd::MessageLevel::Warning)
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
    {
        rfd::MessageDialogResult::Yes => "yes",
        _ => "no",
    };
    println!("{answer}");
    0
}

/// OpenSSH's own host-key-confirmation prompt always contains this literal
/// substring, across every version this app cares about — older releases
/// end it "(yes/no)?", newer ones "(yes/no/[fingerprint])?" (added so a
/// user can type the shown fingerprint instead of a bare "yes"), so a
/// substring match on "yes/no" alone covers both without needing to also
/// match the surrounding wording, which nothing here otherwise depends on.
fn looks_like_host_key_confirmation(prompt: &str) -> bool {
    prompt.contains("yes/no")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_the_older_and_newer_openssh_host_key_prompt_shapes() {
        assert!(looks_like_host_key_confirmation(
            "The authenticity of host 'example.com (1.2.3.4)' can't be established.\n\
             ED25519 key fingerprint is SHA256:abc.\n\
             Are you sure you want to continue connecting (yes/no/[fingerprint])?"
        ));
        assert!(looks_like_host_key_confirmation("Are you sure you want to continue connecting (yes/no)?"));
    }

    #[test]
    fn does_not_match_a_passphrase_or_other_unrelated_prompt() {
        assert!(!looks_like_host_key_confirmation("Enter passphrase for key '/home/x/.ssh/id_ed25519': "));
        assert!(!looks_like_host_key_confirmation(""));
        assert!(!looks_like_host_key_confirmation("Permission denied (publickey)."));
    }

    #[test]
    fn handle_declines_a_prompt_it_does_not_recognize_without_asking_anything() {
        // CI runners typically have no real desktop session for a native
        // dialog to appear on, so this suite deliberately only exercises
        // the early-return path (confirming a non-yes/no prompt exits
        // non-zero, ssh's own "declined" signal, without ever reaching the
        // rfd::MessageDialog call) rather than the actual dialog itself —
        // manually verified end-to-end instead (a real dialog titled
        // "GitCat — SSH host key" with the exact prompt text and Yes/No
        // buttons, screenshotted against a live desktop session).
        assert_eq!(handle("Enter passphrase for key '/home/x/.ssh/id_ed25519': "), 1);
        assert_eq!(handle(""), 1);
    }

    #[test]
    fn is_askpass_invocation_reads_the_dedicated_marker_env_var_only() {
        // SAFETY: std::env::set_var/remove_var are PROCESS-WIDE, not
        // per-thread, and cargo runs a test binary's tests on multiple
        // threads by default — tests/git_config.rs's own doc comment on its
        // ENV_GUARD mutex covers this in full. No such guard needed HERE:
        // this is the only test anywhere in this codebase that touches
        // GITCAT_SSH_ASKPASS at all, so there's no other test to race with.
        unsafe {
            std::env::remove_var(ENV_MARKER);
        }
        assert!(!is_askpass_invocation());
        unsafe {
            std::env::set_var(ENV_MARKER, "1");
        }
        assert!(is_askpass_invocation());
        unsafe {
            std::env::remove_var(ENV_MARKER);
        }
    }
}
