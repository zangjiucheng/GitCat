---
description: The GitCat user manual — how to use the app day to day, from opening a repository to undoing a rebase. Start here for a map of the window and how to get around.
---

# User manual

Welcome to GitCat. This guide is the practical, task-oriented companion to the [Features](/features) list: instead of "what GitCat can do", it walks through **how you actually do it** — where things live, which button or key does what, and how to get yourself out of trouble when something goes sideways.

If you're brand new, read the three **Getting started** pages in order. If you already know Git and just want to find where an operation lives, jump straight to the section you need from the sidebar.

## The one idea to keep in mind

Everything in GitCat is built around a single promise: **every operation that touches your history is reversible.** Before any mutation — a commit, a merge, a rebase, a reset, even a `filter-repo` run — GitCat pins a snapshot of your repository. That snapshot is what the global **Undo** (`⌘Z` / `Ctrl+Z`) restores from, and the restore is itself just another snapshot, so Undo is always undoable too.

You never have to memorize this or turn anything on. It just means you can explore, drag things around, and try operations you're unsure about, knowing one keystroke takes you back. The [Undo & the Safety Manager](/guide/undo-safety) page covers it in full.

## A map of the window

GitCat is one window with a few fixed regions:

- **The top bar** — the current repository name (click it to switch repos), the branch you're on, and the everyday sync buttons: **Fetch**, **Pull**, **Push**, and **Refresh**. The crosshair button (or `⌘⇧H`) recentres the graph on your current position (`HEAD`), and the theme toggle flips light/dark.
- **The sidebar** (left) — your branches, remotes, tags, and **Snapshots** (the Safety Manager's backups). Right-click a branch for its actions; use the visibility controls to hide/show branches and declutter a busy graph. Drag its edge to resize.
- **The commit graph** (centre) — the heart of the app: your history drawn as a swimlane graph on a fast canvas. The row pinned at the very top is **Uncommitted changes** (your working directory); every commit below it is real history. See [Reading the commit graph](/guide/commit-graph).
- **The detail panel** — selecting a commit shows its full detail across two tabs: **Commit** (author/committer, signature, refs) and **Changes** (file tree and a syntax-highlighted diff). Selecting the top **Uncommitted changes** row instead shows the **working-directory view**, with a third **Stash** tab, where you stage and commit. By default it sits along the right edge of the window; a Settings toggle moves it to the bottom instead. See [Committing & staging](/guide/committing).
- **Tama** — the cat in the corner is GitCat's Safety-Manager mascot. She reacts to what's happening (working, celebrating a success, warning before something risky) and is the friendly face of the snapshot-before-everything system. You can restyle or hide her — see [Tama](/guide/tama).

## Four ways to reach any action

The same operations are reachable more than one way, so you can use whichever fits your hands at the moment:

1. **Point and click** — buttons in the top bar, right-click menus on commits and branches, and drag-and-drop (shift-drag a commit onto `HEAD` to cherry-pick or merge).
2. **The command palette** — press `⌘K` (`Ctrl+K`) for a fuzzy search over commits, branches, and every tool. This is usually the fastest way to reach something you don't have a shortcut memorized for. See [Command palette & keyboard](/guide/keyboard).
3. **The menu bar** — the native **File / Repository / Edit / View / Tools / Window / Help** menus hold every action, grouped and labelled, with their keyboard shortcuts shown next to them. Most of the app's tools live under **Tools**.
4. **The keyboard** — vim-style navigation (`j`/`k`, `gg`/`G`, `Ctrl-D`/`Ctrl-U`, `/` to search) moves around the graph without the mouse, and the common operations have their own shortcuts.

::: tip First run
The very first time you open GitCat, a short setup wizard helps you pick a repository and check its git identity, then drops you straight into the graph. It only appears once. The next page, [Opening a repository](/guide/opening-a-repository), covers opening and switching repos any time after that.
:::
