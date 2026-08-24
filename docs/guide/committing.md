---
description: How to stage and commit in GitCat — the working-directory view, hunk- and line-level staging, discarding changes, writing a commit, and stashing.
---

# Committing & staging

Committing in GitCat happens in the **working-directory view**. Open it by selecting the **Uncommitted changes** row pinned at the top of the graph (or **Tools ▸ Uncommitted Changes**, which jumps straight to it).

Like the commit detail panel, it's split into tabs: **Commit** (write your message and commit), **Changes** (stage and review), and **Stash**.

The **Changes** tab is a real staging view — not a flat list of file paths — split into **Staged** and **Unstaged** trees beside a diff for whatever file you select. Whether the file trees sit above or beside the diff follows the detail panel's placement setting — see [Settings](/guide/settings).

## Staging whole files

Each changed file has a control to move it between unstaged and staged:

- **Stage** a file to include its changes in your next commit.
- **Unstage** to pull it back out.
- **Discard** to throw its changes away entirely. Discarding is destructive to that file's uncommitted work, so it's treated as a real action — but committed history is never at risk, and the [Safety Manager](/guide/undo-safety) still has your back for anything that touched history.

## Staging part of a file

Often you only want to commit *some* of the changes in a file. GitCat has a full `git add -p` equivalent built into the diff:

- **By hunk** — each hunk in the diff has its own toolbar to stage, unstage, or discard just that hunk.
- **By line** — tick individual lines with the per-line checkboxes, then stage, unstage, or discard exactly that selection. **Shift-click** to select a range of lines at once.

This lets you split one messy working file into several clean, focused commits without leaving the app.

## Writing the commit

With the changes you want staged, switch to the **Commit** tab to write your message and commit. A few things worth knowing:

- Your commit is authored with the **git identity** for this repo (see [Opening a repository](/guide/opening-a-repository) to check or change it).
- The commit is a normal, snapshotted operation — it appears immediately on the graph, and it's covered by [Undo](/guide/undo-safety) like everything else.

## Stashing

When you need to set changes aside without committing them, use the **Stash** tab. GitCat supports the operations you actually reach for day to day:

- **Save** the current working changes to a stash,
- **Apply** a stash (keep it in the list) or **Pop** it (apply and remove),
- **Drop** a stash you no longer need.

Stashes stay recoverable there, so a "stash → switch branch → come back" flow is safe and visible.

## Reading a file's past while you work

From a file row in the working-directory view (and in a commit's file tree), two per-file tools are one click away:

- **Blame** — a line-by-line annotation of who last changed each line, with an ignore-whitespace toggle, following the file's rename history automatically.
- **History** — that single file's commit list, rename-following like `git log --follow`.

Both are covered in [History & recovery tools](/guide/history-tools).

## Using your own diff/merge tool

If you'd rather read a change in your own editor, GitCat can hand a file's diff off to a configured **external tool** (VS Code, Beyond Compare, or anything else) instead of the built-in diff. Set one up under [Terminal & external tools](/guide/terminal-tools).

---

Next: [Branches & tags](/guide/branches).
