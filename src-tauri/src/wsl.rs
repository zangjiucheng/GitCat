//! WSL-aware git-CLI routing for the network-touching commands in
//! `git_remote.rs` (fetch/pull/push/push_tag/push_branch/force_push/
//! reset_branch_to_upstream) and `submodule.rs` (init/update/add/sync):
//! when the target repo lives on a `\\wsl.localhost\<Distro>\...` (or legacy
//! `\\wsl$\<Distro>\...`) UNC path, running Windows' own `git.exe` against it
//! resolves credentials via WINDOWS' own SSH keys/credential helper — never
//! the ones configured INSIDE that WSL distro, which is very often what a
//! WSL user actually has set up for that repo's remote (EMPIRICALLY
//! CONFIRMED on this dev box: Windows' `~/.ssh/id_ed25519` and the WSL
//! distro's own `~/.ssh/id_ed25519` are two different keys with different
//! dates — a remote that only trusts the WSL-side key fails, or blocks
//! waiting on a passphrase/host-key prompt neither side can see, when run
//! through Windows' own git.exe). Detected here, routed through `wsl.exe -d
//! <Distro> -e git -C <linux-path> ...` instead, so credential resolution
//! happens inside the distro exactly as if the user ran the command in a WSL
//! shell.
//!
//! `-e`/`--exec` (NOT the bare `--` separator) is load-bearing, not
//! cosmetic — EMPIRICALLY VERIFIED against the WSL build on this box: `wsl
//! -d <Distro> -- echo '$(whoami)'` runs the joined command line through the
//! distro's default shell, which EXPANDS `$(...)`/backticks/`$VAR` (though
//! NOT `;` as a statement separator or `'` as a quote terminator — this is
//! double-quote-style reinterpretation of the reconstructed command line,
//! not full shell re-tokenizing); `wsl -d <Distro> -e echo '$(whoami)'`
//! performs a direct exec with no shell involved at all — every character
//! stays completely literal, confirmed with a real `git log --grep` call
//! too. Since `git_remote.rs`'s branch/remote/tag validators
//! (`validate_branch_name` etc.) block a leading `-`/control chars/
//! whitespace but never needed to block `$`/backticks/parens (all legal in
//! a real git ref name — git's own `check-ref-format` doesn't restrict
//! them), routing through the bare `--` form would open a shell-injection
//! hole that doesn't exist today; `-e` preserves the exact same "no shell,
//! argv is argv" safety model the plain (non-WSL) `Command::new("git")` call
//! already has.
//!
//! Not used by the other ~19 modules that shell out to git for purely local
//! work (status, diff, commit, branch, stash, ...) — those already work over
//! the UNC mount via plain `git.exe`/git2 (see `trust::open_repo`'s own doc
//! comment for the SEPARATE dubious-ownership fix those need), and routing
//! them through `wsl.exe` too would add real per-call latency (a fresh WSL
//! interop launch) for operations that were never touching a remote and so
//! never had a credential problem to fix.
//!
//! WITHIN `git_remote.rs`/`submodule.rs`, though, this IS used for every
//! command in each module, including the couple that are themselves
//! local-only (`reset_branch_to_upstream`; `submodule_init`/`submodule_sync`)
//! — both modules' own doc comments explain why: one shared `run_git` per
//! module is this codebase's convention, and splitting either module's
//! `run_git` in two just to spare a local-only command one extra `wsl.exe`
//! launch isn't worth the duplication.

use std::process::{Command, Stdio};

/// `path` -> `(distro, linux_path)` when `path` is a WSL UNC path, checking
/// both the modern `wsl.localhost` host and the legacy `wsl$` alias, and
/// both slash directions (Tauri's own file-picker dialog and this app's
/// stored repo-registry entries use native `\`-separated Windows paths;
/// `trust.rs`'s own retry normalizes to `/` before it ever runs — accepting
/// either form here means this doesn't depend on whether that already ran).
/// The host segment is matched case-insensitively (Windows UNC hosts are
/// case-insensitive); the distro name and Linux path are kept exactly as
/// given — Linux paths ARE case-sensitive.
fn wsl_target(path: &str) -> Option<(String, String)> {
    let forward = path.replace('\\', "/");
    let mut segments = forward.split('/').filter(|s| !s.is_empty());
    let host = segments.next()?;
    if !host.eq_ignore_ascii_case("wsl.localhost") && !host.eq_ignore_ascii_case("wsl$") {
        return None;
    }
    let distro = segments.next()?;
    let rest: Vec<&str> = segments.collect();
    Some((distro.to_string(), format!("/{}", rest.join("/"))))
}

