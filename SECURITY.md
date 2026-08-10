# Security Policy

Thank you for helping keep GitCat and its users safe.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Report privately through GitHub's built-in flow:

1. Go to the [**Security** tab](https://github.com/zangjiucheng/GitCat/security) of this repository.
2. Click **Report a vulnerability** to open a private advisory (this is only visible to you and the maintainer).

If you can't use GitHub's private reporting, email **git.jiucheng@gmail.com** with the subject line `GitCat security`.

Please include:

- The GitCat version (Help → About, or the app window title).
- Your OS and architecture (e.g. macOS 14 arm64, Windows 11 x64, Ubuntu 24.04 x64).
- A description of the issue and its impact.
- Step-by-step reproduction, and a proof of concept if you have one.

## What to expect

- **Acknowledgement** within 5 days.
- An initial **assessment** within 10 days, and regular updates while we work on a fix.
- Once a fix ships, we'll credit you in the release notes and the advisory unless you'd prefer to stay anonymous.

Please give us a reasonable window to release a fix before any public disclosure. We aim to resolve confirmed issues within 90 days.

## Scope

GitCat is a local desktop Git client. It runs Git operations against repositories you already have on disk and does **not** connect to any AI service or send your code anywhere. Areas of particular interest:

- Command/argument injection through crafted repository data (branch/tag/remote names, `.gitmodules`, submodule URLs, config values, file paths).
- Path traversal or writes outside the selected working tree.
- Anything that lets untrusted repository content execute code or escape the WebView (Tauri IPC surface, the Content-Security-Policy).
- Mishandling of credentials or the WSL command-routing path.

## Plugins

GitCat plugins are small declarative `plugin.json` manifests that contribute
**commands** (surfaced in the ⌘K palette / context menus) and **hooks** (run on
lifecycle events such as *repo opened* or *post-mutation*). Each declares a
`run` string that GitCat expands and executes.

**Trust boundary — a plugin runs code on your machine.** A plugin's `run` string
is user-authored shell text that GitCat executes on your computer, exactly like
a difftool/mergetool `cmd` or a commit-message command you configure. Installing
a plugin is trusting whoever wrote it, the same as trusting any shell script you
choose to run. GitCat contacts **no AI service and no network** on a plugin's
behalf; whatever a plugin does lives entirely inside its own `run` string and
runs with your user's privileges. Only install plugins you trust and have read.

Values GitCat substitutes into a `run` template — a branch/tag/ref name, a file
path, a repo path, diff content — come from the repository you have open, which a
malicious project can craft freely. GitCat single-quotes every substituted value
so the shell treats it as one inert literal (a branch literally named
`; rm -rf ~` cannot start a new command). Note the limits below.

**Undo coverage: declare `mutates`.** A command or hook that changes the
repository should set `"mutates": true`. When it does, GitCat takes a safety
snapshot **before** running it, so the change is covered by global Undo — the
same protection GitCat's own mutations get. A `mutates: false` action (the
default) is treated as read-only and is **not** snapshotted. Consequently, an
action that changes the repository but does **not** declare `mutates` runs
**outside Undo** and cannot be rolled back through GitCat. GitCat cannot infer
this from an opaque `run` string, so **plugin authors must set `mutates` on
anything that mutates the repo.** For a user-invoked command GitCat *fails
closed* — if the pre-mutation snapshot cannot be taken, the command does not run;
for a lifecycle hook (an observer that must not stall the event) a failed
snapshot causes that one hook to be logged and skipped.

**Windows quoting is fail-closed, not bulletproof.** GitCat's value-quoting is
POSIX single-quoting, which fully neutralizes untrusted values under the unix
shell (`sh -c`). Windows runs `cmd /C`, which does not honor that quoting, so on
Windows GitCat **refuses** to run a command whose substituted values contain a
`cmd.exe` metacharacter (`& | < > ^ % ! "`, or a newline) rather than risk
injection. This intentionally rejects some legitimate values (including most
`{diff}` content) on Windows until a bundled POSIX shell lands.

**Flag/argument injection is not covered by quoting.** Single-quoting stops
shell-metacharacter injection but does not change argument boundaries: an
untrusted value that begins with `-` (a branch named `--upload-pack=…`, a ref
`-n`) is still delivered to the invoked tool as an **option**. Plugin authors
should put a `--` end-of-options separator before untrusted placeholders (e.g.
`git checkout -- {branch}`); quoting alone cannot fix this generically.

**Environment inheritance.** A plugin subprocess inherits GitCat's full
environment; GitCat does not clear or curate it. This is acceptable under the
"you trust the plugin you installed" model, but note it if you keep secrets in
GitCat's environment.

## Supported versions

GitCat is pre-1.0; security fixes land in the latest release only. Please make sure you're on the newest version before reporting.

| Version | Supported |
| ------- | --------- |
| latest `0.9.x` | ✅ |
| older | ❌ |

> Tip: enable **Private vulnerability reporting** under *Settings → Code security and analysis* so the "Report a vulnerability" button above is available to everyone.
