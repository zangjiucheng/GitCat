# FAQ

### What is the "Safety Manager"?

It's the part of GitCat that snapshots your repo before everyday history-changing operations — a commit, a merge, a rebase, a reset, a cherry-pick, a revert. A snapshot records where `HEAD` and every local branch point, and that's what the global Undo (⌘Z) restores; restoring is itself just another snapshotted operation, so Undo is always undoable too. Snapshots cover committed history, not uncommitted edits — so Undo needs a clean working tree (if yours isn't, GitCat offers to stash, undo and re-apply for you), and some of the actions that touch uncommitted work get their own nets: discarding changes writes a backup under `.git/gitgui/discard-backup/` first, and deleted branches, deleted tags and dropped stashes are pinned under `refs/gitgui/` so they stay recoverable. The actions that throw uncommitted work away for good — a hard reset (including resetting the current branch to its upstream) and force-switching away from uncommitted changes — sit behind a typed confirmation instead, as does force push. `git-filter-repo` isn't covered by ⌘Z at all: it gets its own dedicated wizard with a full `git bundle` backup and restore, because rewriting an entire history is a fundamentally bigger action.

### Does GitCat do anything to my repository without asking?

No. Every mutating action is something you clicked (or dragged, or typed a command for) — GitCat doesn't run background git operations that touch history or the working tree on its own. It does watch the repo's `.git` directory so the graph stays live if you commit from a terminal alongside it, but that's a read, not a write.

### Why are the installers unsigned?

There's no code-signing certificate configured for the project yet. See [Install](/install) for how to get past your OS's Gatekeeper/SmartScreen warning — it's a one-time step, not a red flag about the build itself.

### What platforms does GitCat run on?

macOS (Apple Silicon and Intel), Windows (x86_64 and arm64), and Linux (x86_64 and arm64, as `.deb`/`.rpm`/`.AppImage`). All six are built from the same tag on every release.

### Is GitCat free? What's the license?

Yes — GitCat is free software, licensed under the [GNU General Public License v3.0 or later](https://github.com/zangjiucheng/GitCat/blob/main/LICENSE).

### Does it support submodules?

Yes — init/update (including `--recursive`), add, deinit/remove, and you can "Open" a submodule to manage it exactly like a top-level repo. A submodule navigator strip under the topbar shows a breadcrumb of where you are (each ancestor a click away), the current level's siblings as one-click tabs, and a 🌳 button that opens the full submodule tree — so you can jump straight to a parent, a sibling, or any submodule at any depth. Opening a submodule folder directly picks up its parent and siblings automatically, and switching back to a repo you were just on is instant.

### Does it support `git bisect` / interactive rebase / stash?

Yes to all three. Bisect gives you live canvas cues for the narrowing candidate range and automatic first-bad-commit detection; interactive rebase is a drag-to-reorder planner (pick/edit/squash/fixup/drop) before anything runs; and the working-directory panel covers stage/unstage/commit/stash apply/pop/drop.

### Can it handle very large repositories?

Yes — GitCat is developed against CPython (150k+ commits). The graph streams in newest-first and only ever draws the visible rows, scrolling stays smooth *and legible* thanks to a scroll-blit render path, and everyday operations like checkout or creating a branch update the graph in place instead of re-walking the whole history each time (only actions that genuinely add or remove commits trigger a full reload).

### How does push/pull authentication work?

GitCat shells out to your system's `git` binary for every write operation (fetch/pull/push, and everything else that mutates a repo), so it uses whatever credential helper, SSH agent, or `.gitconfig` you already have set up — there's no separate credential store to configure.

### How is this different from GitHub Desktop / GitKraken / Sourcetree / \[other Git GUI\]?

The main difference is the Safety Manager: GitCat is built around the assumption that an everyday history-changing mistake should be one Undo away, not something you have to know `git reflog` to recover from by hand. It's also free and open source (GPLv3), with a fast virtualized canvas graph designed to stay smooth on large repos.

### I found a bug or want a feature. Where do I report it?

Open an issue on [GitHub](https://github.com/zangjiucheng/GitCat/issues/new).
