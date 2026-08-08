---
description: GitCat's built-in terminal and pluggable external diff/merge tools — drop into a real shell at the repo root, or hand a diff or conflict to your own tool.
---

# Terminal & external tools

For the moments you want a raw shell, or your own diff/merge tool instead of the built-in view.

::: info This page is being expanded
The full walkthrough is on its way. Here's the outline of what it covers.
:::

## What this page will cover

- **The built-in terminal** — a real PTY-backed shell embedded in GitCat, rooted at the open repository. Toggle it with `` ⌘` `` or **Tools ▸ Open Terminal**; its scrollback stays alive across hide/show.
- **External diff/merge tools** — configure your own tool (VS Code, Beyond Compare, or anything else) and hand a file's diff or a conflict off to it instead of GitCat's built-in view. Set up under **Tools ▸ External Tools**.
- Where the per-file "Open in external diff" / "Resolve with external tool" actions appear (the working-directory and detail file rows, and the conflict resolver).
