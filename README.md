<div align="center">

# 🐱 GitCat

**A cozy, safety-first desktop Git client.**

Tauri 2 + Rust + Svelte 5, with a warm "Lamplight / Cozy Terminal" identity — and Tama, a cat mascot who reacts to what's actually happening and keeps a snapshot under you before every mutation.

[![CI](https://github.com/zangjiucheng/GitCat/actions/workflows/ci.yml/badge.svg)](https://github.com/zangjiucheng/GitCat/actions/workflows/ci.yml)
[![Docs](https://github.com/zangjiucheng/GitCat/actions/workflows/docs.yml/badge.svg)](https://github.com/zangjiucheng/GitCat/actions/workflows/docs.yml)
[![Release](https://github.com/zangjiucheng/GitCat/actions/workflows/release.yml/badge.svg)](https://github.com/zangjiucheng/GitCat/actions/workflows/release.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

**[Website & docs](https://zangjiucheng.github.io/GitCat/)**

![GitCat screenshot](docs/screenshot.png)

</div>

## What is this?

GitCat is a desktop Git GUI built around one idea: every operation that touches your history should be reversible. A **Safety Manager** snapshots your repo before every mutation, so a global Undo (⌘Z) is always one keystroke away — and Undo is itself undoable.

## Features

**Core graph + history**

- Fast commit graph (git2 read + a hand-tuned Rust swimlane layout) on a virtualized canvas — smooth even on large repos
- Full commit detail panel: author/committer split, GPG status, diffstat, file tree, syntax-highlighted diff
- ⌘K command palette — fuzzy search across commits and refs
- Vim-style keyboard navigation — `j`/`k`, `gg`/`G`, Ctrl-D/Ctrl-U, and `/` to search
- Per-file history with rename-following, like `git log --follow` — a renamed file's history continues seamlessly under its old path
- Pickaxe / diff-content search (`git log -S`/`-G`) — find every commit whose diff touched a string or pattern, not just its commit message

**Working directory**

- Stage or unstage whole files, or select specific lines or a whole hunk to stage, unstage, or discard (a `git add -p` equivalent) — per-hunk toolbar plus per-line checkboxes with shift-click range select
- Write commits, discard changes, and stash — save / apply / pop / drop
- `git blame` (line-annotation) view — per-hunk attribution (sha, author), an ignore-whitespace toggle, and follows the file's rename history automatically

**Everyday git, made safe**

- Sidebar: branches / remotes / tags / snapshots, resizable, with a branch context menu
- Checkout a local branch, or a remote one — checking out `origin/feature-x` creates and switches to a local tracking branch automatically
- Checkout dirty-tree resolution — when checking out would overwrite local changes, a chooser offers 3 modes in increasing order of risk: stash/switch/reapply, stash/switch/leave stashed (recoverable via Manage Stash), or force switch and discard your changes (genuinely irreversible, gated behind a typed danger-confirm)
- New Branch lets you pick the start point (any local/remote ref), not just HEAD
- Tags: create, delete, and push
- Fetch / Pull / Push, from the top bar or the native Repository menu — Pull offers an explicit merge-or-rebase strategy choice and follows your configured upstream automatically; force push / force-with-lease are gated behind the same danger-confirm flow as other irreversible actions
- "Manage Remotes" dialog — add / edit / rename / remove
- Drag-and-drop cherry-pick and merge (shift-drag) onto HEAD, or right-click a commit row for cherry-pick / merge / revert — all backed by a real 3-way conflict resolver
- Squash-merge, plus explicit fast-forward strategy choice: auto (default) / no-ff (always a real merge commit) / ff-only (refuse unless a fast-forward is possible)
- Linear rebase onto any branch — including multi-commit conflict sequences and mid-sequence skip
- Patch export/apply (`git format-patch` / `git am`), with real 3-way conflict resolution through the existing conflict resolver
- Pluggable external diff/merge tools — hand off a diff or a conflict to your own configured tool (e.g. VS Code, Beyond Compare) instead of GitCat's built-in view
- `git bisect` — mark good/bad/skip, live canvas cues for the narrowing range, automatic first-bad detection
- `git-filter-repo` wizard — scope, preview, typed-confirm, and a full backup/restore safety net for the one genuinely irreversible operation in the app

**Safety Manager**

- Every mutation snapshots first; global Undo (⌘Z) is itself undoable
- Reflog rescue — browse and restore to any historical HEAD position
- fsck-based dangling-object recovery — find and recover a commit no branch, tag, or (often) reflog points to anymore, as a new branch, without ever touching your current branch or HEAD
- rerere status/toggle panel

**Setup + polish**

- First-run setup wizard: pick a repo (click, or drag a folder in), check/fix its git identity, jump into the graph — shown once, not on every launch
- Multi-repository dashboard for tracking and quickly switching between repos you use often
- "Close Repository" — an in-app way back to the empty state
- In-app `.gitignore` / `.mailmap` editors
- A real native app menu (File / Repository / Edit / View / Window / Help) and About panel, not just a default OS stub
- Dark theme by default (light available via the toggle)
- Eight Tama expressions wired into every relevant moment across the app — Reflog Rescue, Dangling-Object Recovery, Plumbing, Pickaxe Search, and the Interactive Rebase planner all get mascot art, and filter-repo/conflict resolution shows a "thinking" face during real work instead of freezing on one expression the whole time

## Install

Download the installer for your platform from the [Releases page](https://github.com/zangjiucheng/GitCat/releases) — macOS (Apple Silicon + Intel), Windows (x86_64 + arm64), and Linux (x86_64 + arm64, `.deb`/`.rpm`/`.AppImage`) are all built from the same tag via a 6-platform release matrix.

> Builds are currently **unsigned** (no code-signing certificate configured yet):
>
> - **macOS**: right-click the app → **Open** the first time to get past Gatekeeper.
> - **Windows**: click **More info** → **Run anyway** on the SmartScreen prompt.

## Development

Requires [Rust](https://www.rust-lang.org/tools/install), [Node](https://nodejs.org) 22+, and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm tauri dev      # launch the app in dev mode
```

Want a repo to poke at instead of pointing GitCat at something real? `pnpm demo` builds one at `~/gitcat-demo` with branches, tags, a submodule, stashes, a diverged remote, an unmerged branch that conflicts with `main` on purpose, and a bisectable bug — see `scripts/make-demo-repo.sh` for the full rundown.

Other useful commands:

```bash
pnpm check          # svelte-check (type-check the frontend)
pnpm build          # build the frontend
pnpm test           # vitest (frontend unit tests)
pnpm docs:dev       # run the docs site (docs/) locally at localhost:5173

cd src-tauri
cargo build         # build the Rust core
cargo test          # run the Rust test suite
```

## Tech stack

- **Rust core** (`src-tauri/`) — [git2](https://github.com/rust-lang/git2-rs) for reads, the `git` CLI for writes (every mutation snapshots first), [tauri-specta](https://github.com/specta-rs/tauri-specta) for a fully typed IPC boundary auto-generated into `src/ipc/bindings.ts`
- **Frontend** — Svelte 5 "islands" (one per feature: resolver, bisect, reflog, rerere, plumbing, filter-repo, setup wizard, sidebar, ⌘K, commit detail) layered over a hand-tuned vanilla canvas for the commit graph itself
- **CI/CD** — GitHub Actions: `cargo test` + `pnpm test` on every push/PR, a 6-platform release matrix (macOS/Linux/Windows × arm64/x86_64) on tagged releases, and a [VitePress](https://vitepress.dev) docs site (`docs/`) auto-deployed to [GitHub Pages](https://zangjiucheng.github.io/GitCat/) on every change

## License

GitCat is free software, licensed under the [GNU General Public License v3.0 or later](LICENSE).

Copyright (C) 2026 Jiucheng Zang
