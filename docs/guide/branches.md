---
description: Working with branches and tags in GitCat — create, checkout, rename, delete, check out a remote branch, control which branches show on the graph, and manage tags.
---

# Branches & tags

Managing branches and tags without a terminal — everything here lives in the sidebar and on the graph's ref labels.

::: info This page is being expanded
The full walkthrough is on its way. Here's the outline of what it covers; the [Features](/features) list has the short version in the meantime.
:::

## What this page will cover

- **Creating a branch** — from `HEAD` or from any local/remote start point you pick (`⌘⇧N`, or **File ▸ New Branch…**).
- **Checking out** a local branch, or a remote one directly — checking out `origin/feature-x` creates and switches to a local tracking branch automatically.
- **Rename / delete** — from the right-click menu on a branch or tag label on the graph, or the sidebar branch menu.
- **Branch visibility** — hide/show individual branches, "Hide all branches", and the **Auto** mode that keeps just the current branch plus anything with unpushed/unmerged work.
- **Tags** — create, delete, and push tags from the sidebar.
- How switching branches interacts with uncommitted changes (the dirty-tree chooser — see [Undo & the Safety Manager](/guide/undo-safety)).
