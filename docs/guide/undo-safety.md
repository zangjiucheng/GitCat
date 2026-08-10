---
description: GitCat's Safety Manager — how the snapshot-before-every-mutation system works, how to undo (and undo the undo), snapshot retention, and the recovery tools that back it up.
---

# Undo & the Safety Manager

This is the page that makes the rest of GitCat safe to explore. The **Safety Manager** is the system that lets you try things — a rebase, a reset, a cherry-pick you're not sure about — knowing you can always get back.

## How it works

Before **any** operation that changes your history or working tree, GitCat pins a **snapshot** of the repository. You don't do anything to make this happen; it's automatic and it covers every mutation.

That snapshot is what **Undo** restores from:

- **Undo** — `⌘Z` (`Ctrl+Z`). Rolls the repository back to just before the last mutation.
- **Undo is itself undoable.** Restoring a snapshot is just another snapshotted mutation, so if you undo one step too far, undo again (or redo) to come back. There's no single click in the app that drops you somewhere you can't get out of.

Tama, the cat in the corner, is the face of this system — she pins the snapshot before the mutation and reacts to what's happening, so the safety net always feels present rather than hidden.

## Snapshots in the sidebar

Every snapshot is listed in the **Snapshots** section of the sidebar (and a ribbon on the graph). You can browse them and restore to any one, not just the most recent — handy when you want to jump back several operations at once. Each restore is, again, snapshot-first and undoable.

Under the hood these are backup refs stored inside your repo, so they survive quitting and reopening GitCat.

## Keeping snapshots tidy

Because every mutation adds one, snapshots accumulate. **Settings ▸ General ▸ Snapshots** controls automatic cleanup, run each time a repo opens:

- **Keep everything** (default) — no cleanup; nothing is ever pruned automatically.
- **Keep the newest N**,
- **Keep the last N days**, or
- **Hybrid** — keep a snapshot if it's among the newest N *or* from the last N days.

Whatever you pick, the **single most recent snapshot is always kept** — "undo my last action" never gets cleaned away.

## The recovery tools behind it

The Safety Manager is more than one Undo key. A family of tools (all under **Tools**, and covered in [History & recovery tools](/guide/history-tools)) exist for getting out of specific situations:

- **Reflog rescue** — browse every historical position `HEAD` has been in and restore to any of them. The restore is a normal snapshot-first, undoable mutation.
- **Dangling-object recovery** — runs `git fsck` to find a commit that no branch, tag, or reflog points to anymore, and brings it back as a new branch without touching your current branch or `HEAD`.

## When an action is genuinely risky

A few operations can lose work in a way a snapshot can't fully paper over, so GitCat gates them explicitly rather than letting you stumble into them:

- **Switching branches with uncommitted changes** — instead of silently stashing or refusing, GitCat offers three explicit paths in increasing order of risk: **stash → switch → reapply**; **stash → switch → leave stashed** (recover it later from Manage Stash); or **force-switch and discard**, which is genuinely irreversible and sits behind a typed danger-confirm.
- **Force push** — a real choice between **force-with-lease** (refuses if the remote moved since your last fetch) and a raw **override**, both behind the same typed danger-confirm. See [Syncing with remotes](/guide/remotes).
- **Rewriting history with `filter-repo`** — the one genuinely irreversible-by-normal-Undo operation gets its own dedicated wizard with a full backup and restore step on top of the usual snapshot. See [Rewriting history](/guide/rewriting-history).

The pattern is consistent: the everyday stuff is freely reversible with `⌘Z`, and the rare irreversible actions announce themselves and make you type to confirm.

---

Next: [History & recovery tools](/guide/history-tools).
