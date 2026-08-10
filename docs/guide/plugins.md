---
description: Using plugins in GitCat — install, enable, disable, and remove them from the Plugins manager. For writing your own, see the plugin authoring guide.
---

# Plugins

Plugins extend GitCat with extra `⌘K` commands, lifecycle hooks, panels, and Tama skins. This page is about **using** them; to **write** one, see the dedicated [plugin authoring guide](/plugins).

::: info This page is being expanded
The full walkthrough is on its way. Here's the outline of what it covers.
:::

## What this page will cover

- **The Plugins manager** — open it from **Tools ▸ Plugins…** or `⌘K`. It's a two-pane view: the installed plugins on the left, the selected one's details on the right (what it contributes, plus its enable and remove controls).
- **Install from a file** — GitCat plugins are local files (there's no online store); install one by picking its `plugin.json`.
- **Enable / disable** a plugin with its toggle, or **remove** it (which unregisters it — the `plugin.json` on disk is left untouched).
- **What a plugin can contribute** — `⌘K` commands, lifecycle hooks, declarative panels, a Tama skin, and Luau-scripted handlers.
- **The trust boundary** — GitCat never connects to anything itself; a plugin only runs the external commands (or sandboxed Luau) it declares. Install only plugins you trust.

## Writing your own

The full manifest reference, the placeholder grammar, hooks, panels, Tama skins, and Luau scripting all live in the [plugin authoring guide](/plugins).
