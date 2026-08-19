---
layout: home

# Hero only. The section stack below it lives in theme/Landing.vue (injected
# via the `home-features-after` slot) — see that file's own comment for why
# the old `features:` card grid was dropped rather than re-worded.
hero:
  name: GitCat
  text: Git you can take back.
  tagline: A cozy desktop Git client that pins a snapshot before every mutation — so ⌘Z always works. Free and open source, on macOS, Windows and Linux.
  image:
    src: /tama-hero.webp
    alt: Tama, GitCat's cat mascot, waving hello
  # No `actions` here on purpose — DownloadButton.vue (injected via
  # theme/index.ts's own Layout override) renders the ENTIRE actions row
  # itself: an OS-auto-detecting split download button plus the same
  # "Features"/"View on GitHub" links this used to list here as plain
  # theme:brand/alt entries. See that component's own doc comment for why
  # a Vue component was necessary instead of just more frontmatter.
---
