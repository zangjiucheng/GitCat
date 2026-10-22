#!/usr/bin/env bash
# Print the byte offset of the squashfs filesystem inside an AppImage.
#
# An AppImage is an ELF runtime with a squashfs APPENDED to it, so this number
# is where the filesystem starts and where the runtime ends. Both
# check-appimage-perms.sh and fix-appimage-perms.sh need it, and they must agree
# — one slicing the runtime at a different place than the other inspects would
# be a silent corruption — so it lives here rather than in both.
#
# `<img> --appimage-offset` is the authoritative answer, but it only works for
# an image built for THIS machine's architecture, because asking means running
# that image's own ELF runtime. The fallback is what lets an aarch64 AppImage be
# inspected and repacked from an x86_64 runner, which is the whole reason the
# release pipeline can treat both arches the same way.
#
# Usage: scripts/appimage-offset.sh app.AppImage
set -euo pipefail

img="${1:?usage: appimage-offset.sh <app.AppImage>}"
[ -f "$img" ] || { echo "$img is not a file" >&2; exit 2; }

if off="$("$img" --appimage-offset 2>/dev/null)" && [ -n "$off" ]; then
  printf '%s\n' "$off"
  exit 0
fi

# Locate the squashfs superblock directly. VALIDATED, not merely magic-matched:
# "hsqs" is four bytes and a 45 MB binary will contain it by chance, so the
# version and the block_size/block_log agreement are what make a hit real.
# (The v1.5.0 images sit at 944632 and 936456, neither 4 KiB-aligned, which is
# why this scans rather than steps.)
exec python3 - "$img" <<'SUPERBLOCK_SCAN'
import struct, sys

path = sys.argv[1]
CHUNK = 32 << 20
with open(path, 'rb') as f:
    data = f.read(CHUNK)

pos = 0
while True:
    pos = data.find(b'hsqs', pos)
    if pos < 0 or pos + 32 > len(data):
        sys.exit('could not locate a squashfs superblock in %s' % path)
    block_size, = struct.unpack_from('<I', data, pos + 12)
    block_log, = struct.unpack_from('<H', data, pos + 22)
    major, = struct.unpack_from('<H', data, pos + 28)
    if major == 4 and 0 < block_log < 32 and block_size == (1 << block_log):
        print(pos)
        break
    pos += 4
SUPERBLOCK_SCAN
