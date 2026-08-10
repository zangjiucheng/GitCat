---
description: Cherry-pick, merge, and revert in GitCat — drag-and-drop and right-click, merge strategies, and the 3-way conflict resolver.
---

# Cherry-pick, merge & revert

Moving commits between branches, combining branches, and undoing a commit — all backed by the same conflict resolver.

::: info This page is being expanded
The full walkthrough is on its way. Here's the outline of what it covers; the [Features](/features) list has the short version in the meantime.
:::

## What this page will cover

- **Cherry-pick** — **shift-drag** a commit onto `HEAD`, or right-click ▸ Cherry-pick. Optionally record the origin (`-x`).
- **Merge** — drag a branch onto your current one, or right-click ▸ Merge, with explicit strategy control: **squash**, or a fast-forward choice of **auto** / **no-ff** (always a real merge commit) / **ff-only** (refuses unless a fast-forward is possible).
- **Revert** — a first-class right-click action, not a workaround.
- **The 3-way conflict resolver** — when anything (cherry-pick, merge, revert, rebase, patch apply) doesn't apply cleanly, the same resolver opens so you're never left in a broken half-state.
- Choosing the **mainline parent** when cherry-picking or reverting a merge commit.
