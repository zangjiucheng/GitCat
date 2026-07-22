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

use crate::procutil::{output_with_timeout, NoConsoleWindowExt, SUBPROCESS_TIMEOUT};

/// `path` -> `(distro, linux_path)` when `path` is a WSL UNC path, checking
/// both the modern `wsl.localhost` host and the legacy `wsl$` alias, and
/// both slash directions (Tauri's own file-picker dialog and this app's
/// stored repo-registry entries use native `\`-separated Windows paths;
/// `trust.rs`'s own retry normalizes to `/` before it ever runs — accepting
/// either form here means this doesn't depend on whether that already ran).
/// The host segment is matched case-insensitively (Windows UNC hosts are
/// case-insensitive); the distro name and Linux path are kept exactly as
/// given — Linux paths ARE case-sensitive.
///
/// Also strips a leading `\\?\UNC\` (Windows' own "extended-length path"
/// form) before matching: `repo_registry::normalize` runs every tracked
/// repo's path through `std::fs::canonicalize`, which on Windows rewrites
/// `\\wsl.localhost\Ubuntu\...` to `\\?\UNC\wsl.localhost\Ubuntu\...` —
/// without this, a WSL repo opened via the Dashboard (any tracked repo)
/// would silently stop being recognized as WSL at all here, even though a
/// freshly-picked, not-yet-tracked path still matched. `\\?\C:\...` (a
/// local drive in extended form) correctly still returns `None` below —
/// only the `UNC` marker specifically continues on to the host check.
pub fn wsl_target(path: &str) -> Option<(String, String)> {
    let forward = path.replace('\\', "/");
    let mut segments = forward.split('/').filter(|s| !s.is_empty());
    let mut host = segments.next()?;
    if host.eq_ignore_ascii_case("?") {
        let marker = segments.next()?;
        if !marker.eq_ignore_ascii_case("UNC") {
            return None;
        }
        host = segments.next()?;
    }
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
    cmd.no_console_window();
    cmd
}

/// One `git status --porcelain=v2` entry, normalized to this app's own
/// status-letter vocabulary ('A'/'M'/'D'/'R'/'T' — see `workdir.rs`'s
/// `WorkdirEntry`/`commands.rs`'s `status_char`, this module's own copy of
/// the same fold-copies-into-renames convention those already use for
/// `Delta::Copied`).
pub enum StatusEntry {
    /// An ordinary or renamed/copied change. `staged`/`unstaged` are the
    /// mapped status letter for that side, `None` when unchanged on that
    /// side (a `Change` is always non-`None` on at least one side — that's
    /// what makes it a change at all). `orig_path` is `Some` only for a
    /// rename/copy (record type `2`).
    Change { path: String, orig_path: Option<String>, staged: Option<char>, unstaged: Option<char> },
    Unmerged { path: String },
    Untracked { path: String },
}

fn map_status_char(c: char) -> char {
    match c {
        'A' => 'A',
        'D' => 'D',
        'T' => 'T',
        // This app's own status vocabulary has no separate "copied" code —
        // same fold `commands.rs`'s `status_char` already applies to
        // `Delta::Copied`, so a copy (record type `2`, X or Y == 'C') reads
        // exactly like a rename here, not as a distinct third case.
        'R' | 'C' => 'R',
        // 'M', plus a defensive fallback for anything this porcelain
        // version doesn't otherwise produce (unrecognized future git
        // output should read as "changed", never silently vanish).
        _ => 'M',
    }
}

