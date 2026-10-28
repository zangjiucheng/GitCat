//! Argument policy for the Luau sandbox's `git()` host function — the only
//! process a sandboxed plugin script can start.
//!
//! `git()` passes LITERAL argv to `git` (no shell), so there is no shell to
//! inject into. But git ITSELF is a capable program: many of its subcommands
//! and options run other programs or touch paths outside the repository. An
//! earlier guard only rejected a handful of git-level options (`-C`, `-c`, …)
//! and let every subcommand through, which left these escapes open:
//!
//!   * aliases — `git config alias.x '!sh …'` then `git({'x'})` runs a shell;
//!   * config writes that later run a program — `core.fsmonitor`,
//!     `core.hooksPath`, `core.sshCommand`, `core.pager`, `core.editor`,
//!     `diff.external`, `*.textconv`, `filter.*`, `credential.helper`,
//!     `gpg.program`, … (any `config` write, plus `remote add` with an `ext::`
//!     URL, `submodule`, `worktree`, `maintenance register`);
//!   * options that run a program — `--upload-pack`/`--receive-pack`/`--exec`
//!     (fetch/pull/clone/ls-remote/push/archive), `rebase --exec`/`-x`,
//!     `grep -O`/`--open-files-in-pager`, `--ext-diff`, `-s <custom strategy>`;
//!   * subcommands that run a program — `submodule foreach`, `bisect run`,
//!     `filter-branch`, `difftool`/`mergetool`, `help` (browser), `instaweb`,
//!     and `<any subcommand> --help`, which git rewrites into `git help <sub>`
//!     (man viewer / browser);
//!   * writes/reads outside the repo — `--output`, `format-patch -o` (and
//!     format-patch without a leading `--stdout`), `diff --no-index` (also
//!     implied by an out-of-tree path), `--file`, `--template`,
//!     `--pathspec-from-file`, `blame --contents`, `--orderfile`/`-O`,
//!     `format-patch --signature-file`/`--description-file`, `grep -f`,
//!     `ls-files -X`/`--exclude-from`;
//!   * safety-data destruction — `reflog expire/delete`, `gc`, `prune`,
//!     `update-ref -d refs/gitgui/backup/…` (Undo's own backups).
//!
//! So [`check_git_args`] is an ALLOWLIST, not a blocklist:
//!
//!   1. git-level options (before the subcommand) must be in
//!      [`ALLOWED_GLOBAL_OPTS`] — `-C`/`-c`/`--git-dir`/`--work-tree`/
//!      `--config-env`/`--exec-path`/`--namespace`/`-p`/… are all refused.
//!   2. the subcommand must be in [`READ_ONLY_SUBCOMMANDS`] or
//!      [`MUTATING_SUBCOMMANDS`], or be one of the few mixed ones classified per
//!      call (`branch`, `tag`, `stash`, `notes`, `reflog`, `config`). Anything
//!      else — every alias, every network command, every external `git-*`
//!      helper — is refused. git never lets an alias shadow a built-in, so an
//!      allowlisted name always runs the built-in.
//!   3. a mutating call is refused unless the command/hook declared
//!      `"mutates": true` — that is what makes the dispatcher take the safety
//!      snapshot first, so the change is covered by Undo.
//!   4. every argument after the subcommand is screened for the escape options
//!      above, matching git's own spellings: `--opt=value`, a unique
//!      abbreviation (`--upload-p`, `--outp` — parse-options accepts those), and
//!      short options inside a bundle (`-ix` for `rebase -i -x`).
//!
//! Screening deliberately does NOT stop at `--`. A `--` can be the VALUE of a
//! preceding option (`log --grep -- --output=/tmp/x` makes `--output` a real
//! option again), and we can't know every option's arity, so everything is
//! screened. The cost is that a pathspec spelled exactly like a forbidden option
//! must be written as `./--output` or `:(literal)--output`.
//!
//! Config git READS is the user's own (`config` writes are refused, so a script
//! can't plant any): `filter.*` (git-lfs), `gpg.program` and textconv drivers
//! stay in effect, because overriding them would break legitimate use.
//!
//! Hooks are the exception: [`harden_command`] turns them OFF for every call.
//! A `mutates` handler can write a file with arbitrary content anywhere in the
//! work tree (`notes add -m <text>` makes the blob, `restore --source=<notes
//! ref>` + `mv` places it, `add --chmod=+x` makes it executable), and with a
//! `core.hooksPath` inside the work tree (husky's `.husky/_`, `.githooks`) the
//! next allowed `git commit` would run that file. Disabling hooks for the
//! plugin's own calls closes that; plugin commits behave like `--no-verify`.

use std::process::Command;

