# FAQ

### What is the "Safety Manager"?

It's the part of GitCat that snapshots your repo before every mutation — a rebase, a reset, a filter-repo run, anything that changes history or the working tree. That snapshot is what the global Undo (⌘Z) restores from, and restoring is itself just another snapshotted mutation, so Undo is always undoable too. There's no single operation in the app that can put you in a state you can't get back out of with one click — the closest exception is `git-filter-repo`, which gets its own dedicated backup/restore wizard on top of the usual snapshot because rewriting an entire history is a fundamentally bigger action.

### Does GitCat do anything to my repository without asking?

No. Every mutating action is something you clicked (or dragged, or typed a command for) — GitCat doesn't run background git operations that touch history or the working tree on its own. It does watch the repo's `.git` directory so the graph stays live if you commit from a terminal alongside it, but that's a read, not a write.

### Why are the installers unsigned?

There's no code-signing certificate configured for the project yet. See [Install](/install) for how to get past your OS's Gatekeeper/SmartScreen warning — it's a one-time step, not a red flag about the build itself.

### What platforms does GitCat run on?

macOS (Apple Silicon and Intel), Windows (x86_64 and arm64), and Linux (x86_64 and arm64, as `.deb`/`.rpm`/`.AppImage`). All six are built from the same tag on every release.

### Is GitCat free? What's the license?

Yes — GitCat is free software, licensed under the [GNU General Public License v3.0 or later](https://github.com/zangjiucheng/GitCat/blob/main/LICENSE).

### Does it support submodules?

Yes — init/update (including `--recursive`), add, deinit/remove, a bulk `foreach` command runner, and you can "Open" a submodule to manage it exactly like a top-level repo, with a "← Back to \<parent repo\>" breadcrumb to return.

### Does it support `git bisect` / interactive rebase / stash?

Yes to all three. Bisect gives you live canvas cues for the narrowing candidate range and automatic first-bad-commit detection; interactive rebase is a drag-to-reorder planner (pick/edit/squash/fixup/drop) before anything runs; and the working-directory panel covers stage/unstage/commit/stash apply/pop/drop.

### How does push/pull authentication work?

GitCat shells out to your system's `git` binary for every write operation (fetch/pull/push, and everything else that mutates a repo), so it uses whatever credential helper, SSH agent, or `.gitconfig` you already have set up — there's no separate credential store to configure.

### How is this different from GitHub Desktop / GitKraken / Sourcetree / \[other Git GUI\]?

The main difference is the Safety Manager: GitCat is built around the assumption that a history-rewriting mistake should always be one Undo away, not something you have to know `git reflog` to recover from by hand. It's also free and open source (GPLv3), with a fast virtualized canvas graph designed to stay smooth on large repos.

### I found a bug or want a feature. Where do I report it?

Open an issue on [GitHub](https://github.com/zangjiucheng/GitCat/issues/new).
