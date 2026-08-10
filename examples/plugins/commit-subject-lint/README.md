# Commit Subject Lint

A **hook + Luau** example. After you make a commit through GitCat's commit UI, it
looks at the new commit's subject line and lets Tama react if it is too long (or
ends with a stray period).

This plugin used to be a POSIX-shell one-liner. It is now a **Luau handler**,
which is the interesting part: the same logic runs on every platform with no
shell, and the hook and the on-demand command share one lint function.

## What it shows

- A **`commit-created` hook** that names a **`handler`** (`on_commit`) instead of
  a shell `run`. `commit-created` fires when you commit through GitCat's commit
  UI. The handler lives in `main.lua`, pointed to by the top-level `lua` field.
- **One rule set, two entry points.** `main.lua` keeps a private `lint(subject)`
  function; both the hook (`on_commit`) and the palette command (`lint_head`)
  call it. No duplicated logic, no duplicated shell string.
- Reading commit data with the **`git(args)`** host function
  (`git({ "log", "-1", "--format=%s", "HEAD" })`) — literal argv, run inside the
  open repository, injection-free. A hook does not get `{sha}`/`{file}`, so
  reading what you need with `git()` is the normal pattern.
- Driving Tama with **`tama.react(kind, msg)`**: `"problem"` when the subject is
  over 72 characters or ends with a period, otherwise `"ok"`.

It also ships one **on-demand command** (`Lint: Check HEAD commit subject
length`, `context: "repo"`) that runs the same check against `HEAD` from ⌘K, so
you can try it without making a commit.

## Why Luau here (and not a shell `run`)

The old shell version leaned on `$(…)`, `${#s}`, and `[ … ]` — POSIX-only, so it
misbehaved on Windows and had to fight `cmd.exe` quoting. The Luau handler has
**no shell**: it is the same on macOS, Linux, and Windows, adding a second rule
is a couple of lines, and `git()` args are literal data rather than a string
that has to be quoted correctly. Use a shell `run` when you need to launch an
external program (see `open-in-editor`); reach for a Luau `handler` when the work
is logic over git output, like this.

## Hooks are observers, not gates

A hook is a **fire-and-forget observer**. It runs *alongside* the GitCat
operation and **cannot veto, block, or roll back** anything — it can only look
and (optionally) make Tama react. A handler also cannot reach a safety-critical
Tama pose: `tama.react` only accepts the four benign moods.

### Events you can hook

`repo-opened`, `repo-switched`, `pre-mutation`, `commit-created`, `undo`.

> `post-mutation` is declared in the manifest schema but is **not fired yet**
> (GitCat has no single post-mutation chokepoint). Don't rely on it.

## The sandbox

The handler runs in a locked-down Luau VM — only `string`/`math`/`table` plus
the base library, **no `os`, `io`, network, `require`, or `load`**. Its only
reach outward is `git()`, and a memory ceiling and wall-clock limit bound a buggy
script. This lint only reads, so it needs no `"mutates"` flag; a handler that
*changes* the repo would set `"mutates": true` so GitCat snapshots it for Undo.

## Install

Settings → **Plugins** → **Install plugin…**, pick this folder's `plugin.json`.
The hook fires automatically on your next commit; the `lint-head` command shows
up live in ⌘K.
