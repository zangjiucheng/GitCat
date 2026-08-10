---
description: How to open, switch, and close repositories in GitCat — the repositories dashboard, the first-run setup wizard, git identity, and working on several repos at once.
---

# Opening a repository

GitCat always works on **one repository at a time** in a given window. This page covers getting a repo open, switching between them, and pointing GitCat somewhere new.

## The first time

On first launch, a short **setup wizard** appears. It does three things:

1. **Pick a repository** — click to browse for a folder, or drag a folder straight onto the window.
2. **Check your git identity** — the name and email your commits will be signed with. If the repository (or your global config) already has one, it's shown for confirmation; if not, you can set it here.
3. **Jump into the graph.**

The wizard is shown **once**, not on every launch. You can skip it with `Esc` and reach everything it does from the normal UI afterwards.

## Opening or switching repositories

Any time after the first run, open the **Repositories** dashboard:

- Press `⌘O` (`Ctrl+O`), or
- Click the repository name in the top bar, or
- Choose **File ▸ Open Repository…**, or the **Open a repository…** button on the empty-state screen.

The dashboard lists the repositories you've opened before (searchable), each with its current branch and status at a glance, so switching back to something you were working on is one click. To bring in a new one, use **+ Add repository…**, which opens a native folder picker.

Selecting a repository loads it into the current window and takes you to its graph.

## Git identity

Your **git identity** (the name and email on your commits) can be set per repository or globally. To view or change it for the repo that's open:

- **Settings ▸ Git Identity** (`⌘,` opens Settings), or the identity step surfaced by the setup wizard.

GitCat writes a per-repository identity only to that repo's `.git/config` — your global identity is never touched unless you explicitly edit the **Global** scope in [Settings ▸ Git Config](/guide/settings).

## Closing and the empty state

**File ▸ Close Repository** returns GitCat to its empty state — a clean way to step away from the current repo without quitting. From there you can open a different one exactly as above. (You never have to quit and relaunch just to point GitCat somewhere else.)

## Submodules

If the open repository has submodules, a slim strip appears under the top bar. From there you can init/update them (including `--recursive`), add or remove one, and — most usefully — **Open** a submodule to manage it exactly like a top-level repository, then come back. Submodule status (up to date, needs update, has local edits) is shown so you know what needs attention.

## Working on several repos at once

To keep two repositories open side by side, use **Window ▸ New Window** (`⌘N`). Each window is fully independent — pick a different repository in each, and an operation in one never affects the other.

## Staying in sync with the outside world

Once a repo is open, GitCat keeps up with changes made **outside** the app — a commit from a terminal, a background fetch, another tool — and refreshes the graph and working-directory view on its own. If you ever want to force a resync, the **Refresh** button in the top bar (or **Repository ▸ Refresh**) does a full reload.

---

Next: [Reading the commit graph](/guide/commit-graph).