/// Parse `git status --porcelain=v2 -z` output into [`StatusEntry`]s.
/// EMPIRICALLY VERIFIED byte-for-byte against real `git status --porcelain=v2
/// -z` output (od -c) for a staged rename, an unstaged untracked file, and a
/// merge conflict — see this function's own field-count comments; not
/// assumed from the format's prose documentation alone. `-z` makes every
/// record NUL-terminated (never newline), and — the one easy-to-miss part —
/// a record-type-`2` (rename/copy) record's `origPath` is its own SEPARATE
/// NUL-terminated token immediately after the record itself, not
/// tab-appended onto the same one the way the non-`-z` format works.
pub fn parse_status_porcelain_v2(raw: &str) -> Vec<StatusEntry> {
    let mut tokens = raw.split('\0').filter(|t| !t.is_empty());
    let mut out = Vec::new();
    while let Some(tok) = tokens.next() {
        let mut head = tok.splitn(2, ' ');
        let kind = head.next().unwrap_or("");
        let rest = head.next().unwrap_or("");
        match kind {
            // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` — 7 fields before path.
            "1" => {
                let parts: Vec<&str> = rest.splitn(8, ' ').collect();
                if parts.len() < 8 {
                    continue;
                }
                let mut xy = parts[0].chars();
                let (x, y) = (xy.next().unwrap_or('.'), xy.next().unwrap_or('.'));
                out.push(StatusEntry::Change {
                    path: parts[7].to_string(),
                    orig_path: None,
                    staged: (x != '.').then(|| map_status_char(x)),
                    unstaged: (y != '.').then(|| map_status_char(y)),
                });
            }
            // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` (8 fields
            // before path) then a SEPARATE NUL-terminated `origPath` token.
            "2" => {
                let parts: Vec<&str> = rest.splitn(9, ' ').collect();
                if parts.len() < 9 {
                    continue;
                }
                let mut xy = parts[0].chars();
                let (x, y) = (xy.next().unwrap_or('.'), xy.next().unwrap_or('.'));
                let orig_path = tokens.next().unwrap_or("").to_string();
                out.push(StatusEntry::Change {
                    path: parts[8].to_string(),
                    orig_path: Some(orig_path),
                    staged: (x != '.').then(|| map_status_char(x)),
                    unstaged: (y != '.').then(|| map_status_char(y)),
                });
            }
            // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` — 9 fields before path.
            "u" => {
                let parts: Vec<&str> = rest.splitn(10, ' ').collect();
                if parts.len() < 10 {
                    continue;
                }
                out.push(StatusEntry::Unmerged { path: parts[9].to_string() });
            }
            "?" => out.push(StatusEntry::Untracked { path: rest.to_string() }),
            // "!" (ignored — never requested, see wsl_status's own flags) or any
            // unrecognized future record type: skip rather than misparse.
            _ => {}
        }
    }
    out
}

/// For a WSL-path repo ONLY, runs `git status --porcelain=v2 -z
/// --untracked-files=all --find-renames` via the distro's own git (see
/// module doc — same `-e`/`--exec` injection-safety model `git_command`
/// already provides) and parses it. `None` when `path` isn't a WSL path at
/// all — every caller keeps using git2 unchanged in that case; git2's own
/// `Repository::statuses()` is fine (fast, correct) there.
///
/// This exists specifically to route AROUND a libgit2 problem, not a
/// credential one like `git_command`'s own reason for existing:
/// EMPIRICALLY CONFIRMED against a real ~1000-commit repo (a fresh CPython
/// clone) containing just 4 Linux symlinks — `Repository::statuses()`
/// (`dashboard.rs`/`workdir.rs`'s status read) took 185+ SECONDS, on EVERY
/// call, not just a cold first one — while `git status` via this function
/// on the exact same repo resolves in under a second. libgit2, running as a
/// WINDOWS process, appears to badly mishandle a Linux symlink reached
/// over the `\\wsl.localhost\` 9P bridge (its own error, when it doesn't
/// just stall: "could not find '<target>' to open" — Windows' own I/O layer
/// failing to resolve the symlink's target through that bridge at all); the
/// distro's own git, walking its OWN native filesystem, has no such
/// problem.
pub fn wsl_status(path: &str) -> Option<Result<Vec<StatusEntry>, String>> {
    wsl_target(path)?;
    let cmd = git_command(path, &["status", "--porcelain=v2", "-z", "--untracked-files=all", "--find-renames"]);
    let out = output_with_timeout(cmd, SUBPROCESS_TIMEOUT);
    Some(match out {
        Ok(o) if o.status.success() => Ok(parse_status_porcelain_v2(&String::from_utf8_lossy(&o.stdout))),
        Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
            Err(format!("WSL status check timed out after {SUBPROCESS_TIMEOUT:?} — try `wsl --shutdown` in a terminal, then reopen this repo"))
        }
        Err(e) => Err(format!("Could not run git: {e}")),
    })
}

