# lua-hello

The smallest **Luau-scripted** GitCat plugin (PER-56). Instead of a shell `run`
string, a command runs a **handler function** written in sandboxed Luau.

## What it shows

- A top-level **`lua`** manifest field pointing at the plugin's main script
  (`main.lua`), a path relative to the plugin folder.
- A command that declares a **`handler`** (the function name) instead of a
  **`run`** (a shell command). Exactly one of the two is allowed.
- The three pieces of the host API a handler gets:
  - **`ctx`** — the selection context (`ctx.repo`, `ctx.sha`, `ctx.branch`, …),
    the same values as the shell executor's `{repo}`/`{sha}`/… placeholders.
  - **`git(args)`** — run `git` with an array of literal (injection-free) args
    in the repo; returns `{ stdout, stderr, code, ok }`.
  - **`tama.react(kind, msg)`** — nudge Tama's mood (`info` | `busy` | `ok` |
    `problem`), and **`print(...)`** — captured as the command's output.

```jsonc
{
  "id": "lua-hello",
  "name": "Hello (Luau)",
  "version": "1.0.0",
  "lua": "main.lua",              // the main script (returns a table of handlers)
  "commands": [
    {
      "id": "hello",
      "label": "Luau: Say hello (and cheer up Tama)",
      "handler": "hello",          // names M.hello in main.lua — NOT a shell `run`
      "context": "repo"
    }
  ]
}
```

```lua
-- main.lua
local M = {}
function M.hello(ctx)
  local head = git({ "rev-parse", "--short", "HEAD" })
  if head.ok then
    local sha = (head.stdout:gsub("%s+$", ""))
    tama.react("ok", "Hello from your Luau plugin — HEAD is " .. sha)
    return "lua-hello: HEAD " .. sha
  else
    tama.react("problem", "lua-hello could not read HEAD")
    return "lua-hello: could not read HEAD: " .. head.stderr
  end
end
return M
```

## The sandbox (why this is safe to install)

The handler runs in a locked-down Luau VM: only `string`/`math`/`table` plus
Luau's base library are loaded — **no `os`, `io`, network, `require`, or
`load`**. The only reach outward is `git()`. A memory ceiling and a wall-clock
time limit bound a buggy or hostile script, and `tama.react` can only emit the
four benign moods — a script can never spoof a safety-critical Tama pose.

A `handler` that changes the repository must set **`"mutates": true`** on its
command (or hook), exactly like a shell `run` — GitCat then snapshots before
running it so the change is covered by global **Undo**.

## Install

Settings → **Plugins** → **Install plugin…** → pick this folder's `plugin.json`.
Run **Luau: Say hello (and cheer up Tama)** from ⌘K.
