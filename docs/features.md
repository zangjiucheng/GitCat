# Features

GitCat is built around one idea: every operation that touches your history should be reversible. That shows up everywhere below, not just in the dedicated Safety Manager section.

## Core graph + history

- **Fast commit graph** — reads via [git2](https://github.com/rust-lang/git2-rs), laid out by a hand-tuned Rust swimlane algorithm, and rendered on a virtualized canvas. Stays smooth even on repos with tens of thousands of commits, since only the visible rows are ever drawn.
- **Full commit detail panel** — author/committer split (so you can actually tell a rebase or cherry-pick apart from the original commit), GPG signature status, diffstat, a file tree, and a syntax-highlighted diff.
- **⌘K command palette** — fuzzy search across every loaded commit and ref, plus quick actions for Bisect, Reflog, Rerere, and Plumbing without leaving the keyboard.

## Everyday git, made safe

- A resizable sidebar listing branches, remotes, tags, and snapshots, with a branch context menu for the usual operations.
- Checkout a local branch, or a remote one directly — checking out `origin/feature-x` creates and switches to a local tracking branch automatically, the way most people expect it to work.
- **New Branch** lets you pick the start point from any local or remote ref, not just HEAD.
- Fetch / Pull (fast-forward only, so it never silently creates a merge commit) / Push, from the top bar or the native Repository menu.
- **Drag-and-drop cherry-pick and merge** (shift-drag) directly onto HEAD, backed by a real 3-way conflict resolver when things don't apply cleanly.
- **Linear rebase** onto any branch, including multi-commit conflict sequences and the ability to skip a commit mid-sequence.
- **Interactive rebase** — a drag-to-reorder planner (pick / edit / squash / fixup / drop) before it ever touches your history.
- **`git bisect`** — mark commits good/bad/skip, watch the candidate range narrow live on the canvas, and get the first-bad commit found automatically.
- **Submodules** — init/update (including `--recursive`), add, deinit/remove, a bulk `foreach` runner, and "Open" to manage a submodule exactly like its own top-level repo.
- **`git-filter-repo` wizard** — scope, preview, a typed confirmation, and a full backup/restore safety net for the one genuinely irreversible operation in the app.

## Safety Manager

- Every mutation snapshots first. Global Undo (⌘Z) is always one keystroke away — and Undo is itself undoable, so there's no "point of no return" hiding behind a single click.
- **Reflog rescue** — browse every historical HEAD position this repo remembers and restore to any of them; the restore itself is just another snapshot-first, undoable mutation.
- **rerere status/toggle panel** — see what git has already recorded a resolution for, and flip `rerere.enabled` without touching a terminal.

## Setup + polish

- A first-run setup wizard: pick a repo (click, or drag a folder in), check/fix its git identity, and jump straight into the graph. Shown once, not on every launch.
- A real native app menu (File / Repository / Edit / View / Tools / Window / Help) and About panel — not just a default OS stub.
- A **Tools** menu (and matching ⌘K actions) for Bisect, Reflog, Rerere, and Plumbing, each opening on demand instead of sitting in a permanent panel.
- Dark theme by default, with a light theme one click away.
- Eight Tama expressions reacting to what's actually happening — searching, thinking, celebrating, or genuinely alarmed when you're about to do something you can't take back.
