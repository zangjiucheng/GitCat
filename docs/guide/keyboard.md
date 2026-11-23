---
description: GitCat's command palette and keyboard shortcuts — the ⌘K palette, vim-style graph navigation, and the shortcuts for everyday operations.
---

# Command palette & keyboard

GitCat is built to be driven from the keyboard. The `⌘K` palette reaches anything; vim-style keys move around the graph.

::: info This page is being expanded
The full walkthrough is on its way. Here's the outline of what it covers.
:::

## What this page will cover

- **The command palette** (`⌘K`) — fuzzy search across commits, refs (including branches not shown in the sidebar), and every tool, plus an in-app **Help** page.
- **Vim-style navigation** — `j`/`k`, `gg`/`G`, `Ctrl-D`/`Ctrl-U`, `/` to search.

## Shortcut reference (so far)

| Shortcut | Action |
| --- | --- |
| `⌘K` | Command palette |
| `⌘O` | Open / switch repository |
| `⌘,` | Settings |
| `⌘⇧H` | Recentre the graph on `HEAD` |
| `⌘Z` | Undo the last history-changing operation (see [Undo & the Safety Manager](/guide/undo-safety)) |
| `⌘⇧N` | New branch |
| `⌘N` | New window |
| `⌘F` | Search Code |
| `⌘⇧F` | Search Commit Content (pickaxe) |
| `` ⌘` `` | Toggle the built-in terminal |

(On Windows/Linux, use `Ctrl` in place of `⌘`.)

## What isn't on the keyboard

Every operation is meant to be reachable from the keyboard, through its own shortcut or through the `⌘K` palette. There is one deliberate exception:

- **Tama Gallery** is an easter egg. It opens only with the mouse, and it has no palette entry or menu item, because an easter egg that anyone can find isn't one. It does nothing a keyboard user needs for working with a repository.

If you find anything else that the keyboard can't reach, please [open an issue](https://github.com/zangjiucheng/GitCat/issues). That's a bug.
