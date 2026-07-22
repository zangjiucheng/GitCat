---
layout: home

hero:
  name: GitCat
  text: A cozy, safety-first desktop Git client.
  tagline: Every operation that touches your history is reversible — Tama pins a snapshot before every mutation, so a global Undo is always one keystroke away.
  image:
    src: /tama-hero.webp
    alt: Tama, GitCat's cat mascot, waving hello
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

# Every icon below is an inline Lucide SVG (stroke="currentColor", tinted via
# custom.css's indigo/teal alternation) — the exact same icon set + style the
# app itself uses (@lucide/svelte), not decorative emoji. VitePress renders a
# plain string `icon` value via v-html, so a full <svg>...</svg> markup
# string works directly with no `{ svg: ... }` wrapper needed (that shape is
# only for socialLinks, not home features — see VPFeature.vue's own
# v-else-if="icon" branch).
features:
  - icon: |-
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/></svg>
    title: Fast commit graph
    details: git2 reads + a hand-tuned Rust swimlane layout, rendered on a virtualized canvas — smooth even on huge repos.
  - icon: |-
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>
    title: Safety Manager
    details: Every mutation snapshots first. Global Undo (⌘Z) is one keystroke away, and Undo is itself undoable.
  - icon: |-
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/><path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"/></svg>
    title: Real git, made safe
    details: Stage and commit down to the line or hunk, drag-and-drop cherry-pick and merge, rebase (linear or interactive), and bisect — with a real 3-way conflict resolver.
  - icon: |-
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></svg>
    title: ⌘K command palette
    details: Fuzzy search across commits and refs, plus quick actions for Bisect, Reflog, Rerere, and Plumbing.
  - icon: |-
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>
    title: Reflog rescue
    details: Browse and restore to any historical HEAD position — the restore itself is just another undoable snapshot.
  - icon: |-
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5c.67 0 1.35.09 2 .26 1.78-2 5.03-2.84 6.42-2.26 1.4.58-.42 7-.42 7 .57 1.07 1 2.24 1 3.44C21 17.9 16.97 21 12 21s-9-3-9-7.56c0-1.25.5-2.4 1-3.44 0 0-1.89-6.42-.5-7 1.39-.58 4.72.23 6.5 2.23A9.04 9.04 0 0 1 12 5Z"/><path d="M8 14v.5"/><path d="M16 14v.5"/><path d="M11.25 16.25h1.5L12 17l-.75-.75Z"/></svg>
    title: Tama
    details: A cat mascot with eight expressions who reacts to what's actually happening across the app — searching, thinking, celebrating, or genuinely alarmed.
---

<div style="max-width: 960px; margin: 48px auto 0; padding: 0 24px;">

![GitCat screenshot](./screenshot.png)

</div>
