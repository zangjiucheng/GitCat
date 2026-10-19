---
description: GitCat's Safety Manager — how the snapshot-before-history-changes system works, what it covers, how to undo (and undo the undo), snapshot retention, and the recovery tools that back it up.
---

# Undo & the Safety Manager

This is the page that makes the rest of GitCat safe to explore. The **Safety Manager** is the system that lets you try things — a rebase, a reset, a cherry-pick you're not sure about — knowing you can always get back.

## How it works

Before the everyday operations that change your history — a commit, merge, rebase, reset, cherry-pick, revert, checkout, pull, starting a bisect, or a plugin action marked as mutating — GitCat pins a **snapshot**. You don't do anything to make this happen; it's automatic. A few operations deliberately sit outside it: creating a tag (nothing to undo — just delete it), and `filter-repo`, which takes its own full backup instead (see [What else is protected](#what-else-is-protected)).

A snapshot records where `HEAD` points and where **every local branch** points. It's a record of committed history, not a copy of your files: uncommitted changes (staged or not), tags, remotes, stashes and config are not part of it. Those have their own nets instead — see [What else is protected](#what-else-is-protected) below.

That snapshot is what **Undo** restores from:

- **Undo** — `⌘Z` (`Ctrl+Z`). Moves `HEAD` and your local branches back to where they were just before the last history-changing operation — including recreating a branch that was deleted or renamed since.
- **Undo needs a clean working tree.** Rewinding resets your files to the snapshot, so if you have uncommitted changes GitCat stops and offers to **stash → undo → re-apply** them for you, rather than overwrite them.
- **Undo is itself undoable.** Restoring a snapshot is just another snapshotted operation, so if you undo by mistake, press `⌘Z` again to come back. There's no separate Redo.

Tama, the cat in the corner, is the face of this system — she pins the snapshot before the mutation and reacts to what's happening, so the safety net always feels present rather than hidden.

## Snapshots in the sidebar

Every snapshot is listed in the **Snapshots** section of the sidebar (and a ribbon on the graph). Click one to preview the commit it pinned. `⌘Z` always rewinds to the most recent one; to jump further back, use **Reflog rescue** (below), whose restore is, again, snapshot-first and undoable.

Under the hood these are backup refs stored inside your repo, so they survive quitting and reopening GitCat.

## Keeping snapshots tidy

Because each of those operations adds one, snapshots accumulate. **Settings ▸ General ▸ Snapshots** controls automatic cleanup, run each time a repo opens:

- **Keep everything** (default) — no cleanup; nothing is ever pruned automatically.
- **Keep the newest N**,
- **Keep the last N days**, or
- **Hybrid** — keep a snapshot if it's among the newest N *or* from the last N days.

Whatever you pick, the **single most recent snapshot is always kept** — "undo my last action" never gets cleaned away.

## What else is protected

Snapshots cover history. For the things a snapshot doesn't capture, GitCat takes a targeted backup right before the risky step instead:

- **Discarding changes** (a whole file, a hunk, or selected lines) first writes what you're throwing away — a patch for a tracked file, a copy for an untracked one — under `.git/gitgui/discard-backup/`.
- **Deleting a branch** pins its tip under `refs/gitgui/deleted/`, **deleting a tag** pins its target under `refs/gitgui/deleted-tag/`, and **dropping a stash** pins it under `refs/gitgui/dropped-stash/` — so the commits stay reachable and recoverable by hash, even though they aren't `⌘Z` targets.
- **Rewriting history with `filter-repo`** takes a full, verified `git bundle` backup of every ref before it runs.

Remote settings, remote-tracking refs (which the next fetch rebuilds) and git config edits aren't backed up.

## The recovery tools behind it

The Safety Manager is more than one Undo key. A family of tools (all under **Tools**, and covered in [History & recovery tools](/guide/history-tools)) exist for getting out of specific situations:

- **Reflog rescue** — browse every historical position `HEAD` has been in and restore to any of them. The restore is a normal snapshot-first, undoable mutation.
- **Dangling-object recovery** — runs `git fsck` to find a commit that no branch, tag, or reflog points to anymore, and brings it back as a new branch without touching your current branch or `HEAD`.

## When an action is genuinely risky

A few operations can lose work in a way a snapshot can't fully paper over, so GitCat gates them explicitly rather than letting you stumble into them:

- **Switching branches with uncommitted changes** — instead of silently stashing or refusing, GitCat offers three explicit paths in increasing order of risk: **stash → switch → reapply**; **stash → switch → leave stashed** (recover it later from the working-directory view's **Stash** tab — see [Committing & staging](/guide/committing)); or **force-switch and discard**, which is genuinely irreversible and sits behind a typed danger-confirm.
- **Hard reset** — resetting `HEAD` in *hard* mode (or resetting the current branch to its upstream) is snapshotted like any reset, so `⌘Z` puts the branch back — but the uncommitted changes it discards aren't backed up anywhere, so it sits behind the same typed danger-confirm.
- **Force push** — a real choice between **force-with-lease** (refuses if the remote moved since your last fetch) and a raw **override**, both behind the same typed danger-confirm. See [Syncing with remotes](/guide/remotes).
- **Rewriting history with `filter-repo`** — the one genuinely irreversible-by-normal-Undo operation gets its own dedicated wizard with a full `git bundle` backup and restore step in place of the usual snapshot. See [Rewriting history](/guide/rewriting-history).

The pattern is consistent: the everyday stuff is freely reversible with `⌘Z`, and the rare irreversible actions announce themselves and make you type to confirm.

---

Next: [History & recovery tools](/guide/history-tools).
