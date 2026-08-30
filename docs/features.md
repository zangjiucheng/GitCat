# Features

GitCat is built around one idea: every operation that touches your history should be reversible. That shows up everywhere below, not just in the dedicated Safety Manager section.

## Core graph + history

- **Fast commit graph** — reads via [git2](https://github.com/rust-lang/git2-rs), laid out by a hand-tuned Rust swimlane algorithm, and streamed onto a virtualized canvas. No hard cap on history depth: the newest commits paint almost instantly while the rest of a very large history streams in behind them, and only the visible rows are ever drawn, so it stays smooth on repos with hundreds of thousands of commits. Scrolling keeps its **text readable** the whole time (a scroll-blit path copies the last frame and only redraws the thin newly-exposed strip, instead of re-rendering every row each frame).
- **Instant everyday operations** — switching branches, creating/renaming/deleting a branch or tag, and staging don't re-walk the whole history: the graph recognises the commit set is unchanged and updates its refs in place, so a checkout on a 150k-commit repo is immediate rather than a multi-second reload. Anything that genuinely adds or removes commits (commit, merge, pull, …) still does a full, correct reload.
- **Orientation at a glance** — a dedicated left branch/tag column keeps ref labels out of the message text, the current **HEAD wears a clear "you are here" marker** (an accent ring on its dot plus a bar down its row), and every commit already merged into your current branch is drawn dimmed so unmerged work stands out. `⌘⇧H` (or the crosshair button in the top bar) recentres the graph on HEAD from wherever you've scrolled.
- **Branch actions on the graph itself** — right-click a branch or tag label to check out, rename, or delete it (or check out a remote-tracking branch), a menu separate from the commit right-click menu; hover any label to see its full name when it's truncated.
- **Full commit detail panel** — select a commit to see its full detail across two tabs: **Commit** (an author/committer split, so you can actually tell a rebase or cherry-pick apart from the original commit, plus GPG signature status) and **Changes** (a diffstat, a file tree, and a syntax-highlighted diff that can expand to a full-page view — with a resizable file list and full paths on hover) — for reading a real changeset comfortably.
- **Image and PDF diffs** — a binary change isn't just "Binary files differ": images and PDFs get a real side-by-side before/after preview, with a zoom lightbox and a download button for either side. PDFs are rasterized by PDFium in the Rust core rather than in the webview, so a large document doesn't freeze the UI.
- **⌘K command palette** — fuzzy search across commits and refs (including branches that aren't currently shown in the sidebar — pick one and it appears on the graph), quick actions for Bisect, Reflog, Rerere, and Plumbing, and an in-app **Help** page, all without leaving the keyboard.
- **Vim-style keyboard navigation** — `j`/`k` to move a row at a time, `gg`/`G` to jump to the top or bottom of the graph, `Ctrl-D`/`Ctrl-U` to page through it, and `/` to search, all without touching the mouse.
- **git blame** — a line-annotation view with per-hunk attribution (commit SHA and author), an ignore-whitespace toggle, and it follows the file's rename history automatically.
- **Per-file history** — browse a single file's commits with rename-following, like `git log --follow`: a renamed file's history continues seamlessly under its old path instead of stopping cold at the rename.
- **Search by author** (`git log --author`) — list every commit by a given person across all history (matched against name and email), not just whatever's loaded on screen.
- **Pickaxe / diff-content search** (`git log -S`/`-G`) — find every commit whose diff touched a given string or pattern, not just the ones whose commit message happens to mention it.

## Everyday git, made safe

- A resizable sidebar listing branches, remotes, tags, and snapshots, with a branch context menu for the usual operations.
- **Branch visibility filter** — hide/show branches individually to declutter a busy graph, "Hide all branches" to start from a clean slate before hand-picking a few, or flip on **Auto** to always show just the current branch plus anything with unpushed or unmerged work (and auto-hide branches that have gone stale).
- **Live refresh** — the graph and working-directory view pick up changes made outside GitCat (a terminal commit, another tool, a background fetch) on their own; a manual Refresh button is always there too if you ever want to force it.
- **Tags** — create, delete, and push tags right from the sidebar, no terminal needed.
- Checkout a local branch, or a remote one directly — checking out `origin/feature-x` creates and switches to a local tracking branch automatically, the way most people expect it to work.
- **New Branch** lets you pick the start point from any local or remote ref, not just HEAD.
- Fetch / Pull / Push, from the top bar or the native Repository menu — Pull asks you to choose merge or rebase explicitly, following your configured upstream automatically, so it never silently picks a strategy behind your back. Push a non-current branch, or push to a differently-named remote branch, right from the sidebar.
- **Manage Remotes** — add, edit, rename, and remove remotes from a dedicated dialog instead of hand-editing `.git/config`.
- **Open Terminal** — drop into a real terminal at the repo's root when you need a raw shell, from the Tools menu/⌘K.
- **Revert** is a first-class operation alongside cherry-pick and merge, not a workaround — right-click a commit to revert it, backed by the same 3-way conflict resolver when it doesn't apply cleanly.
- **Right-click context menu** on any commit row for cherry-pick, merge, or revert — the point-and-click alternative to drag-and-drop.
- **Drag-and-drop cherry-pick and merge** (shift-drag) directly onto HEAD, backed by a real 3-way conflict resolver when things don't apply cleanly.
- **Merge strategy control** — squash-merge, or an explicit fast-forward choice: auto (default), no-ff (always leaves a real merge commit), or ff-only (refuses unless a fast-forward is possible).
- **Linear rebase** onto any branch, including multi-commit conflict sequences and the ability to skip a commit mid-sequence.
- **Interactive rebase** — a drag-to-reorder planner (pick / edit / squash / fixup / drop) before it ever touches your history.
- **`git bisect`** — mark commits good/bad/skip, watch the candidate range narrow live on the canvas, and get the first-bad commit found automatically.
- **Submodules** — init/update (including `--recursive`), add, deinit/remove, and "Open" to manage a submodule exactly like its own top-level repo.
- **Patch export/apply** (`git format-patch` / `git am`) — hand a commit or range to someone outside GitCat, or bring one in, with real 3-way conflict resolution through the same resolver used everywhere else.
- **Pluggable external diff/merge tools** — hand a diff or a conflict off to your own configured tool (VS Code, Beyond Compare, or anything else) instead of GitCat's built-in view.
- **`git-filter-repo` wizard** — scope, preview, a typed confirmation, and a full backup/restore safety net for the one genuinely irreversible operation in the app.

## Working directory

- **Stage / unstage** individual files, write a commit, or discard changes, from a real working-directory view — not just a flat list of file paths.
- **Hunk and line-level staging** (a `git add -p` equivalent) — select specific lines or a whole hunk in the working-directory diff and stage, unstage, or discard just those, not the whole file's change at once; a per-hunk toolbar plus per-line checkboxes with shift-click range select.
- **Stash** — save, apply, pop, and drop, the operations you actually reach for day to day.

## Safety Manager

- Every mutation snapshots first. Global Undo (⌘Z) is always one keystroke away — and Undo is itself undoable, so there's no "point of no return" hiding behind a single click.
- **Reflog rescue** — browse every historical HEAD position this repo remembers and restore to any of them; the restore itself is just another snapshot-first, undoable mutation.
- **rerere status/toggle panel** — see what git has already recorded a resolution for, and flip `rerere.enabled` without touching a terminal.
- **Checkout dirty-tree resolution** — when switching branches would overwrite local changes, a chooser offers three explicit paths in increasing order of risk: stash → switch → reapply; stash → switch → leave stashed (recoverable later from the working directory's own Stash tab); or force-switch and discard, genuinely irreversible and gated behind a typed danger-confirm.
- **Force push**, with a real choice between force-with-lease (refuses if the remote moved since your last fetch) and a raw override — both gated behind the same typed danger-confirm flow as every other irreversible action.
- **Dangling-object recovery** — runs `git fsck` to find a commit no branch, tag, or (often) reflog points to anymore, and recovers it as a new branch without ever touching your current branch or HEAD.

## Setup + polish

- A first-run setup wizard: pick a repo (click, or drag a folder in), check/fix its git identity, and jump straight into the graph. Shown once, not on every launch.
- **Close Repository** — an in-app way back to the empty state, no need to quit and relaunch just to point GitCat at a different repo.
- **Repositories dashboard** (`⌘O`) — track the repos you use often and jump between them without hunting for the folder each time; a search box filters the list by name, path, or branch (Enter opens the top hit), and it's reachable from the Tools menu even when no repo is currently open.
- A real native app menu (File / Repository / Edit / View / Tools / Window / Help) and About panel — not just a default OS stub.
- **Works with repos on a WSL path** (`\\wsl.localhost\<distro>\...`) — remote operations (fetch/pull/push, submodules) route through the distro's own git, so credentials resolve the way they would inside WSL itself, not against Windows'.
- A **Tools** menu (and matching ⌘K actions) for Bisect, Reflog, Rerere, Plumbing, Manage Remotes, Pickaxe search, External Tools, Dangling Commits recovery, Repo file editors, and Patch export/apply, each opening on demand instead of sitting in a permanent panel.
- **Repo file editors** — view and edit `.gitignore` and `.mailmap` right inside GitCat, no dropping to a terminal or another editor required.
- Dark theme by default, with a light theme one click away.
- **Eight Tama expressions** reacting to what's actually happening — searching, thinking, celebrating, or genuinely alarmed when you're about to do something you can't take back — now wired into every relevant moment across the app, not just a couple of modals: Reflog Rescue, Dangling-Object Recovery, Plumbing, Pickaxe Search, and the Interactive Rebase planner all get mascot art, and filter-repo/conflict-resolution shows a genuine "thinking" face while it works instead of freezing on one expression the whole time.