/// Build a `git -C <path> <args>` invocation, transparently routed through
/// `wsl.exe -d <distro> -e git -C <linux-path> <args>` when `path` is a WSL
/// UNC path — see module doc comment.
///
/// Every caller also gets `GIT_TERMINAL_PROMPT=0` and a null stdin: this
/// builder is only ever used for commands that talk to a remote (fetch/
/// pull/push*, submodule init/update/add/sync), and a credential prompt
/// neither side can answer should fail fast with git's own clear error
/// instead of hanging forever waiting on stdin the spawning GUI process
/// never provides — EMPIRICALLY CONFIRMED `std::process::Command::output()`
/// does not touch stdin on its own (only stdout/stderr are piped), so it's
/// inherited from this app's own process (a real, readable terminal during
/// `tauri dev`) unless set here explicitly. `GIT_TERMINAL_PROMPT=0` only
/// suppresses git's OWN terminal-based username/password prompt — it does
/// not touch a graphical credential helper's (e.g. Windows' GCM) own
/// separate popup, so that path is unaffected on a plain (non-WSL) repo.
///
/// On the WSL branch, `GIT_TERMINAL_PROMPT=0` is passed as a literal `env
/// VAR=val` argv PREFIX inside the `-e` exec, never as a `Command::env` set
/// on the outer `wsl.exe` process — EMPIRICALLY CONFIRMED a Windows-side env
/// var set on `wsl.exe` itself does NOT cross into the distro's own
/// environment on its own (`wsl -d <Distro> -e printenv
/// GIT_TERMINAL_PROMPT` prints nothing even with it set on the `wsl.exe`
/// process; WSL's interop only forwards env vars explicitly listed in the
/// Windows-side `WSLENV` var). Using `env` as an argv prefix sidesteps that
/// boundary entirely — confirmed to reach the child process — and needs no
/// cooperation from `WSLENV`, which the user could have cleared/customized.
///
/// Known residual gap, NOT fixed here: SSH's own passphrase/host-key
/// prompts open `/dev/tty` directly rather than reading stdin, so a WSL-side
/// remote that genuinely needs an interactive SSH prompt can still hang even
/// with stdin nulled. Suppressing that fully (e.g. forcing `-o
/// BatchMode=yes` via `GIT_SSH_COMMAND`) risks silently overriding a user's
/// own `core.sshCommand`/`GIT_SSH_COMMAND` customization (a corporate
/// jump-host wrapper, say) and wasn't verified against a real SSH server —
/// left as a follow-up rather than shipped unverified.
pub fn git_command(path: &str, args: &[&str]) -> Command {
    let mut cmd = match wsl_target(path) {
        Some((distro, linux_path)) => {
            let mut c = Command::new("wsl.exe");
            c.arg("-d")
                .arg(&distro)
                .arg("-e")
                .arg("env")
                .arg("GIT_TERMINAL_PROMPT=0")
                .arg("git")
                .arg("-C")
                .arg(&linux_path)
                .args(args);
            c
        }
        None => {
            let mut c = Command::new("git");
            c.arg("-C").arg(path).args(args);
            c.env("GIT_TERMINAL_PROMPT", "0");
            c
        }
    };
    cmd.stdin(Stdio::null());
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_modern_wsl_localhost_host_both_slash_directions() {
        assert_eq!(
            wsl_target(r"\\wsl.localhost\Ubuntu\home\jc\repo"),
            Some(("Ubuntu".to_string(), "/home/jc/repo".to_string()))
        );
        assert_eq!(
            wsl_target("//wsl.localhost/Ubuntu/home/jc/repo"),
            Some(("Ubuntu".to_string(), "/home/jc/repo".to_string()))
        );
    }

    #[test]
    fn detects_legacy_wsl_dollar_alias() {
        assert_eq!(
            wsl_target(r"\\wsl$\Debian\home\jc\repo"),
            Some(("Debian".to_string(), "/home/jc/repo".to_string()))
        );
    }

    #[test]
    fn host_match_is_case_insensitive_but_distro_and_path_are_preserved_verbatim() {
        assert_eq!(
            wsl_target(r"\\WSL.LOCALHOST\Ubuntu\Home\JC\Repo"),
            Some(("Ubuntu".to_string(), "/Home/JC/Repo".to_string()))
        );
    }

    #[test]
    fn distro_name_with_dots_and_dashes() {
        assert_eq!(
            wsl_target(r"\\wsl.localhost\Ubuntu-22.04\home\jc\repo"),
            Some(("Ubuntu-22.04".to_string(), "/home/jc/repo".to_string()))
        );
    }

    #[test]
    fn root_of_a_distro_with_no_further_path() {
        assert_eq!(wsl_target(r"\\wsl.localhost\Ubuntu"), Some(("Ubuntu".to_string(), "/".to_string())));
    }

    #[test]
    fn host_with_no_distro_segment_at_all_is_not_a_valid_target() {
        assert_eq!(wsl_target(r"\\wsl.localhost\"), None);
        assert_eq!(wsl_target(r"\\wsl.localhost"), None);
    }

    #[test]
    fn ordinary_windows_and_unc_paths_are_not_wsl() {
        assert_eq!(wsl_target(r"C:\Users\me\repo"), None);
        assert_eq!(wsl_target(r"\\server\share\repo"), None); // a REAL network share, not WSL
        assert_eq!(wsl_target("/home/me/repo"), None); // a WSL-internal path with no Windows host at all
    }

    #[test]
    fn git_command_routes_through_wsl_exe_with_exec_flag_for_a_wsl_path() {
        let cmd = git_command(r"\\wsl.localhost\Ubuntu\home\jc\repo", &["fetch", "--all"]);
        assert_eq!(cmd.get_program(), "wsl.exe");
        let args: Vec<_> = cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(
            args,
            vec![
                "-d",
                "Ubuntu",
                "-e",
                "env",
                "GIT_TERMINAL_PROMPT=0",
                "git",
                "-C",
                "/home/jc/repo",
                "fetch",
                "--all"
            ]
        );
    }

    #[test]
    fn git_command_stays_plain_git_for_a_non_wsl_path() {
        let cmd = git_command(r"C:\Users\me\repo", &["fetch", "--all"]);
        assert_eq!(cmd.get_program(), "git");
        let args: Vec<_> = cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(args, vec!["-C", r"C:\Users\me\repo", "fetch", "--all"]);
    }
}
