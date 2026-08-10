# Hello Tama

The smallest useful GitCat plugin: one palette command that prints a greeting
and makes Tama react.

## What it shows

- A **command** with `context: "none"` (no selection needed) and
  `placement: "palette"` (appears in the ⌘K command palette).
- The **`::gitcat.tama` reaction protocol**. A command (or hook) can print a
  line of the form:

  ```
  ::gitcat.tama <reaction> <message>
  ```

  where `<reaction>` is one of a **closed safe allowlist**:

  | reaction  | Tama pose   | meaning              |
  | --------- | ----------- | -------------------- |
  | `info`    | hint        | here's something     |
  | `busy`    | thinking    | working on it        |
  | `ok`      | celebrate   | that went well       |
  | `problem` | confused    | that didn't go well  |

  Any other token (`danger`, `undo`, garbage, …) is **ignored** — a plugin can
  never reach a safety-critical pose. The last valid directive line wins; the
  message is capped at ~160 chars, and directive lines are stripped from the
  output Tama otherwise shows.

This one runs `echo "::gitcat.tama ok Hello from your plugin!"`, so Tama
celebrates and says *"Hello from your plugin!"*.

## Install

Settings → **Plugins** → **Install plugin…** and pick this folder's
`plugin.json` (or the folder itself). The command appears live in ⌘K.

## Windows note

Plugin `run` lines are POSIX-shell one-liners. On Windows the executor uses
`cmd.exe`, and a `run` line that relies on POSIX quoting/syntax may not behave
the same way — assume a POSIX shell (Git-Bash / WSL) on PATH. This particular
one-liner is plain `echo`, so it works either way, but keep the caveat in mind
for the more involved examples.

> **Note:** every plugin command still requires an **open repository** — the
> repo is the command's working directory. `context: "none"` means "needs no
> commit/file selection", not "needs no repo": with no repo open, GitCat
> declines to run any plugin command.
