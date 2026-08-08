---
description: How to read and navigate GitCat's commit graph — the HEAD marker, dimmed merged commits, ref labels, selecting commits, and moving around by mouse or keyboard.
---

# Reading the commit graph

The graph is where you'll spend most of your time. It draws your history as a **swimlane graph**: each commit is a dot on a coloured lane, with curved edges connecting parents to children. It's rendered on a fast canvas that stays smooth on repositories with hundreds of thousands of commits — only the rows on screen are ever drawn, and scrolling keeps every commit's text **readable** the whole time.

## What you're looking at

- **The top row is your working directory.** Pinned above all real history is an **Uncommitted changes** row. Select it to open the [working-directory view](/guide/committing) and stage/commit. It shows a badge when you have uncommitted work.
- **The HEAD marker tells you where you are.** The commit you currently have checked out (`HEAD`) wears a clear "you are here" marker — an accent ring around its dot and a bar down its row. When you've scrolled away and want to get back, press `⌘⇧H` (or the crosshair button in the top bar) to recentre on it.
- **Dimmed commits are already merged.** Every commit that's already part of your current branch is drawn dimmed, so **unmerged work stands out** — you can see at a glance what's new on a feature branch versus what's already in `main`.
- **Ref labels live in their own column.** Branch and tag names sit in a dedicated left column rather than cluttering the commit messages. Hover a truncated label to see its full name.

## Selecting a commit

Click any commit row (or move to it with the keyboard) to select it. The **detail panel** then shows everything about that commit:

- the **author** and **committer** split out separately (so you can tell a rebased or cherry-picked commit apart from the original),
- its **GPG signature** status,
- a **diffstat** and a **file tree**,
- and a **syntax-highlighted diff** you can expand to a full-page view for reading a real changeset comfortably.

## Acting on a commit

Two equivalent ways to operate on a commit:

- **Right-click** the commit row for its context menu: **cherry-pick**, **merge**, or **revert** it (among others). See [Cherry-pick, merge & revert](/guide/combining).
- **Drag and drop** — **shift-drag** a commit onto your current position to cherry-pick it, or drag a branch to merge. When something doesn't apply cleanly, GitCat's 3-way conflict resolver opens instead of leaving you in a broken state.

Right-clicking a **branch or tag label** (rather than a commit) gives a different menu: check it out, rename it, delete it, or check out a remote-tracking branch. See [Branches & tags](/guide/branches).

## Moving around

You can drive the graph entirely from the keyboard:

| Key | Action |
| --- | --- |
| `j` / `k` | Move down / up one commit |
| `gg` / `G` | Jump to the top / bottom of the graph |
| `Ctrl-D` / `Ctrl-U` | Page down / up |
| `/` | Search within the graph |
| `⌘⇧H` | Recentre on `HEAD` |
| `⌘K` | Open the command palette (jump to any commit, ref, or tool) |

The `⌘K` command palette can also find and show branches that **aren't currently listed in the sidebar** — search for one, pick it, and it appears on the graph.

## When the graph is busy

A few controls (in the [sidebar](/guide/branches) and [Settings](/guide/settings)) help with a crowded history:

- **Branch visibility** — hide or show individual branches, "Hide all branches" to start clean and hand-pick a few, or turn on **Auto** to always show just the current branch plus anything with unpushed or unmerged work.
- **Ref label priority** — when a commit's labels don't all fit the gutter, Settings lets you choose whether **tags** or **branches** show first; click a row's **+N** chip to cycle the rest into view.
- **Show all tags** — by default a commit with several tags shows the first; a Settings toggle draws all of them.

## Why it stays fast

You don't need to configure anything, but it's worth knowing: switching branches, creating or deleting a branch or tag, and staging **don't re-walk your whole history** — GitCat recognises the set of commits hasn't changed and updates the refs in place, so a checkout on a huge repo is immediate. Only operations that genuinely add or remove commits (commit, merge, pull) do a full reload.

---

Next: [Committing & staging](/guide/committing).
