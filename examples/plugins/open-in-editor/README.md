# Open in Editor

External-tool commands that demonstrate the **placeholder grammar**.

## What it shows

- Two commands that shell out to a tool with a **placeholder** substituted in:
  - `Editor: Open repository in VS Code` — `code -- {repo}`, `context: "repo"`.
  - `Commit: Show selected commit (stat)` — `git show --stat {sha}`,
    `context: "commit"` (uses the sha of the commit selected in the graph).

## Placeholder grammar

A command's `run` template may contain these tokens; each expands to the
corresponding value from the current selection:

| token      | value                                             |
| ---------- | ------------------------------------------------- |
| `{sha}`    | selected commit id (needs `context: "commit"`)    |
| `{file}`   | a single selected file path                       |
| `{files}`  | several selected file paths (space-joined)        |
| `{diff}`   | diff text                                          |
| `{repo}`   | the repository path (also the working directory)  |
| `{branch}` | a branch name                                     |
| `{ref}`    | a full ref / tag / symbolic ref                   |

Every substituted value is **POSIX single-quoted** before it reaches the shell,
so a branch or file literally named `; rm -rf ~` or `$(whoami)` is delivered as
one inert literal string — it can never start a new command. A command with no
repository open is refused (the repo is both `{repo}` and the working
directory).

### Flag-injection: use `--`

Quoting stops shell-metacharacter injection but does **not** change argument
boundaries — an untrusted value that starts with `-` (a branch named
`--upload-pack=…`) is still handed to the tool as an *option*. Put a `--`
end-of-options separator before untrusted placeholders, as `open-repo` does
(`code -- {repo}`). `{sha}` here is a resolved commit id from the graph
selection, so `git show --stat {sha}` is safe as written.

## Requirements

`open-repo` needs the **`code`** CLI (VS Code's *Shell Command: Install 'code'
command in PATH*) on your PATH. Swap it for your editor if you use a different
one — e.g. `subl -- {repo}`, `idea -- {repo}`, `zed -- {repo}`. `show-commit`
only needs `git`.

## Install

Settings → **Plugins** → **Install plugin…**, pick this folder's `plugin.json`.
Both commands appear live in ⌘K.

## Windows note

These `run` lines are POSIX-shell one-liners. On Windows the executor uses
`cmd.exe` and does not interpret POSIX single-quoting the same way, so assume a
POSIX shell (Git-Bash / WSL) on PATH. In addition, `{diff}` — and any value
containing a `cmd.exe` metacharacter (`& | < > ^ % ! "`, CR/LF) — is **refused
fail-closed** on Windows; these two commands avoid `{diff}`, so they are fine as
long as the repo path and sha contain no such characters.

> **Note:** `show-commit` is `context: "commit"`, so it uses the sha of the
> **selected** commit. With nothing selected, `{sha}` expands to empty and the
> command falls back to `git show --stat` against `HEAD`.