/// git-level options a script may pass BEFORE the subcommand. Every one is a
/// pure behavior toggle; anything that names a path, a config value, or a pager
/// (`-C`, `-c`, `--git-dir`, `--work-tree`, `--config-env`, `--exec-path`,
/// `--namespace`, `--super-prefix`, `-p`/`--paginate`, `--help`, …) is refused.
pub const ALLOWED_GLOBAL_OPTS: &[&str] = &[
    "--version",
    "--no-pager",
    "-P",
    "--literal-pathspecs",
    "--glob-pathspecs",
    "--noglob-pathspecs",
    "--icase-pathspecs",
    "--no-optional-locks",
    "--no-replace-objects",
];

/// Built-ins that only read the repository. Allowed for every plugin.
/// (`format-patch` additionally requires `--stdout`, see [`check_git_args`].)
pub const READ_ONLY_SUBCOMMANDS: &[&str] = &[
    "log",
    "show",
    "rev-parse",
    "rev-list",
    "status",
    "diff",
    "diff-tree",
    "diff-index",
    "diff-files",
    "range-diff",
    "whatchanged",
    "ls-files",
    "ls-tree",
    "cat-file",
    "blame",
    "shortlog",
    "describe",
    "name-rev",
    "for-each-ref",
    "show-ref",
    "show-branch",
    "merge-base",
    "cherry",
    "grep",
    "count-objects",
    "check-ignore",
    "check-attr",
    "check-ref-format",
    "format-patch",
    "version",
];

/// Built-ins that change the repository. Allowed only for a command/hook that
/// declared `"mutates": true` (so the dispatcher snapshots first). Deliberately
/// absent: anything that can't be undone or that destroys Undo's own data
/// (`clean`, `gc`, `prune`, `update-ref`, `reflog expire`), and anything that
/// writes config or reaches the network (`remote`, `submodule`, `worktree`,
/// `fetch`, `pull`, `push`, `clone`, …) — use a shell `run` command for those.
pub const MUTATING_SUBCOMMANDS: &[&str] = &[
    "add",
    "rm",
    "mv",
    "restore",
    "reset",
    "checkout",
    "switch",
    "commit",
    "merge",
    "cherry-pick",
    "revert",
    "rebase",
];

/// Long options refused after ANY subcommand (exact, `=value`, or a unique
/// abbreviation git would expand to one of these).
const FORBIDDEN_LONG_OPTS: &[&str] = &[
    // write a file anywhere
    "--output",
    "--output-directory",
    // run a program
    "--exec",
    "--exec-path",
    "--ext-diff",
    "--open-files-in-pager",
    "--upload-pack",
    "--receive-pack",
    "--config-env",
    // read a file / tree outside the repository
    "--no-index",
    "--file",
    "--template",
    "--pathspec-from-file",
    "--contents",
    "--ignore-revs-file",
    "--orderfile",
    "--signature-file",
    "--description-file",
    "--exclude-from",
    "--exclude-per-directory",
    // `git <sub> --help` becomes `git help <sub>`, which starts the configured
    // man viewer or (Git for Windows' default help.format=html) a browser.
    "--help",
    // undoes format-patch's required `--stdout`, so it writes patch files
    "--no-stdout",
];

/// Merge strategies git ships. A custom `-s foo` makes git exec `git-merge-foo`
/// from `PATH`, so only these are accepted.
const BUILTIN_STRATEGIES: &[&str] = &["ort", "recursive", "resolve", "octopus", "ours", "subtree"];

/// Per-subcommand short options: `forbidden` are refused even inside a bundle;
/// `takes_value` are the ones whose value may be stuck on (`-mmsg`), so scanning
/// a bundle stops there. A value-taking letter missing from `takes_value` only
/// makes the scan stricter (a false refusal), never looser.
struct ShortRules {
    forbidden: &'static str,
    takes_value: &'static str,
}

fn short_rules(sub: &str) -> ShortRules {
    let (forbidden, takes_value) = match sub {
        "rebase" => ("x", "sXCS"),
        // `-O` opens files in a pager; `-f <file>` reads patterns from any path.
        "grep" => ("Of", "eABCm"),
        // `-O<file>` is `--orderfile`; the rest are the diff options' stuck values.
        "format-patch" => ("oO", "vUMCBlSGIX"),
        "diff" | "diff-tree" | "diff-index" | "diff-files" | "log" | "show" | "whatchanged" | "range-diff"
        | "shortlog" => ("O", "UMCBlSGILXn"),
        "stash" => ("O", "UMCBlSGILXm"),
        // `-X <file>` is `--exclude-from`.
        "ls-files" => ("X", "x"),
        "commit" => ("Ft", "mcCSu"),
        "tag" => ("F", "mun"),
        "merge" => ("F", "msXS"),
        "notes" => ("F", "mcC"),
        "blame" => ("S", "LMC"),
        "config" => ("ef", ""),
        _ => ("", ""),
    };
    ShortRules { forbidden, takes_value }
}

/// What a call is allowed to do, once [`check_git_args`] accepts it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitCallKind {
    ReadOnly,
    Mutating,
}

