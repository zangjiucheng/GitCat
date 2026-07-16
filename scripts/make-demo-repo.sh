#!/usr/bin/env bash
# Builds a persistent, richly-featured sample git repository to open in GitCat
# for manual exploration — not an E2E fixture (those live under e2e/fixtures
# and src-tauri/tests/common, are disposable, and get torn down after each
# test). This one is meant to sit on disk and be poked at by hand.
#
# target-dir itself (default: ~/gitcat-demo) IS the repo — open exactly that
# folder in GitCat. A sibling target-dir-support/ holds the scaffolding that
# isn't meant to be opened directly:
#   origin.git/       a bare remote — makes Fetch/Pull/Push do real work
#   widget-lib/       a small standalone repo, added into the repo as a submodule
#
# Covers: multiple branches, a --no-ff merge, an unmerged branch that WILL
# conflict with main (drag it onto HEAD in-app to try the conflict resolver),
# annotated + lightweight tags, a submodule, two stashes, a dirty working
# tree (staged + unstaged + untracked), diverged history against origin in
# both directions (something to fetch, something to push), reflog activity
# from a detour into detached HEAD, and a subtle off-by-one bug introduced
# partway through main's history with no later fix commit — a real target
# for `git bisect`.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/make-demo-repo.sh [target-dir] [--force]

  target-dir   Where to build the demo repo itself (default: ~/gitcat-demo)
  --force      Delete an existing target-dir first instead of erroring out

Open target-dir in GitCat when it's done — it IS the repo, not a folder
containing one.
EOF
}

FORCE=0
BASE=""
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --force) FORCE=1 ;;
    *) BASE="$arg" ;;
  esac
done
BASE="${BASE:-$HOME/gitcat-demo}"
SUPPORT="${BASE}-support"

if [ -e "$BASE" ]; then
  if [ "$FORCE" = 1 ]; then
    rm -rf "$BASE" "$SUPPORT"
  else
    echo "error: $BASE already exists — rerun with --force to rebuild it" >&2
    exit 1
  fi
fi
mkdir -p "$BASE" "$SUPPORT"

REPO="$BASE"
ORIGIN="$SUPPORT/origin.git"
SUBLIB="$SUPPORT/widget-lib"

git_id() {
  git -C "$1" config user.name "GitCat Demo"
  git -C "$1" config user.email "demo@gitcat.test"
  # Same rationale as e2e/fixtures/tempRepo.ts: never let a demo repo hang on
  # a real GPG passphrase prompt because of the host's global config.
  git -C "$1" config commit.gpgsign false
  git -C "$1" config tag.gpgsign false
}

# --- submodule source repo -------------------------------------------------
git init -q -b main "$SUBLIB"
git_id "$SUBLIB"
cat > "$SUBLIB/README.md" <<'EOF'
# widget-lib

A tiny standalone library, vendored into the demo repo as a submodule.
EOF
git -C "$SUBLIB" add -A
git -C "$SUBLIB" commit -q -m "Initial commit"

cat > "$SUBLIB/index.ts" <<'EOF'
export function widget(size: number): string {
  return `[widget:${size}]`;
}
EOF
git -C "$SUBLIB" add -A
git -C "$SUBLIB" commit -q -m "Add widget() export"

# --- main repo --------------------------------------------------------------
git init -q -b main "$REPO"
git_id "$REPO"

cat > "$REPO/.gitignore" <<'EOF'
node_modules
*.log
EOF
cat > "$REPO/README.md" <<'EOF'
# demo

A playground repo for exploring GitCat.

## Roadmap

- [ ] Ship the widget renderer
EOF
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "Initial commit"

mkdir -p "$REPO/src" "$REPO/docs"
cat > "$REPO/src/calc.ts" <<'EOF'
export function add(a: number, b: number): number {
  return a + b;
}

export function sub(a: number, b: number): number {
  return a - b;
}
EOF
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "Add src/calc.ts"

cat > "$REPO/docs/notes.md" <<'EOF'
# Notes

- calc.ts holds basic arithmetic helpers.
EOF
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "Add docs/notes.md"

# Bisect target: range() is documented as inclusive of `b` but the loop is
# exclusive. No later commit fixes it — `git bisect` between this commit and
# HEAD, checking range(1, 5) for a trailing 5, finds it.
cat >> "$REPO/src/calc.ts" <<'EOF'

