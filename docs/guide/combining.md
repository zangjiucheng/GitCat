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

## AI suggestions for a conflict (optional)

The resolver can ask a language model how to merge one conflict. This is **off until you turn it on** in **Settings → AI**.

- **Choose a provider.**
  - **Anthropic (Claude)** needs an API key. The default model is `claude-opus-5-5`.
  - **OpenAI-compatible** works with a local runner such as Ollama or LM Studio, so your code never leaves your machine. The default endpoint is `http://localhost:11434/v1`.
- **What is sent:** pressing ✨ **Suggest** on a conflict sends only that conflict — the file path, both sides, the common ancestor, and about 40 unchanged lines on each side. Nothing else from the repository is sent.
- **What happens next:** the suggestion goes into that conflict's text box, with a one-line explanation under it. It is only a draft, like **Use ours** or **Use theirs**: you can edit it, or press **Undo suggestion** to get back what was there before. Nothing is written to your files until you press **Save resolution**.
- **The API key** is stored in GitCat's settings folder and is never shown again after you save it.
  - A saved key belongs to one provider. Switching provider removes it, so you enter a new key for the new provider.
  - If you don't save a key, GitCat uses `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` from the environment, but only when the endpoint is `api.anthropic.com` or `api.openai.com` itself.
  - A key is never sent over plain `http://` except to this machine (`localhost`). For any other host, use `https://`.