/// For a WSL-path repo ONLY, computes `branch`'s ahead/behind against its
/// own configured upstream via `git rev-list --left-right --count
/// <branch>...<branch>@{upstream}` run through the distro's own git —
/// exactly the same "let the distro's native git do it instead of crossing
/// the `\\wsl.localhost\` bridge" idea `wsl_status` already uses for the
/// dirty/conflicted check, applied to `dashboard.rs`'s OTHER git2 call:
/// `Repository::graph_ahead_behind` walks the COMMIT graph (parent
/// pointers), not the working tree, so it was never at risk of the specific
/// symlink-over-9P-bridge stall `wsl_status`'s own doc comment describes —
/// but it still opens/reads OBJECT DATABASE files (loose objects, or a
/// packfile's own index) through that same bridge, one round trip at a
/// time, which a repo with CPython-scale history (100,000+ commits) can
/// make genuinely slow even without hitting that specific bug. Running the
/// walk natively inside the distro (on its own real filesystem, no bridge
/// crossing at all) avoids that entirely.
///
/// Three-way return, same shape as `wsl_status` plus one extra layer:
///   - `None` — not a WSL path, caller keeps using git2 unchanged.
///   - `Some(Ok(None))` — confirmed WSL path, `branch` has no upstream
///     configured (not an error — matches `dashboard_repo_status_inner`'s
///     own pre-existing "(None, None)" no-upstream case exactly).
///   - `Some(Ok(Some((ahead, behind))))` — the real numbers.
///   - `Some(Err(_))` — the check itself failed or timed out; callers should
///     degrade to `(None, None)` here too rather than falling back to the
///     slower git2 walk this function exists to avoid (same
///     graceful-degradation spirit `dashboard_repo_status_inner`'s own
///     liberal use of `.ok()` already has for every OTHER field here).
pub fn wsl_ahead_behind(path: &str, branch: &str) -> Option<Result<Option<(usize, usize)>, String>> {
    wsl_target(path)?;
    let revspec = format!("{branch}...{branch}@{{upstream}}");
    let cmd = git_command(path, &["rev-list", "--left-right", "--count", &revspec]);
    Some(match output_with_timeout(cmd, SUBPROCESS_TIMEOUT) {
        Ok(o) if o.status.success() => {
            let text = String::from_utf8_lossy(&o.stdout);
            match parse_ahead_behind_count(&text) {
                Some(pair) => Ok(Some(pair)),
                None => Err(format!("unexpected `git rev-list --left-right --count` output: {text:?}")),
            }
        }
        // git's own message for this is stable across versions: "fatal: no
        // upstream configured for branch '<name>'" — not a real failure,
        // just "there's nothing to compute" (see this function's own doc
        // comment on the Ok(None) case).
        Ok(o) if String::from_utf8_lossy(&o.stderr).contains("no upstream") => Ok(None),
        Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
            Err(format!("WSL ahead/behind check timed out after {SUBPROCESS_TIMEOUT:?}"))
        }
        Err(e) => Err(format!("Could not run git: {e}")),
    })
}

/// `git rev-list --left-right --count A...B`'s stdout is two whitespace-
/// separated integers ("<commits only in A>\t<commits only in B>\n") — `A`
/// being the local branch, `B` its upstream, in `wsl_ahead_behind`'s own
/// revspec, so this is exactly (ahead, behind) in that order. `None` for
/// anything that doesn't parse as exactly two integers — a real git version
/// difference or output surprise should read as "couldn't determine
/// ahead/behind", never silently misattribute one number to the other.
fn parse_ahead_behind_count(text: &str) -> Option<(usize, usize)> {
    let mut parts = text.split_whitespace();
    let ahead = parts.next()?.parse().ok()?;
    let behind = parts.next()?.parse().ok()?;
    Some((ahead, behind))
}

#[cfg(test)]
mod tests {
    use super::*;

    // output_with_timeout's own generic wait/kill/drain behavior is tested
    // at its actual home, procutil.rs — nothing WSL-specific about it to
    // re-test here.

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

    // repo_registry::normalize() runs every TRACKED repo's path through
    // std::fs::canonicalize, which on Windows rewrites a UNC path to this
    // "extended-length" \\?\UNC\... form — a repo opened from the Dashboard
    // (as opposed to freshly picked and never tracked) hits this shape.
    #[test]
    fn strips_the_extended_length_unc_prefix_canonicalize_adds() {
        assert_eq!(
            wsl_target(r"\\?\UNC\wsl.localhost\Ubuntu\home\jc\repo"),
            Some(("Ubuntu".to_string(), "/home/jc/repo".to_string()))
        );
        assert_eq!(
            wsl_target(r"\\?\UNC\wsl$\Debian\home\jc\repo"),
            Some(("Debian".to_string(), "/home/jc/repo".to_string()))
        );
        // Case-insensitive like the plain UNC host match above.
        assert_eq!(
            wsl_target(r"\\?\unc\WSL.LOCALHOST\Ubuntu\home\jc\repo"),
            Some(("Ubuntu".to_string(), "/home/jc/repo".to_string()))
        );
    }

