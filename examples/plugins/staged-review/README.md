# Staged Review

A small pre-commit review kit: three checks over what you have **staged**,
gathered in a **panel**, with a **Tama skin** that gives the reviewer its own
voice. It is the example for the two manifest surfaces the other examples don't
touch — `panels` and `tama` — and for the `staged` command context.

**Needs GitCat 1.4.1 or later.** The `staged` command context it is built on
first shipped in 1.4.1. The copy published to the
[plugin index](https://github.com/zangjiucheng/gitcat-plugins) declares that
floor (`minGitcatVersion`), so an older GitCat refuses to install it with a
clear message instead of installing commands that never get a file list.

## What it shows

- **`"context": "staged"`** on every command. A staged command needs no
  selection: GitCat reads the staged paths when you run it and fills
  **`{files}`** with them, each path quoted as its own argument. With nothing
  staged the command is not run and Tama tells you so, instead of running with
  an empty `{files}`.
- **A declarative panel** (`panels`). The panel `review` opens from ⌘K as
  **Staged review** and uses all four widget types:

  | Widget | Here |
  | ------ | ---- |
  | `heading` | "Before you commit", "Leftovers" |
  | `text` | One line of explanation |
  | `command-output` | Shows the stdout of `staged-summary` and `whitespace-check` inline. Nothing runs when the panel opens; press **Re-run** to run one. |
  | `button` | Runs `todo-scan`; its result comes back through Tama like a ⌘K command |

  A `button` / `command-output` can only name a command declared **in the same
  plugin**. A dangling name is rejected at install.
- **A Tama skin** (`tama`) with **no pose art**: `poses` is empty, so every
  pose keeps Tama's own portrait. The skin only lowers the voice
  (`voicePitch: 0.9`) and adds an `applied` line Tama says when you pick it in
  **Settings → Tama → Skin**. To make it a full character, add pose keys
  (`hero`, `curious`, `thinking`, …) pointing at `.webp`/`.png` files inside
  this folder.

| Command | Runs |
| ------- | ---- |
| `staged-summary` | `git diff --cached --stat` |
| `whitespace-check` | `git diff --cached --check`, and an `ok` Tama reaction when it is clean |
| `todo-scan` | `git grep --cached -n -E "TODO\|FIXME" -- {files}`, and an `ok` Tama reaction when nothing matches |

`todo-scan` searches the **staged** content of each file (`--cached`), so an
unstaged edit doesn't count. The `--` before `{files}` keeps a file whose name
starts with `-` from being read as an option.

## Install

**Tools ▸ Plugins…** (or ⌘K → "Plugins") → **Install from file…**, then pick
this folder's `plugin.json`. GitCat shows every command it runs before you
confirm. The three commands and the **Staged review** panel appear in ⌘K
straight away.

## Windows note

All three lines work unchanged under `cmd.exe` as well as `sh`. They call only
`git` and `echo`, use `"double quotes"` (which mean the same in both shells),
and chain with `&&` / `||`. On Windows GitCat double-quotes each `{files}` path
for `cmd`, so `my file.txt` is still one argument. That's why `todo-scan` uses
`git grep` rather than `grep`, which doesn't ship with Windows.

> **Note:** like every plugin command, these need an **open repository**.
