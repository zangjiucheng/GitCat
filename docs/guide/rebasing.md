---
description: Rebasing in GitCat — linear rebase onto another branch, and the drag-to-reorder interactive rebase planner (pick / edit / squash / fixup / drop).
---

# Rebasing

Replaying commits onto a new base — linear or interactive — with the safety net on the whole time.

::: info This page is being expanded
The full walkthrough is on its way. Here's the outline of what it covers; the [Features](/features) list has the short version in the meantime.
:::

## What this page will cover

- **Linear rebase** onto any branch, including working through multi-commit conflict sequences and skipping a commit mid-sequence.
- **Interactive rebase** — a **drag-to-reorder planner** (pick / edit / squash / fixup / drop) that you arrange *before* it ever touches your history.
- How conflicts during a rebase hand off to the [3-way resolver](/guide/combining).
- Why a rebase is safe to try here: a snapshot is pinned first, so `⌘Z` [undoes the whole rebase](/guide/undo-safety) in one step.
