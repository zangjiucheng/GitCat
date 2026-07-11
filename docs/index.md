---
layout: home

hero:
  name: GitCat
  text: A cozy, safety-first desktop Git client.
  tagline: Every operation that touches your history is reversible — Tama pins a snapshot before every mutation, so a global Undo is always one keystroke away.
  image:
    src: /gitcat-icon.svg
    alt: GitCat
  actions:
    - theme: brand
      text: Download
      link: https://github.com/zangjiucheng/GitCat/releases
    - theme: alt
      text: Features
      link: /features
    - theme: alt
      text: View on GitHub
      link: https://github.com/zangjiucheng/GitCat

features:
  - icon: 📈
    title: Fast commit graph
    details: git2 reads + a hand-tuned Rust swimlane layout, rendered on a virtualized canvas — smooth even on huge repos.
  - icon: 🛡️
    title: Safety Manager
    details: Every mutation snapshots first. Global Undo (⌘Z) is one keystroke away, and Undo is itself undoable.
  - icon: 🖱️
    title: Real git, made safe
    details: Stage and commit down to the line or hunk, drag-and-drop cherry-pick and merge, rebase (linear or interactive), and bisect — with a real 3-way conflict resolver.
  - icon: 🔎
    title: ⌘K command palette
    details: Fuzzy search across commits and refs, plus quick actions for Bisect, Reflog, Rerere, and Plumbing.
  - icon: ⏪
    title: Reflog rescue
    details: Browse and restore to any historical HEAD position — the restore itself is just another undoable snapshot.
  - icon: 🐈
    title: Tama
    details: A cat mascot with eight expressions who reacts to what's actually happening across the app — searching, thinking, celebrating, or genuinely alarmed.
---

<div style="max-width: 960px; margin: 48px auto 0; padding: 0 24px;">

![GitCat screenshot](./screenshot.png)

</div>
