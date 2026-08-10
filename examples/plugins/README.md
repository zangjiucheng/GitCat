# GitCat example plugins

Reference plugins for GitCat's plugin system. Each is a small `plugin.json`
manifest (plus a per-plugin README, and a `main.lua` for the Luau-scripted ones).
They are intentionally minimal, valid against the real manifest schema, and safe
to install and read as a starting point for your own.

A GitCat plugin is a `plugin.json` describing:

- **`commands`** — user-invokable actions surfaced in the ⌘K command palette.
- **`hooks`** — external commands GitCat runs when a lifecycle event fires.
- **`tama`** — an optional alternate look (and voice) for Tama: pose art, a
  greeting line, and a `voicePitch` (a skin ships its own character art; see
  [Tama skins](../../docs/plugins.md#tama-skins)).
- **`lua`** — an optional main Luau script; a command/hook can name a `handler`
  function in it instead of a shell `run` (see [`lua-hello`](./lua-hello/) and
  [`commit-subject-lint`](./commit-subject-lint/)).

GitCat itself contacts **no AI and no network**. A plugin's `run` string is a
**user-authored external command** run on your machine — the same trust boundary
as a difftool/mergetool command. A Luau `handler` runs instead in a locked-down
sandbox (no `os`/`io`/network/`require`; its only reach out is `git()`). Either
way, install only plugins you trust.

## The examples

| Plugin | What it demonstrates |
| ------ | -------------------- |
| [`hello-tama`](./hello-tama/) | The smallest command (shell `run`); the `::gitcat.tama` reaction protocol (make Tama react from stdout). |
| [`open-in-editor`](./open-in-editor/) | External-tool commands (shell `run`) using the **placeholder grammar** (`{repo}`, `{sha}`) and the `--` flag-injection guard — the case where a shell `run` is the right tool (launching a program). |
| [`lua-hello`](./lua-hello/) | The smallest **Luau-scripted** command: the `lua` manifest field + a command with a `handler` (not a shell `run`), using the sandboxed host API (`ctx`, `git`, `tama.react`, `print`). |
| [`commit-subject-lint`](./commit-subject-lint/) | A **Luau** `commit-created` **hook** + on-demand command that share one lint function, reading the subject via `git()` and reacting via Tama — logic that a shell one-liner handled awkwardly (and only on POSIX). |

## Installing

Settings → **Plugins** tab → **Install plugin…** → pick a plugin's `plugin.json`
(or its folder). Toggle a plugin enabled/disabled or **Remove** it there.
Installed commands appear live in ⌘K; hooks fire automatically. The registry is
persisted in `plugins.json` under the app config dir.

## Manifest at a glance

```jsonc
{
  "id": "my-plugin",            // ^[a-z0-9][a-z0-9-]*$, unique in the registry
  "name": "My Plugin",          // required, non-empty
  "version": "1.0.0",           // required, non-empty
  "description": "…",           // optional
  "enabled": true,              // optional, defaults to true
  "commands": [
    {
      "id": "do-thing",
      "label": "Do the thing",
      "run": "mytool --repo {repo}", // external command TEMPLATE (non-empty)
      "context": "repo",   // none | commit | file | repo   (default: none)
      "placement": "palette" // palette | menu | both        (default: palette)
    }
  ],
  "hooks": [
    { "event": "commit-created", "run": "…" } // event is kebab-case
  ]
}
```

Honest caveats worth knowing:

- **`placement: "menu"`/`"both"` is not wired yet** (native context menu is
  backlog). A command with either placement currently appears **only in ⌘K**,
  exactly like `"palette"`. The examples all use `"palette"`.
- **`post-mutation` hooks are not fired yet** — the event exists in the schema
  but GitCat has no post-mutation chokepoint. Available events that DO fire:
  `repo-opened`, `repo-switched`, `pre-mutation`, `commit-created`, `undo`.
- Hooks are **fire-and-forget observers** — they cannot veto or block a GitCat
  operation.
- A plugin/hook command that changes the repo should declare **`"mutates": true`**:
  GitCat then snapshots before running it, so the change is covered by global
  **Undo** (a mutating action that omits `mutates` runs outside Undo).
- **Windows**: `run` lines are POSIX-shell one-liners; the Windows executor uses
  `cmd.exe`, and a value containing a `cmd` metacharacter (`& | < > ^ % ! "`,
  CR/LF) is refused fail-closed (so `{diff}` is usually refused on Windows).
  Assume a POSIX shell (Git-Bash / WSL) on PATH.

## More

See the full plugin documentation at [`docs/plugins.md`](../../docs/plugins.md).
