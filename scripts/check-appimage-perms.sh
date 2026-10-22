#!/usr/bin/env bash
# Fail if an AppImage ships a launch-path file the world cannot execute.
#
# WHY THIS EXISTS
#
# v1.3.2's x86_64 AppImage shipped `AppRun.wrapped` as 0770. `AppRun` is a shell
# script linuxdeploy generates whose last line is `exec "$this_dir"/AppRun.wrapped`,
# so with no `other` execute bit the app cannot start at all wherever the running
# user does not own the file. That is not a corner case:
#
#   * any sandbox (firejail, bubblewrap) — which is how it was found, by the
#     AppImage catalog's own test: "AppRun.wrapped: Permission denied"
#   * APPIMAGE_EXTRACT_AND_RUN=1, the fallback where FUSE is unavailable, and
#     what a lot of CI uses
#   * AppImageLauncher-style integration that extracts and re-owns files
#
# The aarch64 AppImage of that same release was 0755, so this is not something
# this repo configures — it is whichever AppRun the arch's linuxdeploy embeds.
# Which is the reason for a guard rather than a one-time fix: nothing here
# controls it, and it shipped broken once without anyone noticing.
#
# WHY IT READS THE SQUASHFS AND NEVER AN EXTRACTED TREE
#
# This script used to answer the question by running `--appimage-extract` and
# walking the result. That is sound for files and WRONG for directories: the
# AppImage runtime creates every directory it extracts at 0700 and never fixes
# them up afterwards, so an extracted tree reports `usr/`, `usr/bin/` and the
# root itself as 0700 no matter what the image actually stores.
#
# Measured on the v1.5.0 assets, stored modes read straight out of the squashfs:
#
#   aarch64 — 137 directories, ALL 0755 (one 0777), AppRun 0755, AppRun.wrapped
#             0755, and not one file that the owner can execute and the world
#             cannot. A completely clean image.
#   x86_64  — 57 directories, ALL 0755 (one 0777), AppRun 0755, and exactly one
#             genuine defect: AppRun.wrapped at 0770.
#
# Extracted, both of those legs instead reported ~150 directories "BROKEN  is
# 700" — every one a fabrication of the extractor. The aarch64 leg had no real
# finding at all and still failed the release, which took the repack and the
# finalize job down with it (both `needs: build`). So the extraction artifact is
# not cosmetic: it is what stopped v1.5.0 shipping.
#
# `unsquashfs -lls` reads the modes the image really carries, needs no FUSE, and
# does not care which architecture the AppImage is for — an arm64 image reads
# fine on an x86_64 host, which `--appimage-extract` cannot do at all because it
# has to run that image's own ELF runtime.
#
# Usage:
#   scripts/check-appimage-perms.sh app.AppImage [more.AppImage...]
#   scripts/check-appimage-perms.sh path/to/squashfs-root      # already extracted
#
# The directory form stays for a tree a caller prepared itself — which is what
# fix-appimage-perms.sh verifies before it hands the tree to mksquashfs, and the
# only form that runs without squashfs-tools (so it is also the form this
# script's own test uses on a Mac).
set -euo pipefail

# GNU coreutils vs BSD/macOS, for the directory form only.
mode_of() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%OLp' "$1"
}

# World-executable means the last digit of the octal mode has the 1 bit.
world_x() {
  local m="${1: -1}"
  case "$m" in 1|3|5|7) return 0 ;; *) return 1 ;; esac
}

# ---------------------------------------------------------------------------
# The squashfs form: what the image actually stores.
# ---------------------------------------------------------------------------

# `ls -l` style mode string -> octal, so every message in this script speaks the
# same octal the release notes and the AppImage spec do. Positions are fixed:
# 1 is the type, 2-4 user, 5-7 group, 8-10 other. setuid/setgid/sticky replace
# the x in their own triad with s/S/t/T, and the capital forms mean the execute
# bit is NOT set — which is the whole thing being tested, so they must not be
# read as executable.
rwx_to_octal() {
  local s="$1" i=0 oct="" triad
  for i in 1 4 7; do
    triad="${s:$i:3}"
    local n=0
    case "${triad:0:1}" in r) n=$((n + 4)) ;; esac
    case "${triad:1:1}" in w) n=$((n + 2)) ;; esac
    case "${triad:2:1}" in x | s | t) n=$((n + 1)) ;; esac
    oct="$oct$n"
  done
  printf '%s' "$oct"
}