    // The SAME extended-length form exists for ordinary local drive paths
    // (\\?\C:\...) — canonicalize's most common case by far. Must not be
    // mistaken for WSL just because it also starts with \\?\.
    #[test]
    fn extended_length_local_drive_paths_are_not_wsl() {
        assert_eq!(wsl_target(r"\\?\C:\Users\me\repo"), None);
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

    // Fixtures below use simplified placeholder hashes ("hashH"/"hashI"/...)
    // rather than real 40-hex-char shas — only the FIELD COUNT/POSITION and
    // NUL placement matter to the parser, and THOSE were empirically
    // verified byte-for-byte (`od -c`) against real `git status
    // --porcelain=v2 -z` output for each of the three record shapes below
    // (an ordinary staged-add + unstaged-delete + untracked file; a staged
    // rename; a merge conflict) — see parse_status_porcelain_v2's own doc
    // comment.

    #[test]
    fn parses_ordinary_staged_unstaged_and_untracked() {
        let raw = "1 A. N... 000000 100644 100644 hashH hashI new-name.txt\0\
                    1 .D N... 100644 100644 000000 hashH hashI old-name.txt\0\
                    ? new-file.txt\0";
        let entries = parse_status_porcelain_v2(raw);
        assert_eq!(entries.len(), 3);
        match &entries[0] {
            StatusEntry::Change { path, orig_path, staged, unstaged } => {
                assert_eq!(path, "new-name.txt");
                assert_eq!(orig_path, &None);
                assert_eq!(staged, &Some('A'));
                assert_eq!(unstaged, &None);
            }
            _ => panic!("expected a Change entry"),
        }
        match &entries[1] {
            StatusEntry::Change { path, staged, unstaged, .. } => {
                assert_eq!(path, "old-name.txt");
                assert_eq!(staged, &None);
                assert_eq!(unstaged, &Some('D'));
            }
            _ => panic!("expected a Change entry"),
        }
        match &entries[2] {
            StatusEntry::Untracked { path } => assert_eq!(path, "new-file.txt"),
            _ => panic!("expected an Untracked entry"),
        }
    }

    #[test]
    fn parses_a_staged_rename_including_its_separately_nul_terminated_orig_path() {
        let raw = "2 R. N... 100644 100644 100644 hashH hashI R100 renamed.txt\0big.txt\0";
        let entries = parse_status_porcelain_v2(raw);
        assert_eq!(entries.len(), 1);
        match &entries[0] {
            StatusEntry::Change { path, orig_path, staged, unstaged } => {
                assert_eq!(path, "renamed.txt");
                assert_eq!(orig_path.as_deref(), Some("big.txt"));
                assert_eq!(staged, &Some('R'));
                assert_eq!(unstaged, &None);
            }
            _ => panic!("expected a Change entry"),
        }
    }

    #[test]
    fn parses_a_merge_conflict_as_unmerged() {
        let raw = "u UU N... 100644 100644 100644 100644 hash1 hash2 hash3 f.txt\0";
        let entries = parse_status_porcelain_v2(raw);
        assert_eq!(entries.len(), 1);
        match &entries[0] {
            StatusEntry::Unmerged { path } => assert_eq!(path, "f.txt"),
            _ => panic!("expected an Unmerged entry"),
        }
    }

    #[test]
    fn a_copy_folds_into_the_same_r_status_a_rename_uses() {
        // This app's own status vocabulary has no separate "copied" code —
        // see map_status_char's own doc comment.
        let raw = "2 C. N... 100644 100644 100644 hashH hashI C100 copy.txt\0original.txt\0";
        let entries = parse_status_porcelain_v2(raw);
        match &entries[0] {
            StatusEntry::Change { staged, .. } => assert_eq!(staged, &Some('R')),
            _ => panic!("expected a Change entry"),
        }
    }

    #[test]
    fn empty_input_parses_to_no_entries() {
        assert!(parse_status_porcelain_v2("").is_empty());
    }

    #[test]
    fn parse_ahead_behind_count_reads_two_whitespace_separated_integers_in_order() {
        assert_eq!(parse_ahead_behind_count("2\t0\n"), Some((2, 0)));
        assert_eq!(parse_ahead_behind_count("0 5"), Some((0, 5)));
        assert_eq!(parse_ahead_behind_count("  12   34  "), Some((12, 34)));
    }

    #[test]
    fn parse_ahead_behind_count_rejects_anything_that_isnt_exactly_two_integers() {
        assert_eq!(parse_ahead_behind_count(""), None);
        assert_eq!(parse_ahead_behind_count("3"), None);
        assert_eq!(parse_ahead_behind_count("not a number 4"), None);
    }
}