/** Inclusive range: range(1, 5) => [1, 2, 3, 4, 5] */
export function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i < b; i++) out.push(i);
  return out;
}
EOF
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "Add calc.range()"
BUG_SHA=$(git -C "$REPO" rev-parse HEAD)

cat > "$REPO/src/cli.ts" <<'EOF'
import { add, sub, range } from "./calc";

const cmd = process.argv[2];
if (cmd === "add") console.log(add(Number(process.argv[3]), Number(process.argv[4])));
if (cmd === "range") console.log(range(Number(process.argv[3]), Number(process.argv[4])));
EOF
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "Add src/cli.ts"

cat > "$REPO/package.json" <<'EOF'
{
  "name": "demo",
  "version": "0.1.0",
  "private": true
}
EOF
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "Add package.json"

# A large generated file — big enough (~450 entries, past line 400) to exercise
# the hunk-level conflict editor's large-file path, not just a one-line diff.
cat > "$REPO/src/data.ts" <<'EOF'
export interface Item {
  id: number;
  name: string;
}

export const items: Item[] = [
EOF
for i in $(seq 1 450); do
  echo "  { id: $i, name: \"item-$i\" }," >> "$REPO/src/data.ts"
done
cat >> "$REPO/src/data.ts" <<'EOF'
];
EOF
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "Add src/data.ts"
DATA_SHA=$(git -C "$REPO" rev-parse HEAD)

