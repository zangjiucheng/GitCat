---
description: Syncing with remotes in GitCat — fetch, pull (merge or rebase), push, managing remotes, and the two safe kinds of force push.
---

# Syncing with remotes

Fetching, pulling, and pushing — and doing the risky remote operations safely.

::: info This page is being expanded
The full walkthrough is on its way. Here's the outline of what it covers; the [Features](/features) list has the short version in the meantime.
:::

## What this page will cover

- **Fetch / Pull / Push** from the top bar or the native **Repository** menu.
- **Pull asks merge or rebase explicitly** — it never silently picks a strategy behind your back, and follows your configured upstream automatically.
- **Pushing a non-current branch**, or pushing to a differently-named remote branch, right from the sidebar.
- **Manage Remotes** — add, edit, rename, and remove remotes from a dialog instead of hand-editing `.git/config` (**Tools ▸ Manage Remotes**).
- **Force push, made safe** — the explicit choice between **force-with-lease** (refuses if the remote moved since your last fetch) and a raw **override**, both behind a typed danger-confirm.
- **Auto-fetch** — an optional background `git fetch --all --prune` on a timer, so ahead/behind counts stay current (opt-in, in [Settings](/guide/settings)).