appimage_offset() {
  local img="$1" off=""
  # The runtime in the ELF header answers this, and it is the same number
  # fix-appimage-perms.sh slices the runtime off at. Only works for an image
  # built for this machine's architecture, so it is tried and not relied on.
  if off="$("$img" --appimage-offset 2>/dev/null)" && [ -n "$off" ]; then
    printf '%s' "$off"
    return 0
  fi
  # Cross-architecture fallback: locate the squashfs superblock directly. The
  # filesystem is APPENDED to the runtime, never interleaved, so the first
  # VALIDATED superblock is it. Validated, not merely magic-matched: "hsqs" is
  # four bytes and a 45 MB binary will contain it by chance, so the version and
  # the block_size/block_log agreement are what make a hit real. (The two
  # v1.5.0 images sit at 944632 and 936456, neither 4 KiB-aligned, which is why
  # this scans rather than steps.)
  python3 - "$img" <<'SUPERBLOCK_SCAN'
import struct, sys

with open(sys.argv[1], 'rb') as f:
    data = f.read(32 << 20)

pos = 0
while True:
    pos = data.find(b'hsqs', pos)
    if pos < 0 or pos + 32 > len(data):
        sys.exit('could not locate a squashfs superblock in %s' % sys.argv[1])
    block_size, = struct.unpack_from('<I', data, pos + 12)
    block_log, = struct.unpack_from('<H', data, pos + 22)
    major, = struct.unpack_from('<H', data, pos + 28)
    if major == 4 and 0 < block_log < 32 and block_size == (1 << block_log):
        print(pos)
        break
    pos += 4
SUPERBLOCK_SCAN
}

check_image() {
  local img="$1" fail=0 off
  command -v unsquashfs >/dev/null || {
    echo "  unsquashfs not found — install squashfs-tools (this check reads the" >&2
    echo "  stored modes; an extracted tree cannot answer the question)" >&2
    return 2
  }
  # NOT a bare `off="$(appimage_offset ...)"`: check_image is called as
  # `check_image ... || rc=$?`, and bash suppresses errexit for the whole
  # function body in that context. Unchecked, a failure here printed "could not
  # locate the squashfs superblock" and then "OK — world-executable where it
  # matters" and exited 0. A guard that cannot inspect an image must say so,
  # never pass it.
  if ! off="$(appimage_offset "$img")" || [ -z "$off" ]; then
    echo "  could not find the squashfs in $img — cannot check it" >&2
    return 2
  fi

  # -lls lists stored modes without unpacking anything. Rows are:
  #   drwxr-xr-x root/wheel  168 2026-10-21 17:19 squashfs-root/usr/bin
  # and a symlink row carries a trailing " -> target" we drop. Paths are taken
  # from the 6th field to end-of-line so a space in a name survives.
  local line mode path rel oct rows=0 listing_failed=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    # `if`, not `[ ... ] && { ... }`: that form's own non-zero status when the
    # test fails is enough to trip errexit, which this function only survives
    # today because it is called under `||`.
    if [ "$line" = "UNSQUASHFS-FAILED" ]; then
      listing_failed=1
      continue
    fi
    mode="${line%% *}"
    # A listing row's mode is exactly ten characters — type plus three triads.
    # (An earlier `d??????????*` pattern wanted ELEVEN and so matched nothing,
    # which made every image look clean. Hence the explicit length.)
    [ "${#mode}" -eq 10 ] || continue
    case "$mode" in
      [dl-]*) ;;
      *) continue ;; # not a listing row
    esac
    # Counted only once a row has PARSED. Counting every non-empty line would
    # let a listing that was nothing but warnings read as a populated image.
    rows=$((rows + 1))
    path="$(printf '%s' "$line" | awk '{ $1=""; $2=""; $3=""; $4=""; $5=""; sub(/^ +/,""); print }')"
    path="${path%% -> *}"
    # Two renderings, matching check_tree's output exactly so the two forms of
    # this script are diffable against each other: a directory keeps its leading
    # slash (and the root prints as plain "/"), a file does not.
    path="${path#squashfs-root}"
    rel="${path#/}"
    oct="$(rwx_to_octal "$mode")"

    case "$mode" in
      l*) continue ;; # a symlink's own mode is never consulted
      d*)
        # A directory the world cannot enter makes every mode inside it
        # irrelevant, so this is checked first and includes the root.
        world_x "$oct" || {
          echo "  BROKEN  $path/ is $oct — the world cannot enter it, so nothing inside can be reached"
          fail=1
        }
        ;;
      *)
        case "$rel" in
          AppRun | AppRun.wrapped)
            # The two files the launch path itself needs.
            if world_x "$oct"; then
              echo "  ok      $rel $oct"
            else
              echo "  BROKEN  $rel is $oct — the world cannot execute it, so the app will not start for a user who does not own it"
              fail=1
            fi
            ;;
          *)
            # Anything else the owner can execute but the world cannot fails the
            # same way the moment the launch path reaches it. A file the owner
            # cannot execute either is data, not a program, and is not our
            # business.
            case "${mode:3:1}" in
              x | s)
                world_x "$oct" || { echo "  BROKEN  $rel is $oct"; fail=1; }
                ;;
            esac
            ;;
        esac
        ;;
    esac
  done < <(unsquashfs -o "$off" -lls "$img" || echo "UNSQUASHFS-FAILED")

  # Same reasoning as the offset above: a listing that never arrived must not
  # read as a clean image. `rows` additionally catches a successful-but-empty
  # listing, which would otherwise find nothing to complain about.
  if [ "$listing_failed" -eq 1 ] || [ "$rows" -eq 0 ]; then
    echo "  could not list $img (offset $off) — cannot check it" >&2
    return 2
  fi

  [ "$fail" -eq 0 ] || { echo "  ^ $img"; return 1; }
  return 0
}

