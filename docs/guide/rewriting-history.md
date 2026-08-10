---
description: Rewriting history in GitCat with the git-filter-repo wizard — scope, preview, typed confirmation, and a full backup/restore safety net.
---

# Rewriting history

The one genuinely irreversible-by-normal-Undo operation in GitCat gets its own careful, multi-step wizard.

::: warning The heavy operation
Rewriting history changes every affected commit's hash and expires the reflog. GitCat wraps it in a dedicated wizard with a full backup and restore step *on top of* the usual snapshot — but it's still the biggest thing you can do to a repository, so it's worth understanding before you run it.
:::

::: info This page is being expanded
The full walkthrough is on its way. Here's the outline of what it covers.
:::

## What this page will cover

- Opening the wizard (**Tools ▸ Rewrite History (filter-repo)…**).
- **Scope** — choosing what to rewrite (paths, and so on).
- **Preview** — seeing what the rewrite will do before it runs.
- **Typed confirmation** — the deliberate "yes, I mean it" gate.
- **Backup & restore** — the dedicated safety net, separate from the ordinary snapshot, and how to restore from it.
