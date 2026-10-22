#!/usr/bin/env bash
# Tests for check-appimage-perms.sh.
#
# This guard is release-critical and has now mis-fired twice, in both
# directions, and each time it cost a release:
#
#   * v1.4.0 — it only walked `-type f`, so a repack that left every directory
#     at 0700 shipped an AppImage that could not be traversed. A false NEGATIVE.
#   * v1.5.0 — the directory check was added, but it read an
#     `--appimage-extract` tree, and the AppImage runtime creates every
#     directory it extracts at 0700. Both Linux legs reported ~150 broken
#     directories on images that were in fact clean, which reddened the aarch64
#     leg and skipped the repack and finalize jobs (`needs: build`). A false
#     POSITIVE that stopped the release.
#
# So both halves need pinning: a clean image must produce NO findings, and a
# genuinely broken one must produce exactly the right ones. Fixtures are built
# with mksquashfs so the modes under test are the ones really stored, which is
# the distinction the v1.5.0 bug turned on.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
guard="$here/check-appimage-perms.sh"

for tool in mksquashfs unsquashfs; do
  command -v "$tool" >/dev/null || {
    echo "SKIP: $tool not found (install squashfs-tools to run these tests)" >&2
    exit 0
  }
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

pass=0
fail=0

# Build an AppImage-shaped file: a stand-in runtime with a squashfs appended.
# The runtime's content is irrelevant to this guard — it reads the filesystem,
# and locates it by scanning for a validated superblock rather than by running
# the runtime, which is also what lets it check an arm64 image anywhere.
make_image() {
  local root="$1" out="$2"
  mksquashfs "$root" "$work/fs.squashfs" -noappend -comp zstd -b 131072 -quiet -no-progress 2>/dev/null
  head -c 4096 /dev/urandom > "$work/runtime.bin"
  cat "$work/runtime.bin" "$work/fs.squashfs" > "$out"
  rm -f "$work/fs.squashfs"
}

# A tree whose launch path is correct. Callers break one thing at a time.
make_clean_tree() {
  local root="$1"
  rm -rf "$root"
  mkdir -p "$root/usr/bin" "$root/usr/share/icons"
  printf '#!/bin/sh\nexec "$(dirname "$0")"/AppRun.wrapped\n' > "$root/AppRun"
  printf 'not really an elf\n' > "$root/AppRun.wrapped"
  printf 'binary\n' > "$root/usr/bin/app"
  printf 'some data\n' > "$root/usr/share/icons/app.png"
  chmod 755 "$root" "$root/usr" "$root/usr/bin" "$root/usr/share" "$root/usr/share/icons"
  chmod 755 "$root/AppRun" "$root/AppRun.wrapped" "$root/usr/bin/app"
  chmod 644 "$root/usr/share/icons/app.png"
}

# run <label> <expected-exit> <target> [substring-that-must-appear ...]
# A leading "!" on a substring asserts it must NOT appear.
run() {
  local label="$1" want="$2" target="$3"; shift 3
  local out rc=0
  out="$("$guard" "$target" 2>&1)" || rc=$?
  local ok=1 why=""
  [ "$rc" -eq "$want" ] || { ok=0; why="exit $rc, wanted $want"; }
  local pat
  for pat in "$@"; do
    if [ "${pat:0:1}" = "!" ]; then
      case "$out" in *"${pat:1}"*) ok=0; why="$why; must NOT mention '${pat:1}'" ;; esac
    else
      case "$out" in *"$pat"*) ;; *) ok=0; why="$why; missing '$pat'" ;; esac
    fi
  done
  if [ "$ok" -eq 1 ]; then
    echo "ok   $label"
    pass=$((pass + 1))
  else
    echo "FAIL $label — ${why# ; }"
    printf '%s\n' "$out" | sed 's/^/       | /'
    fail=$((fail + 1))
  fi
}

# --- a clean image is silent ------------------------------------------------
# The v1.5.0 regression in one assertion: no finding may be invented for an
# image whose stored modes are all fine.
make_clean_tree "$work/clean"
make_image "$work/clean" "$work/clean.AppImage"
run "a clean image passes" 0 "$work/clean.AppImage" \
  "ok      AppRun 755" "ok      AppRun.wrapped 755" "!BROKEN"

# --- the real v1.3.2 defect -------------------------------------------------
make_clean_tree "$work/wrapped"
chmod 770 "$work/wrapped/AppRun.wrapped"
make_image "$work/wrapped" "$work/wrapped.AppImage"
run "AppRun.wrapped at 0770 fails, and nothing else is blamed" 1 "$work/wrapped.AppImage" \
  "BROKEN  AppRun.wrapped is 770" "ok      AppRun 755" "!is 700"

# --- the real v1.4.0 defect, as actually stored -----------------------------
make_clean_tree "$work/dir"
chmod 700 "$work/dir/usr"
make_image "$work/dir" "$work/dir.AppImage"
run "a stored 0700 directory fails" 1 "$work/dir.AppImage" \
  "BROKEN  /usr/ is 700" "the world cannot enter it"

make_clean_tree "$work/root700"
chmod 700 "$work/root700"
make_image "$work/root700" "$work/root700.AppImage"
run "a stored 0700 squashfs root fails" 1 "$work/root700.AppImage" \
  "is 700" "the world cannot enter it"

# --- owner-executable but not world-executable ------------------------------
make_clean_tree "$work/exe"
chmod 700 "$work/exe/usr/bin/app"
make_image "$work/exe" "$work/exe.AppImage"
run "an owner-only executable fails" 1 "$work/exe.AppImage" \
  "BROKEN  usr/bin/app is 700"

# --- data is not a program --------------------------------------------------
# A 0600 file nothing executes is not a launch-path problem, and reporting it
# would bury the findings that matter under hundreds of lines.
make_clean_tree "$work/data"
chmod 600 "$work/data/usr/share/icons/app.png"
make_image "$work/data" "$work/data.AppImage"
run "a non-executable 0600 file is ignored" 0 "$work/data.AppImage" \
  "!app.png"

# --- symlinks ---------------------------------------------------------------
# lrwxrwxrwx is the only mode a symlink ever has; the target's mode is what
# matters and is checked in its own right.
make_clean_tree "$work/link"
ln -s usr/bin/app "$work/link/app-link"
make_image "$work/link" "$work/link.AppImage"
run "a symlink is not reported" 0 "$work/link.AppImage" "!app-link"

# --- cannot inspect must never read as clean --------------------------------
# This is the one that makes the whole suite worth having: an earlier draft of
# the rewrite failed to find the superblock, printed the error, and then exited
# 0 with "OK — world-executable where it matters", because bash suppresses
# errexit inside a function called under `||`.
head -c 200000 /dev/urandom > "$work/garbage.AppImage"
run "a file with no squashfs is an error, not a pass" 2 "$work/garbage.AppImage" \
  "cannot check it"

# --- the directory form still works ----------------------------------------
# Used by fix-appimage-perms.sh on the tree it is about to hand to mksquashfs,
# and the only form that needs no squashfs-tools.
make_clean_tree "$work/tree"
chmod 700 "$work/tree/usr"
run "the directory form flags a 0700 directory" 1 "$work/tree" \
  "BROKEN  /usr/ is 700"

make_clean_tree "$work/tree2"
run "the directory form passes a clean tree" 0 "$work/tree2" \
  "ok      AppRun 755" "!BROKEN"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