# ---------------------------------------------------------------------------
# The directory form: a tree the caller prepared. Unchanged — here the modes on
# disk ARE the subject, because this is what is about to be handed to mksquashfs.
# ---------------------------------------------------------------------------

check_tree() {
  local root="$1" label="$2" fail=0
  local d m
  for d in $(find "$root" -type d); do
    m="$(mode_of "$d")"
    world_x "$m" || { echo "  BROKEN  ${d#"$root"}/ is $m — the world cannot enter it, so nothing inside can be reached"; fail=1; }
  done
  local must
  for must in AppRun AppRun.wrapped; do
    [ -e "$root/$must" ] || continue
    m="$(mode_of "$root/$must")"
    if world_x "$m"; then
      echo "  ok      $must $m"
    else
      echo "  BROKEN  $must is $m — the world cannot execute it, so the app will not start for a user who does not own it"
      fail=1
    fi
  done
  local f
  while IFS= read -r f; do
    case "${f#"$root"/}" in AppRun | AppRun.wrapped) continue ;; esac
    m="$(mode_of "$f")"
    world_x "$m" || { echo "  BROKEN  ${f#"$root"/} is $m"; fail=1; }
  done < <(find "$root" -type f -perm -u+x)
  [ "$fail" -eq 0 ] || { echo "  ^ $label"; return 1; }
  return 0
}

status=0
for target in "$@"; do
  echo "== $target"
  if [ -d "$target" ]; then
    check_tree "$target" "$target" || status=1
    continue
  fi
  [ -f "$target" ] || { echo "  not a file or directory" >&2; exit 2; }
  abs="$(cd "$(dirname "$target")" && pwd)/$(basename "$target")"
  chmod +x "$abs"
  rc=0
  check_image "$abs" || rc=$?
  [ "$rc" -eq 2 ] && exit 2
  [ "$rc" -eq 0 ] || status=1
done

if [ "$status" -ne 0 ]; then
  echo
  echo "An AppImage would not start for a user who does not own its files." >&2
  echo "Repack it with the offending files at 0755 before publishing." >&2
  exit 1
fi
echo "OK — world-executable where it matters"
