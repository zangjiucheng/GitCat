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

if ! command -v samply >/dev/null 2>&1; then
  echo "error: samply isn't on PATH — install it once with:" >&2
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

echo "Recording with samply -a $BIN $*"
echo "(close the GitCat window when you're done to end the recording)" >&2
exec samply record -a "$BIN" "$@"
