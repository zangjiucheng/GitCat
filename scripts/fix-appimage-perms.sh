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
# ARCHITECTURE-NEUTRAL, which it did not use to be. It unpacked with
# `--appimage-extract`, which means running the image's own ELF runtime, so an
# aarch64 AppImage could only be repacked on an aarch64 host — and the release
# pipeline had nothing repacking aarch64 at all as a result. `unsquashfs` reads
# the filesystem without executing anything in it, so one x86_64 runner now
# handles both arches.
#
# That change also fixed a subtler thing. `--appimage-extract` creates every
# directory it writes at 0700 regardless of what the image stores, so the old
# version could not tell a genuinely locked-down directory from the extractor's
# own doing: it chmod'd all of them, every time, and so always reported itself
# as having changed something. `unsquashfs` restores the stored modes, so the
# tree here is now the image's real tree and "nothing to fix" means it.
#
# Needs: unsquashfs + mksquashfs (squashfs-tools).
#
# Usage: scripts/fix-appimage-perms.sh app.AppImage [out.AppImage]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"

src="${1:?usage: fix-appimage-perms.sh <in.AppImage> [out.AppImage]}"
dst="${2:-$src}"
for tool in unsquashfs mksquashfs; do
  command -v "$tool" >/dev/null || { echo "$tool not found (install squashfs-tools)" >&2; exit 2; }
done

# GNU coreutils vs BSD/macOS. Linux is where this runs in CI; staying portable
# is what lets a repack be rehearsed against a real release asset on a Mac
# before it is trusted with one.
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%OLp' "$1"; }
size_of() { stat -c '%s' "$1" 2>/dev/null || stat -f '%z' "$1"; }

abs="$(cd "$(dirname "$src")" && pwd)/$(basename "$src")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A case-INSENSITIVE scratch filesystem silently merges entries whose names
# differ only in case, and this image has such a pair: `GitCat.png` is a real
# file and `gitcat.png` is a symlink, both in the squashfs root. Unpacking on a
# Mac's default APFS therefore loses one of them, and a repack from that tree
# would ship an AppImage missing a file with nothing to show for it.
#
# Caught the first time this script was rehearsed against a real release asset
# on macOS: 370 entries in, 369 out. The verification below would catch it
# anyway, but failing here says WHY instead of just reporting a mismatch.
probe="$work/CaseProbe"
: > "$probe"
if [ -e "$work/caseprobe" ]; then
  rm -f "$probe"
  echo "$work is on a case-insensitive filesystem. This AppImage contains" >&2
  echo "entries differing only in case (GitCat.png and gitcat.png), which such" >&2
  echo "a filesystem cannot hold separately, so a repack here would drop one." >&2
  echo "Set TMPDIR to a case-sensitive volume." >&2
  exit 2
fi
rm -f "$probe"

# Keep the runtime EXACTLY as it was — it is what makes the file self-mounting,
# and slicing at the same offset the filesystem is read from is self-checking.
off="$("$here/appimage-offset.sh" "$abs")"
head -c "$off" "$abs" > "$work/runtime.bin"
[ "$(size_of "$work/runtime.bin")" = "$off" ] || { echo "runtime slice is the wrong size" >&2; exit 1; }

# -n: never prompt. -f: the mktemp dir already exists. No -user-xattrs etc: the
# modes are the subject here and xattrs are carried straight through by the
# repack below.
root="$work/squashfs-root"
unsquashfs -n -f -o "$off" -d "$root" "$abs" >/dev/null

changed=0

# Directories first, and the root among them. A directory the world cannot
# enter makes every file mode inside it moot — which is how v1.4.0 shipped an
# AppImage that could not start even with AppRun.wrapped corrected, because the
# repack of the day only walked `-type f`.
for d in $(find "$root" -type d); do
  m="$(mode_of "$d")"
  case "${m: -1}" in
    1|3|5|7) ;;
    *) chmod go-w,o+rx,g+rx "$d"; echo "  fixed ${d#"$root"}/: $m -> $(mode_of "$d")"; changed=1 ;;
  esac
done

while IFS= read -r f; do
  m="$(mode_of "$f")"
  case "${m: -1}" in
    1|3|5|7) ;;
    # go-w,o+rx rather than a blunt 0755: it takes 0770 to exactly 0755 and
    # leaves an already-correct file alone, without asserting a mode over bits
    # that were set deliberately.
    *) chmod go-w,o+rx "$f"; echo "  fixed ${f#"$root"/}: $m -> $(mode_of "$f")"; changed=1 ;;
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

# ---------------------------------------------------------------------------
# Verify the result BEFORE it replaces anything. This rewrites an asset that is
# then re-signed and shipped, so "it came out the right length" is not enough:
# a repack that drops a file would be signed, uploaded and trusted.
# ---------------------------------------------------------------------------

# Still an AppImage, not just a file of the right size. Via the shared
# resolver, so this works for either architecture too — the old
# `--appimage-offset` here was the last thing tying a repack to its own arch.
new_off="$("$here/appimage-offset.sh" "$work/out.AppImage")"

# The runtime must be the original bytes. Nothing here is supposed to touch it,
# and it is what makes the file self-mounting.
before_rt="$(head -c "$off" "$abs" | cksum)"
after_rt="$(head -c "$new_off" "$work/out.AppImage" | cksum)"
[ "$before_rt" = "$after_rt" ] || {
  echo "the runtime changed — refusing to replace $dst" >&2
  exit 1
}

# Every entry that went in must come out, as the same kind of thing. Type and
# path only: modes are SUPPOSED to differ (that is the point), and a symlink's
# own mode is never consulted by anything.
entry_set() {
  unsquashfs -o "$2" -lls "$1" | awk '
    { type = substr($1, 1, 1)
      path = $0
      sub(/^[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +/, "", path)
      sub(/ -> .*$/, "", path)
      print type " " path }' | sort
}
entry_set "$abs" "$off" > "$work/before.txt"
entry_set "$work/out.AppImage" "$new_off" > "$work/after.txt"
if ! diff -u "$work/before.txt" "$work/after.txt" > "$work/entries.diff"; then
  echo "the repack changed the filesystem's contents — refusing to replace $dst" >&2
  echo "  in:  $(wc -l < "$work/before.txt") entries" >&2
  echo "  out: $(wc -l < "$work/after.txt") entries" >&2
  sed -n '3,40p' "$work/entries.diff" | sed 's/^/  /' >&2
  exit 1
fi

# And it must actually be fixed. The authoritative check, rather than a second
# opinion written here that could drift from it.
"$here/check-appimage-perms.sh" "$work/out.AppImage" >/dev/null || {
  echo "the repack did not produce a world-executable AppImage — refusing to replace $dst" >&2
  "$here/check-appimage-perms.sh" "$work/out.AppImage" >&2 || true
  exit 1
}

mv "$work/out.AppImage" "$dst"
echo "  wrote $dst ($(size_of "$dst") bytes)"
echo "  NOTE: re-sign it — the existing .sig and latest.json no longer match."
