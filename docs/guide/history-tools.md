---
description: GitCat's investigation and recovery tools — bisect, reflog, rerere, blame, per-file history, author and pickaxe search, and dangling-commit recovery.
---

# History & recovery tools

The read-only tools for finding things in your history, and the recovery tools for getting things back. Most live under the **Tools** menu and `⌘K`.

::: info This page is being expanded
The full walkthrough is on its way. Here's the outline of what it covers; the [Features](/features) list has the short version in the meantime.
:::

## What this page will cover

### Finding things

- **Bisect** — mark commits good/bad/skip and watch the candidate range narrow live on the canvas until the first bad commit is found.
- **Blame** — line-by-line attribution with an ignore-whitespace toggle, rename-following.
- **Per-file history** — one file's commits with rename-following (`git log --follow`).
- **Search by author** (`git log --author`) across all history.
- **Pickaxe / diff-content search** (`git log -S`/`-G`) — every commit whose diff touched a string or pattern. **Search Code** (`⌘F`) and **Search Commit Content** (`⌘⇧F`).

### Getting things back

- **Reflog rescue** — browse every historical `HEAD` position and restore to any of them.
- **Rerere** — see what git has recorded a conflict resolution for, and toggle `rerere.enabled` without a terminal.
- **Dangling-object recovery** — `git fsck` finds a commit nothing points to and recovers it as a new branch.

These pair with the [Safety Manager](/guide/undo-safety), which snapshots before every mutation.
