#!/usr/bin/env bash
# Repack an AppImage with its launch path world-executable.
#
# The companion to check-appimage-perms.sh, which explains WHY this is needed:
# linuxdeploy's x86_64 AppRun ships 0770, so the app cannot start wherever the
# running user does not own the file. This rewrites the squashfs with the modes
# corrected and leaves everything else alone.
#
# It does NOT re-sign. An AppImage repacked here no longer matches the minisign
# `.sig` that was generated over the original bytes, so whoever calls this is
# responsible for re-signing and for updating latest.json — that is the Linux
# updater's chain of trust, and silently breaking it would be worse than the bug
# this fixes.
#
# Needs: mksquashfs (squashfs-tools). Linux only — extracting an AppImage runs
# its own ELF runtime.
#
# Usage: scripts/fix-appimage-perms.sh app.AppImage [out.AppImage]
set -euo pipefail

src="${1:?usage: fix-appimage-perms.sh <in.AppImage> [out.AppImage]}"
dst="${2:-$src}"
command -v mksquashfs >/dev/null || { echo "mksquashfs not found (install squashfs-tools)" >&2; exit 2; }

abs="$(cd "$(dirname "$src")" && pwd)/$(basename "$src")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chmod +x "$abs"

# An AppImage is its ELF runtime with a squashfs appended. Keep the runtime
# EXACTLY as it was — it is what makes the file self-mounting, and it is also
# where --appimage-offset comes from, so slicing by that offset is self-checking.
off="$("$abs" --appimage-offset)"
head -c "$off" "$abs" > "$work/runtime.bin"
[ "$(stat -c '%s' "$work/runtime.bin")" = "$off" ] || { echo "runtime slice is the wrong size" >&2; exit 1; }

( cd "$work" && "$abs" --appimage-extract >/dev/null )
root="$work/squashfs-root"

changed=0
while IFS= read -r f; do
  m="$(stat -c '%a' "$f")"
  case "${m: -1}" in
    1|3|5|7) ;;
    # go-w,o+rx rather than a blunt 0755: it takes 0770 to exactly 0755 and
    # leaves an already-correct file alone, without asserting a mode over bits
    # that were set deliberately.
    *) chmod go-w,o+rx "$f"; echo "  fixed ${f#"$root"/}: $m -> $(stat -c '%a' "$f")"; changed=1 ;;
  esac
done < <(find "$root" -type f -perm -u+x)

if [ "$changed" -eq 0 ]; then
  echo "  nothing to fix — $src is already world-executable where it matters"
  [ "$dst" = "$src" ] || cp "$abs" "$dst"
  exit 0
fi

# -root-owned because that is what an AppImage wants anyway: nobody running it
# is the owner, so `other` is the only class that can ever apply.
# zstd at 128K to match what the Tauri bundler produced, so the repack does not
# quietly change the compression the release was built with.
mksquashfs "$root" "$work/fs.squashfs" -root-owned -noappend -comp zstd -b 131072 -quiet -no-progress
cat "$work/runtime.bin" "$work/fs.squashfs" > "$work/out.AppImage"
chmod +x "$work/out.AppImage"
# It must still be an AppImage afterwards, not just a file of the right length.
"$work/out.AppImage" --appimage-offset >/dev/null
mv "$work/out.AppImage" "$dst"
echo "  wrote $dst ($(stat -c '%s' "$dst") bytes)"
echo "  NOTE: re-sign it — the existing .sig and latest.json no longer match."