/// Real git options that happen to be a strict prefix of a forbidden one. git
/// picks an exact match over an abbreviation, so these are NOT abbreviations.
const EXACT_OPTS_NOT_ABBREVIATIONS: &[&str] = &["--ignore-rev", "--exclude", "--signature"];

/// True if `arg` is the long option `opt`, as `--opt`, `--opt=value`, or an
/// abbreviation git's parse-options would expand to `opt` (`--upload-p`).
fn long_opt_matches(arg: &str, opt: &str) -> bool {
    if !arg.starts_with("--") {
        return false;
    }
    let name = arg.split('=').next().unwrap_or(arg);
    name == opt || (name.len() > 2 && opt.starts_with(name) && !EXACT_OPTS_NOT_ABBREVIATIONS.contains(&name))
}

fn is_short_bundle(arg: &str) -> bool {
    arg.len() > 1 && arg.starts_with('-') && !arg.starts_with("--")
}

/// The value of `opt` at `args[i]`, inline (`--opt=v`, or the rest of a short
/// bundle) or as the next argument.
fn option_value<'a>(args: &'a [String], i: usize, inline: Option<&'a str>) -> Option<&'a str> {
    match inline {
        Some(v) if !v.is_empty() => Some(v),
        _ => args.get(i + 1).map(String::as_str),
    }
}

/// An absolute path (`/x`, `\x`, `C:\x`, `C:/x`), a Windows drive-relative one
/// (`C:x` — git's `has_dos_drive_prefix` treats it as absolute, resolved against
/// that drive's current directory), or one with a `..` component — i.e. a path
/// that can point outside the work tree.
fn is_outside_path(arg: &str) -> bool {
    let b = arg.as_bytes();
    let drive = b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
    arg.starts_with('/') || arg.starts_with('\\') || drive || arg.split(['/', '\\']).any(|seg| seg == "..")
}

fn refuse(msg: String) -> Result<GitCallKind, String> {
    Err(format!("git(): {msg}"))
}

/// Decide whether a sandboxed `git(argv)` call may run. `mutates` is what the
/// plugin declared on the command/hook. `Ok` says what kind of call it is; `Err`
/// is the message the script sees (a Lua runtime error).
pub fn check_git_args(argv: &[String], mutates: bool) -> Result<GitCallKind, String> {
    // 1. git-level options: allowlist only.
    let mut i = 0;
    while i < argv.len() && argv[i].starts_with('-') {
        let a = argv[i].as_str();
        if !ALLOWED_GLOBAL_OPTS.contains(&a) {
            return refuse(format!(
                "the git-level option {a:?} is not allowed — it could escape the repository or run another program"
            ));
        }
        i += 1;
    }
    let Some(sub) = argv.get(i).map(String::as_str) else {
        return Ok(GitCallKind::ReadOnly); // e.g. `git --version`
    };
    let rest = &argv[i + 1..];

    // 2. classify the subcommand (allowlist; aliases and everything else refused).
    let kind = classify(sub, rest)?;
    if kind == GitCallKind::Mutating && !mutates {
        return refuse(format!(
            "`git {sub}` changes the repository — declare \"mutates\": true on this command/hook so GitCat can snapshot it for Undo"
        ));
    }

    // 3. screen every argument after the subcommand (including after `--`).
    screen_args(sub, rest)?;
    Ok(kind)
}

