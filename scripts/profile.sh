#!/usr/bin/env bash
# Builds the isolated `profiling` Cargo profile (see src-tauri/Cargo.toml's
# own [profile.profiling] doc comment for why this is a separate profile,
# not [profile.release] itself) and records a CPU flamegraph of it with
# samply. Requires samply on PATH — see the error message below for the
# one-time install command if it's missing.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/profile.sh [samply-record-args...]

Builds src-tauri in the `profiling` profile (release-optimized, but with
full debug info so the flamegraph resolves real function names instead of
raw addresses) and records it with samply.

Any extra arguments are passed through to `samply record` itself, after
the default `-a` (record all processes — needed because Tauri renders
through a separate WebView2 child process on Windows, not just the main
binary). Example: scripts/profile.sh --rate 2000

Output: samply opens the Firefox Profiler UI (a local web view — nothing
is uploaded anywhere unless you explicitly click "Upload" in it) with a
flamegraph, stack chart, and call tree once you close the app window.
EOF
}

for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
  esac
done

# `command -v` alone is fragile right after a fresh `cargo install`: Windows
# environment-variable updates don't propagate to an already-running shell
# (or anything IT spawns, like this script under pnpm), only to a genuinely
# new process tree — restarting a terminal window/tab often isn't enough if
# it's just a new tab in an already-running terminal app, since that app's
# own cached environment is what gets inherited either way. Rather than
# rely on the caller's PATH being fresh, fall back to the one place `cargo
# install` (with no --root override) always puts it, on every platform.
SAMPLY="$(command -v samply 2>/dev/null || true)"
if [ -z "$SAMPLY" ]; then
  for candidate in "$HOME/.cargo/bin/samply" "$HOME/.cargo/bin/samply.exe"; do
    if [ -x "$candidate" ]; then
      SAMPLY="$candidate"
      break
    fi
  done
fi
if [ -z "$SAMPLY" ]; then
  echo "error: samply isn't on PATH and isn't at ~/.cargo/bin either — install it once with:" >&2
  echo "  cargo install --locked samply" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_TAURI="$SCRIPT_DIR/../src-tauri"

echo "Building src-tauri (profiling profile)..." >&2
( cd "$SRC_TAURI" && cargo build --profile profiling )

BIN="$SRC_TAURI/target/profiling/gitcat.exe"
if [ ! -f "$BIN" ]; then
  # Non-Windows target dirs don't get the .exe suffix — fall back to the
  # extension-less name so this script isn't silently Windows-only.
  BIN="$SRC_TAURI/target/profiling/gitcat"
fi

echo "Recording with $SAMPLY -a $BIN $*"
echo "(close the GitCat window when you're done to end the recording)" >&2
exec "$SAMPLY" record -a "$BIN" "$@"