# --- feature branch, merged with --no-ff -----------------------------------
git -C "$REPO" branch feature/dark-mode
git -C "$REPO" checkout -q feature/dark-mode
mkdir -p "$REPO/src"
cat > "$REPO/src/styles.css" <<'EOF'
:root { --bg: #111; --fg: #eee; }
body { background: var(--bg); color: var(--fg); }
EOF
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "Add dark-mode stylesheet"

cat >> "$REPO/src/styles.css" <<'EOF'

.btn { border-radius: 6px; }
EOF
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "Round button corners"

git -C "$REPO" checkout -q main
git -C "$REPO" merge --no-ff -q -m "Merge feature/dark-mode" feature/dark-mode

cat >> "$REPO/docs/notes.md" <<'EOF'
- Dark mode lives in src/styles.css.
EOF
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "Note dark mode in docs"

git -C "$REPO" tag -a v0.1.0 -m "v0.1.0"

sed -i.bak 's/^## Roadmap$/## Shipped So Far/' "$REPO/README.md" && rm -f "$REPO/README.md.bak"
cat >> "$REPO/README.md" <<'EOF'
- [x] Ship the widget renderer
EOF
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "Check off widget renderer"
git -C "$REPO" tag checkpoint

# --- unmerged branch that will conflict with main on purpose ---------------
# Left un-merged deliberately: drag it onto HEAD (or shift-drag to merge) in
# GitCat to exercise the real 3-way conflict resolver. Both sides rename the
# EXACT SAME "## Roadmap" heading line to different text since main~1 (main
# to "## Shipped So Far" above, this branch to "## Upcoming" below) —
# guaranteed to conflict, unlike editing merely nearby/non-overlapping lines.
git -C "$REPO" branch conflict/rename-roadmap main~1
git -C "$REPO" checkout -q conflict/rename-roadmap
sed -i.bak 's/^## Roadmap$/## Upcoming/' "$REPO/README.md" && rm -f "$REPO/README.md.bak"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "Rename Roadmap section to Upcoming"
git -C "$REPO" checkout -q main

# --- unmerged branch that will conflict with main on a LARGE file ----------
# Branches from DATA_SHA (before src/data.ts grew any further) and edits the
# item-420 entry — past line 400, deep enough that a naive save would've hit
# the large-file truncation bug the hunk-level conflict editor used to have.
git -C "$REPO" branch conflict/large-file-tweak "$DATA_SHA"
git -C "$REPO" checkout -q conflict/large-file-tweak
sed -i.bak 's/"item-420"/"item-420-branch-edit"/' "$REPO/src/data.ts" && rm -f "$REPO/src/data.ts.bak"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "Rename item-420 on large-file-tweak branch"
git -C "$REPO" checkout -q main

# main also edits that same item-420 entry, to a different value, so the
# branch above genuinely conflicts with main instead of auto-merging clean.
sed -i.bak 's/"item-420"/"item-420-main-edit"/' "$REPO/src/data.ts" && rm -f "$REPO/src/data.ts.bak"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "Rename item-420 on main"

# --- unmerged branch that merges CLEANLY with main --------------------------
# No conflict at all — left unmerged so it's a clean pick alongside the two
# conflicting branches above when trying the Merge Multiple Branches tool.
git -C "$REPO" branch feature/quick-win
git -C "$REPO" checkout -q feature/quick-win
cat > "$REPO/docs/faq.md" <<'EOF'
# FAQ

**Q: Is this repo real?**
A: Yes — it's a generated demo repo for exploring GitCat.
EOF
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "Add docs/faq.md"
git -C "$REPO" checkout -q main

# --- submodule ---------------------------------------------------------------
git -C "$REPO" -c protocol.file.allow=always submodule add -q "$SUBLIB" vendor/widget-lib
git -C "$REPO" commit -q -m "Add vendor/widget-lib submodule"

# --- detour into detached HEAD, back to main — gives Reflog something real ---
# BUG_SHA predates the submodule, so leaving it just warns (stderr) that it
# won't rmdir vendor/widget-lib's now-populated worktree — expected, harmless,
# and gone once we're back on main; silenced so a clean run doesn't look broken.
git -C "$REPO" checkout -q "$BUG_SHA" 2>/dev/null
git -C "$REPO" checkout -q main 2>/dev/null

# --- remote: diverge in both directions --------------------------------------
git init -q --bare "$ORIGIN"
git -C "$REPO" remote add origin "$ORIGIN"
git -C "$REPO" push -q -u origin main --tags

# Something only origin has (so Fetch/Pull have real work to do), authored
# through a throwaway clone so the bare repo itself is never touched directly.
SCRATCH=$(mktemp -d)
git clone -q "$ORIGIN" "$SCRATCH/scratch"
git_id "$SCRATCH/scratch"
echo "- Deployed to staging." >> "$SCRATCH/scratch/docs/notes.md"
git -C "$SCRATCH/scratch" commit -q -am "Note staging deploy"
git -C "$SCRATCH/scratch" push -q origin main
rm -rf "$SCRATCH"

# Something only the local repo has (so Push has real work to do too).
cat >> "$REPO/docs/notes.md" <<'EOF'
- TODO: write more notes.
EOF
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "Add TODO to notes"

# --- stashes -----------------------------------------------------------------
echo "- Local scratch thought." >> "$REPO/docs/notes.md"
git -C "$REPO" stash push -q -m "WIP: scratch note"

cat >> "$REPO/src/calc.ts" <<'EOF'

export function mul(a: number, b: number): number {
  return a * b;
}
EOF
git -C "$REPO" stash push -q -m "WIP: mul() draft"

# --- dirty working tree: staged + unstaged + untracked -----------------------
sed -i.bak 's/console.log(add/console.log("sum:", add/' "$REPO/src/cli.ts" && rm -f "$REPO/src/cli.ts.bak"
git -C "$REPO" add "$REPO/src/cli.ts"

echo "  - calc.range() may have an edge case worth double-checking." >> "$REPO/docs/notes.md"

echo "scratch" > "$REPO/scratch.txt"

cat <<EOF

Demo repo ready at: $REPO
  (support files — not a repo to open — live in: $SUPPORT)

Open $REPO in GitCat (File > Open Repo) to explore:
  - branches: main, feature/dark-mode (merged), conflict/rename-roadmap (unmerged — try merging it),
    conflict/large-file-tweak (unmerged — conflicts on src/data.ts past line 400, good for the
    hunk-level conflict editor), feature/quick-win (unmerged, merges cleanly)
  - try ⌘K → "Merge Multiple Branches" with those three unmerged branches: sequential mode to
    merge quick-win cleanly then resolve the large-file conflict, octopus mode to see it abort
    outright once a conflicting branch is in the mix
  - tags: v0.1.0 (annotated), checkpoint (lightweight)
  - a submodule at vendor/widget-lib
  - 2 stashes, a staged file, an unstaged edit, and an untracked file
  - origin/main both ahead and behind local main — try Fetch, Pull, Push
  - a bisectable bug: calc.range(a, b) is documented inclusive of b but isn't
    (introduced at $BUG_SHA, never fixed)
EOF