fn classify(sub: &str, rest: &[String]) -> Result<GitCallKind, String> {
    let positionals = || rest.iter().filter(|a| !a.starts_with('-'));
    let options = || rest.iter().filter(|a| a.starts_with('-'));
    if READ_ONLY_SUBCOMMANDS.contains(&sub) {
        // `--stdout` must come FIRST: anywhere else it could be the value of the
        // option before it (`--to --stdout` is a recipient, not stdout) and git
        // would write 0001-*.patch files. `--no-stdout` is screened as an
        // escape option.
        if sub == "format-patch" && rest.first().map(String::as_str) != Some("--stdout") {
            return refuse(
                "`git format-patch` is only allowed with --stdout as its first argument (it would otherwise write patch files)".into(),
            );
        }
        return Ok(GitCallKind::ReadOnly);
    }
    if MUTATING_SUBCOMMANDS.contains(&sub) {
        return Ok(GitCallKind::Mutating);
    }
    match sub {
        // Listing forms are reads; any other option or a bare name creates/
        // deletes/renames. An unrecognized option counts as a write (strict).
        "branch" | "tag" => {
            let (read_opts, list_opts): (&[&str], &[&str]) = if sub == "branch" {
                (
                    &[
                        "--list", "-l", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current",
                        "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format",
                        "--color", "--no-color", "--column", "--no-column", "-i", "--ignore-case", "--omit-empty",
                        "--abbrev", "--no-abbrev",
                    ],
                    &["--list", "-l", "-v", "-vv", "--verbose", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"],
                )
            } else {
                (
                    &[
                        "--list", "-l", "-n", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at",
                        "--sort", "--format", "--color", "--no-color", "--column", "--no-column", "-i",
                        "--ignore-case", "--omit-empty",
                    ],
                    &["--list", "-l", "-n", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"],
                )
            };
            let opt_name = |a: &str| -> String {
                let n = a.split('=').next().unwrap_or(a);
                // `-n5` (tag) is `-n` with a stuck value.
                if sub == "tag" && n.starts_with("-n") && n[2..].bytes().all(|c| c.is_ascii_digit()) {
                    "-n".to_string()
                } else {
                    n.to_string()
                }
            };
            let all_read = options().all(|a| read_opts.contains(&opt_name(a).as_str()));
            let listing = options().any(|a| list_opts.contains(&opt_name(a).as_str()));
            Ok(if all_read && (listing || positionals().next().is_none()) {
                GitCallKind::ReadOnly
            } else {
                GitCallKind::Mutating
            })
        }
        // `git stash` dispatches on its first argument; anything but list/show
        // (including no argument at all = push) writes.
        "stash" => Ok(match rest.first().map(String::as_str) {
            Some("list") | Some("show") => GitCallKind::ReadOnly,
            _ => GitCallKind::Mutating,
        }),
        "notes" => {
            const WRITES: &[&str] = &["add", "append", "copy", "edit", "merge", "remove", "prune"];
            Ok(if positionals().any(|a| WRITES.contains(&a.as_str())) {
                GitCallKind::Mutating
            } else {
                GitCallKind::ReadOnly
            })
        }
        // Reading the reflog is fine; expiring/deleting it destroys exactly the
        // recovery data GitCat's Undo relies on, so that is refused outright.
        "reflog" => {
            if positionals().any(|a| matches!(a.as_str(), "expire" | "delete" | "drop")) {
                return refuse("`git reflog expire/delete/drop` is not allowed — it destroys recovery data".into());
            }
            Ok(GitCallKind::ReadOnly)
        }
        // Reads only. ANY config write is refused even with `mutates`: config
        // is how a value becomes a program git runs (alias.*, core.fsmonitor,
        // core.hooksPath, core.sshCommand, filter.*, credential.helper, …).
        "config" => {
            const WRITE_WORDS: &[&str] = &["set", "unset", "rename-section", "remove-section", "edit"];
            const WRITE_OPTS: &[&str] = &[
                "--add", "--unset", "--unset-all", "--replace-all", "--rename-section", "--remove-section", "--edit",
                "--file",
            ];
            const READ_OPTS: &[&str] = &[
                "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool", "--list", "-l",
            ];
            let first = rest.first().map(String::as_str);
            let writes = first.is_some_and(|f| WRITE_WORDS.contains(&f))
                || options().any(|a| WRITE_OPTS.iter().any(|w| long_opt_matches(a, w)));
            let reads = matches!(first, Some("get") | Some("list")) || options().any(|a| READ_OPTS.contains(&a.as_str()));
            if writes || !reads {
                return refuse(
                    "`git config` may only read (--get/--get-all/--get-regexp/--list, or `config get`/`config list`) — config writes are refused".into(),
                );
            }
            Ok(GitCallKind::ReadOnly)
        }
        _ => refuse(format!(
            "the subcommand {sub:?} is not allowed in a Luau plugin (aliases, network, config-writing and program-running subcommands are refused) — use a shell `run` command for it"
        )),
    }
}

fn screen_args(sub: &str, rest: &[String]) -> Result<(), String> {
    let rules = short_rules(sub);
    let strategy_short = matches!(sub, "merge" | "rebase");
    let strategy_long = matches!(sub, "merge" | "rebase" | "cherry-pick" | "revert");
    let check_strategy = |v: Option<&str>| -> Result<(), String> {
        match v {
            Some(s) if BUILTIN_STRATEGIES.contains(&s) => Ok(()),
            other => Err(format!(
                "git(): merge strategy {:?} is not allowed — only git's built-in strategies ({}) can be used",
                other.unwrap_or(""),
                BUILTIN_STRATEGIES.join(", ")
            )),
        }
    };
    for (i, a) in rest.iter().enumerate() {
        let arg = a.as_str();
        if let Some(opt) = FORBIDDEN_LONG_OPTS.iter().find(|f| long_opt_matches(arg, f)) {
            return Err(format!(
                "git(): the option {arg:?} ({opt}) is not allowed — it could run another program or reach outside the repository"
            ));
        }
        if strategy_long && long_opt_matches(arg, "--strategy") {
            check_strategy(option_value(rest, i, arg.split_once('=').map(|(_, v)| v)))?;
        }
        if is_short_bundle(arg) {
            for (j, c) in arg[1..].char_indices() {
                if rules.forbidden.contains(c) {
                    return Err(format!("git(): the option -{c} (in {arg:?}) is not allowed for `git {sub}`"));
                }
                if strategy_short && c == 's' {
                    check_strategy(option_value(rest, i, Some(&arg[1 + j + 1..])))?;
                    break;
                }
                if rules.takes_value.contains(c) {
                    break; // the rest of the bundle is this option's value
                }
            }
        }
        // `git diff <path> <path>` silently becomes `--no-index` when a path is
        // outside the work tree, reading arbitrary files.
        if sub == "diff" && !arg.starts_with('-') && is_outside_path(arg) {
            return Err(format!("git(): `git diff` may not name a path outside the repository ({arg:?})"));
        }
    }
    Ok(())
}

/// `core.hooksPath` for every sandboxed call: a directory nothing — least of
/// all the plugin, which can only write inside the work tree — can create. On
/// Windows `NUL` is a reserved device name, so `NUL\<hook>` never exists (a
/// relative hooksPath resolves against the work tree, and Windows refuses a
/// `NUL` directory anywhere). Elsewhere `/dev/null/<hook>` fails with ENOTDIR.
/// (An EMPTY value is avoided: git documents no meaning for it.)
#[cfg(windows)]
const NO_HOOKS_DIR: &str = "NUL";
#[cfg(not(windows))]
const NO_HOOKS_DIR: &str = LINUX_NO_HOOKS_DIR;

/// [`NO_HOOKS_DIR`] for a git running in a WSL distro, whatever GitCat itself
/// runs on. It must NOT be the Windows `NUL`: to Linux git that is an ordinary
/// relative directory, so a `mutates` plugin could check out `NUL/pre-commit`
/// and have it run.
pub const LINUX_NO_HOOKS_DIR: &str = "/dev/null";

/// The git-level options [`harden_command`] puts before the subcommand, for a
/// git whose "no hooks" directory is `no_hooks_dir`. Exposed so a command that
/// isn't a plain local `Command` (a WSL-routed one) gets exactly the same.
pub fn harden_args(no_hooks_dir: &str) -> [String; 5] {
    ["--no-pager".into(), "-c".into(), "core.fsmonitor=false".into(), "-c".into(), format!("core.hooksPath={no_hooks_dir}")]
}

/// The environment [`harden_command`] sets (see its doc for each).
pub const HARDEN_ENVS: [(&str, &str); 4] =
    [("GIT_PAGER", "cat"), ("GIT_EDITOR", ":"), ("GIT_SEQUENCE_EDITOR", ":"), ("GIT_TERMINAL_PROMPT", "0")];

/// Apply the invocation-time hardening every sandboxed `git()` call gets, on top
/// of the argument policy. Nothing here changes what a legitimate read or
/// mutation does:
///
///   * `--no-pager` and `GIT_PAGER=cat` — never start `core.pager`;
///   * `GIT_EDITOR=:` / `GIT_SEQUENCE_EDITOR=:` — git skips the editor for `:`,
///     so `commit` without `-m`, `rebase -i`, `merge --edit` never launch
///     `core.editor` (or hang waiting on one);
///   * `-c core.fsmonitor=false` — never start a configured fsmonitor hook
///     (it only ever speeds up `status`);
///   * `-c core.hooksPath=<a directory that cannot exist>` — never run a hook
///     (see the module doc for why); git finds no hook there and stays quiet;
///   * `GIT_TERMINAL_PROMPT=0` — never block on a credential prompt;
///   * inherited `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/… are removed so the
///     `-C <repo>` target is exactly what applies, as are the variables that
///     inject config or programs (`GIT_CONFIG`, `GIT_CONFIG_PARAMETERS`,
///     `GIT_CONFIG_COUNT`/`_KEY_n`/`_VALUE_n`, `GIT_EXTERNAL_DIFF`, `GIT_SSH*`,
///     `GIT_PROXY_COMMAND`). `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`/
///     `GIT_CONFIG_NOSYSTEM` and `GIT_EXEC_PATH` are KEPT: they only choose
///     which of the user's own config files / which git install applies, the
///     same as in their terminal, and a script can't set environment variables.
///
/// `filter.*` (git-lfs), signing, and textconv drivers come from the user's own
/// config and are left alone (see the module doc).
pub fn harden_command(cmd: &mut Command) {
    cmd.args(harden_args(NO_HOOKS_DIR));
    for (k, v) in HARDEN_ENVS {
        cmd.env(k, v);
    }
    for var in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
        "GIT_CONFIG",
        "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG_COUNT",
        "GIT_EXTERNAL_DIFF",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_PROXY_COMMAND",
    ] {
        cmd.env_remove(var);
    }
    for (k, _) in std::env::vars_os() {
        if let Some(k) = k.to_str() {
            if k.starts_with("GIT_CONFIG_KEY_") || k.starts_with("GIT_CONFIG_VALUE_") {
                cmd.env_remove(k);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }
    fn ok(a: &[&str], mutates: bool) -> GitCallKind {
        check_git_args(&args(a), mutates).unwrap_or_else(|e| panic!("{a:?} should be allowed: {e}"))
    }
    fn refused(a: &[&str], mutates: bool) {
        assert!(check_git_args(&args(a), mutates).is_err(), "{a:?} must be refused (mutates={mutates})");
    }

    // ---- legitimate use keeps working ----------------------------------------

    #[test]
    fn everyday_reads_are_allowed_without_mutates() {
        for a in [
            &["--version"][..],
            &["log", "-1", "--format=%s", "HEAD"],
            &["log", "--oneline", "-20", "--", "src/"],
            &["rev-parse", "--short", "HEAD"],
            &["rev-parse", "--git-dir"],
            &["rev-parse", "--is-inside-work-tree"],
            &["status", "--porcelain=v1"],
            &["diff", "--stat", "main..feature"],
            &["diff", "HEAD~1", "HEAD", "--", "a.txt"],
            &["diff", "--output-indicator-new=+"],
            &["show", "--stat", "HEAD"],
            &["show", "--no-ext-diff", "HEAD"],
            &["grep", "-n", "-e", "TODO"],
            &["blame", "-L", "1,5", "f.txt"],
            &["blame", "--ignore-rev", "abc123", "f.txt"],
            &["for-each-ref", "--format=%(refname)", "refs/heads"],
            &["branch", "--show-current"],
            &["branch", "-a", "-v"],
            &["branch"],
            &["branch", "--list", "feat/*"],
            &["branch", "--contains", "HEAD"],
            &["tag", "-l", "v*"],
            &["tag", "-n5"],
            &["tag"],
            &["stash", "list"],
            &["notes", "show", "HEAD"],
            &["reflog", "-5"],
            &["config", "--get", "user.name"],
            &["config", "get", "user.email"],
            &["config", "--list", "--show-origin"],
            &["format-patch", "--stdout", "-1", "HEAD"],
            &["--no-pager", "--literal-pathspecs", "log", "-1"],
        ] {
            assert_eq!(ok(a, false), GitCallKind::ReadOnly, "{a:?}");
        }
    }

    #[test]
    fn mutations_need_mutates_and_are_allowed_with_it() {
        for a in [
            &["commit", "-m", "msg"][..],
            &["commit", "-mfix typo"],
            &["add", "-A"],
            &["reset", "--hard", "HEAD~1"],
            &["checkout", "-b", "x"],
            &["switch", "main"],
            &["restore", "--staged", "f"],
            &["merge", "--no-ff", "-s", "ort", "feature"],
            &["merge", "-Xours", "feature"],
            &["rebase", "-i", "main"],
            &["rebase", "--strategy=recursive", "-Xtheirs", "main"],
            &["cherry-pick", "-x", "abc123"],
            &["revert", "--no-edit", "HEAD"],
            &["branch", "new-branch"],
            &["branch", "-D", "old"],
            &["tag", "v1.0"],
            &["tag", "-a", "v1", "-m", "release"],
            &["stash"],
            &["stash", "push", "-m", "wip"],
            &["notes", "add", "-m", "n", "HEAD"],
        ] {
            refused(a, false);
            assert_eq!(ok(a, true), GitCallKind::Mutating, "{a:?}");
        }
    }

    #[test]
    fn options_after_double_dash_are_still_screened_but_plain_paths_pass() {
        // `--` might be the VALUE of `--grep`, which would make `--output` live again.
        refused(&["log", "--grep", "--", "--output=/tmp/x"], false);
        // Normal pathspecs after `--` are fine; a lookalike can be spelled ./--output.
        ok(&["log", "--", "./--output", "src/main.rs"], false);
    }

    // ---- git-level escape options --------------------------------------------

    #[test]
    fn git_level_options_outside_the_allowlist_are_refused() {
        for bad in [
            "-C", "-c", "--git-dir=/x", "--git-dir", "--work-tree=/y", "--exec-path=/z", "--exec-path", "--config-env=x=Y",
            "--namespace=n", "--super-prefix=x", "-p", "--paginate", "--help", "--list-cmds=main", "--bare",
        ] {
            refused(&[bad, "log"], true);
        }
        refused(&["-c", "alias.x=!sh -c id", "x"], true);
        refused(&["-c", "core.pager=sh -c id", "log"], true);
    }

    // ---- aliases / non-allowlisted subcommands --------------------------------

    #[test]
    fn aliases_and_unlisted_subcommands_are_refused_even_with_mutates() {
        for sub in [
            "x", "co", "st", "lg", "fetch", "pull", "push", "clone", "ls-remote", "remote", "archive", "submodule",
            "bisect", "filter-branch", "filter-repo", "difftool", "mergetool", "help", "instaweb", "worktree", "gc",
            "prune", "repack", "maintenance", "update-ref", "symbolic-ref", "clean", "init", "apply", "am",
            "send-email", "daemon", "upload-pack", "receive-pack", "credential", "web--browse", "replace",
            "update-index", "fsck", "var", "LOG",
        ] {
            refused(&[sub], true);
        }
        refused(&["submodule", "foreach", "sh -c id"], true);
        refused(&["bisect", "run", "sh", "-c", "id"], true);
        refused(&["fetch", "--upload-pack=sh -c id", "origin"], true);
        refused(&["ls-remote", "--upload-pack", "sh -c id", "."], true);
        refused(&["clone", "-u", "sh -c id", ".", "/tmp/x"], true);
        refused(&["push", "--receive-pack=sh -c id", "origin"], true);
        refused(&["push", "--exec=sh -c id", "origin"], true);
        refused(&["archive", "--remote=.", "--exec=sh -c id", "HEAD"], true);
        refused(&["filter-branch", "--tree-filter", "id", "HEAD"], true);
    }

    // ---- config: reads only ---------------------------------------------------

    #[test]
    fn every_config_write_is_refused_even_with_mutates() {
        for a in [
            &["config", "alias.x", "!sh -c id"][..],
            &["config", "core.fsmonitor", "sh -c id"],
            &["config", "--add", "core.hooksPath", "/tmp"],
            &["config", "--get", "x", "--add", "core.sshCommand", "id"],
            &["config", "--replace-all", "core.pager", "id"],
            &["config", "--unse", "core.editor"],
            &["config", "set", "diff.external", "id"],
            &["config", "set", "diff.x.textconv", "id"],
            &["config", "filter.x.clean", "id"],
            &["config", "credential.helper", "!id"],
            &["config", "gpg.program", "id"],
            &["config", "--edit"],
            &["config", "-e"],
            &["config", "--get", "-e"],
            &["config", "--file=/etc/passwd", "--list"],
            &["config", "--fi", "/etc/passwd", "--list"],
            &["config", "-f", "/etc/passwd", "--list"],
            &["config", "-lf", "/etc/passwd"],
            &["config", "user.name"], // no explicit read action: refused (strict)
            &["config", "--rename-section", "a", "b"],
        ] {
            refused(a, true);
        }
    }

    // ---- program-running and outside-the-repo options --------------------------

    #[test]
    fn program_running_options_are_refused_in_every_spelling() {
        for a in [
            &["rebase", "--exec", "sh -c id", "main"][..],
            &["rebase", "--exec=sh -c id", "main"],
            &["rebase", "--exe=id", "main"],
            &["rebase", "-x", "id", "main"],
            &["rebase", "-xid", "main"],
            &["rebase", "-ix", "id", "main"],
            &["rebase", "-s", "evil", "main"],
            &["rebase", "-sevil", "main"],
            &["merge", "-s", "../../tmp/x", "feature"],
            &["merge", "--strategy=evil", "feature"],
            &["merge", "--strat", "evil", "feature"],
            &["cherry-pick", "--strategy", "evil", "abc"],
            &["diff", "--ext-diff"],
            &["log", "-p", "--ext-diff"],
            &["show", "--ext-d", "HEAD"],
            &["grep", "-O", "TODO"],
            &["grep", "-Osh", "TODO"],
            &["grep", "-nO", "TODO"],
            &["grep", "--open-files-in-pager=sh", "TODO"],
            &["grep", "--open", "TODO"],
        ] {
            refused(a, true);
        }
    }

    #[test]
    fn writes_and_reads_outside_the_repo_are_refused() {
        for a in [
            &["diff", "--output=/tmp/x"][..],
            &["log", "-p", "--output", "/tmp/x"],
            &["log", "-p", "--outp=/tmp/x"],
            &["format-patch", "-o", "/tmp", "-1"],
            &["format-patch", "--stdout", "-o/tmp"],
            &["format-patch", "--stdout", "--output-directory=/tmp"],
            &["format-patch", "-1"], // no --stdout: would write files
            &["diff", "--no-index", "/etc/passwd", "x"],
            &["diff", "--no-ind", "a", "b"],
            &["grep", "--no-index", "root", "/etc"],
            &["diff", "/etc/passwd", "/etc/hosts"],
            &["diff", "../outside.txt", "inside.txt"],
            &["diff", "C:\\Windows\\win.ini", "x"],
            &["diff", "HEAD", "--", "a/../../x"],
            &["blame", "--contents", "/etc/passwd", "f"],
            &["blame", "-S", "/tmp/revs", "f"],
            &["blame", "--ignore-revs-file=/tmp/x", "f"],
            &["commit", "-F", "/etc/passwd"],
            &["commit", "--file=/etc/passwd"],
            &["commit", "-t", "/etc/passwd"],
            &["commit", "--template=/etc/passwd"],
            &["commit", "-aF", "/etc/passwd"],
            &["add", "--pathspec-from-file=/tmp/list"],
            &["tag", "-a", "v1", "-F", "/etc/passwd"],
            &["log", "--orderfile=/tmp/x"],
        ] {
            refused(a, true);
        }
    }

    #[test]
    fn reflog_destruction_is_refused() {
        refused(&["reflog", "expire", "--expire=now", "--all"], true);
        refused(&["reflog", "delete", "HEAD@{0}"], true);
        refused(&["reflog", "drop"], true);
    }

    #[test]
    fn short_bundles_stop_at_a_value_taking_option() {
        // `-m` takes the rest of the bundle as its value, so `F` here is message text.
        assert_eq!(ok(&["commit", "-mFix the Foo"], true), GitCallKind::Mutating);
        // `-X` takes a value: `-Xsubtree=x` is not `-x`.
        assert_eq!(ok(&["rebase", "-Xsubtree=x", "main"], true), GitCallKind::Mutating);
        // `-e` takes the pattern, so `-eO` is the pattern "O", not `-O`.
        assert_eq!(ok(&["grep", "-eO"], false), GitCallKind::ReadOnly);
        // Pickaxe/-L values may contain an `O`; they are not `-O<orderfile>`.
        assert_eq!(ok(&["log", "-SOops"], false), GitCallKind::ReadOnly);
        assert_eq!(ok(&["log", "-L:Open:f.txt"], false), GitCallKind::ReadOnly);
        assert_eq!(ok(&["stash", "push", "-mOops"], true), GitCallKind::Mutating);
    }

    // ---- gaps found in review ---------------------------------------------------

    #[test]
    fn help_is_refused_after_any_subcommand() {
        // git.c rewrites `git log --help` into `git help log` (man viewer/browser).
        for a in [
            &["log", "--help"][..],
            &["status", "--help"],
            &["format-patch", "--stdout", "--help"],
            &["log", "--hel"],
            &["commit", "--help"],
        ] {
            refused(a, true);
        }
        // `-h` only prints the usage text, and `--help-all` likewise.
        ok(&["log", "-h"], false);
    }

    #[test]
    fn format_patch_cannot_read_files_outside_the_repo() {
        for a in [
            &["format-patch", "--stdout", "-1", "--signature-file=/etc/passwd"][..],
            &["format-patch", "--stdout", "-1", "--signature-file", "/etc/passwd"],
            &["format-patch", "--stdout", "-1", "--signature-f=/etc/passwd"],
            &["format-patch", "--stdout", "-1", "--cover-letter", "--description-file=/etc/passwd"],
            &["format-patch", "--stdout", "-1", "--desc", "/etc/passwd"],
        ] {
            refused(a, false);
        }
        // `--signature <text>` is a real option, not an abbreviation of --signature-file.
        ok(&["format-patch", "--stdout", "-1", "--signature", "bye"], false);
    }

    #[test]
    fn format_patch_stdout_must_be_real_and_first() {
        for a in [
            &["format-patch", "--to", "--stdout", "-1"][..], // --stdout is --to's value
            &["format-patch", "-1", "--stdout"],              // not first
            &["format-patch", "--stdout", "-1", "--no-stdout"],
            &["format-patch", "--stdout", "-1", "--no-std"],
        ] {
            refused(a, false);
        }
        ok(&["format-patch", "--stdout", "--to", "a@b", "-1"], false);
    }

    #[test]
    fn short_spellings_of_file_reading_options_are_refused() {
        for a in [
            &["diff", "-O/tmp/order", "HEAD"][..],
            &["diff", "-O", "/tmp/order"],
            &["log", "-p", "-O../order"],
            &["show", "-O/tmp/x", "HEAD"],
            &["diff-tree", "-p", "-O/tmp/x", "HEAD"],
            &["format-patch", "--stdout", "-1", "-O/tmp/x"],
            &["stash", "show", "-O/tmp/x"],
            &["grep", "-f", "/etc/passwd"],
            &["grep", "-nf/etc/passwd"],
            &["ls-files", "-X", "/etc/passwd"],
            &["ls-files", "-ioX/etc/passwd"],
            &["ls-files", "--exclude-from=/etc/passwd"],
            &["ls-files", "--exclude-f", "/etc/passwd"],
            &["ls-files", "--exclude-per-directory=../../x"],
        ] {
            refused(a, true);
        }
        // Real options that share a prefix with a refused one still work.
        ok(&["ls-files", "--exclude=*.o", "-o"], false);
        ok(&["log", "--exclude=refs/tags/*", "--all", "-1"], false);
    }

    #[test]
    fn windows_drive_relative_paths_count_as_outside_for_diff() {
        refused(&["diff", "C:secret.txt", "f.txt"], false);
        refused(&["diff", "d:x"], false);
    }

    #[test]
    fn outside_path_detection() {
        for p in [
            "/etc/passwd", "\\\\server\\share", "C:\\x", "c:/x", "C:secret.txt", "x:y", "..", "../x", "a/../../x", "a\\..\\x",
        ] {
            assert!(is_outside_path(p), "{p}");
        }
        for p in ["main..feature", "HEAD~1..HEAD", "a...b", "src/x.rs", "HEAD:path", "main:src/x", "..HEAD"] {
            assert!(!is_outside_path(p), "{p}");
        }
    }
}
