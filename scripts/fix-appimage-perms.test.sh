#!/usr/bin/env bash
# Tests for fix-appimage-perms.sh.
#
# This script rewrites a release asset that is then re-signed and shipped, so
# the thing to pin is not only "did it fix the mode" but "did it preserve
# everything else". A repack that drops a file would be signed, uploaded and
# trusted, and the v1.4.0 incident is the proof that a repack CAN introduce a
# defect of its own: it corrected AppRun.wrapped and left every directory at
# 0700, shipping an AppImage nothing could be traversed in.
#
# Fixtures are real squashfs images so the round-trip under test is the real
# one.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
fix="$here/fix-appimage-perms.sh"
check="$here/check-appimage-perms.sh"
offset="$here/appimage-offset.sh"

for tool in mksquashfs unsquashfs; do
  command -v "$tool" >/dev/null || {
    echo "SKIP: $tool not found (install squashfs-tools to run these tests)" >&2
    exit 0
  }
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The script refuses to run where names differing only in case collide, and one
# of the cases below depends on such a pair existing. Both need a case-sensitive
# scratch directory; saying so beats a confusing failure.
: > "$work/CaseProbe"
if [ -e "$work/caseprobe" ]; then
  echo "SKIP: $work is case-insensitive; set TMPDIR to a case-sensitive volume" >&2
  exit 0
fi
rm -f "$work/CaseProbe"

pass=0
fail=0

note() {
  if [ "$1" = ok ]; then
    echo "ok   $2"
    pass=$((pass + 1))
  else
    echo "FAIL $2 — $3"
    fail=$((fail + 1))
  fi
}

make_image() {
  local root="$1" out="$2"
  mksquashfs "$root" "$work/fs.squashfs" -noappend -comp zstd -b 131072 -quiet -no-progress 2>/dev/null
  head -c 4096 /dev/urandom > "$work/rt.bin"
  cat "$work/rt.bin" "$work/fs.squashfs" > "$out"
  rm -f "$work/fs.squashfs" "$work/rt.bin"
}

make_clean_tree() {
  local root="$1"
  rm -rf "$root"
  mkdir -p "$root/usr/bin" "$root/usr/share/icons"
  printf '#!/bin/sh\nexec "$(dirname "$0")"/AppRun.wrapped\n' > "$root/AppRun"
  printf 'not really an elf\n' > "$root/AppRun.wrapped"
  printf 'binary\n' > "$root/usr/bin/app"
  printf 'data\n' > "$root/usr/share/icons/app.png"
  chmod 755 "$root" "$root/usr" "$root/usr/bin" "$root/usr/share" "$root/usr/share/icons"
  chmod 755 "$root/AppRun" "$root/AppRun.wrapped" "$root/usr/bin/app"
  chmod 644 "$root/usr/share/icons/app.png"
}

# type + path for every entry, which is what a repack must never change.
entry_set() {
  unsquashfs -o "$("$offset" "$1")" -lls "$1" 2>/dev/null | awk '
    { t = substr($1, 1, 1)
      p = $0
      sub(/^[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +/, "", p)
      sub(/ -> .*$/, "", p)
      print t " " p }' | sort
}

# --- the v1.3.2 defect, end to end -----------------------------------------
make_clean_tree "$work/t1"
chmod 770 "$work/t1/AppRun.wrapped"
make_image "$work/t1" "$work/t1.AppImage"
cp "$work/t1.AppImage" "$work/t1.orig"
entry_set "$work/t1.AppImage" > "$work/t1.before"

if out="$("$fix" "$work/t1.AppImage" 2>&1)"; then
  case "$out" in
    *"AppRun.wrapped: 770 -> 755"*) note ok "repack fixes AppRun.wrapped 0770 -> 0755" ;;
    *) note FAIL "repack fixes AppRun.wrapped 0770 -> 0755" "unexpected output: $out" ;;
  esac
else
  note FAIL "repack fixes AppRun.wrapped 0770 -> 0755" "exited non-zero: $out"
fi

if "$check" "$work/t1.AppImage" >/dev/null 2>&1; then
  note ok "the repacked image passes the guard"
else
  note FAIL "the repacked image passes the guard" "guard still fails"
fi

entry_set "$work/t1.AppImage" > "$work/t1.after"
if diff -q "$work/t1.before" "$work/t1.after" >/dev/null; then
  note ok "the repack preserves every entry (type and path)"
else
  note FAIL "the repack preserves every entry (type and path)" \
    "$(wc -l < "$work/t1.before") in, $(wc -l < "$work/t1.after") out: $(diff "$work/t1.before" "$work/t1.after" | tr '\n' ' ')"
fi

off="$("$offset" "$work/t1.orig")"
if [ "$(head -c "$off" "$work/t1.orig" | cksum)" = "$(head -c "$off" "$work/t1.AppImage" | cksum)" ]; then
  note ok "the repack leaves the ELF runtime byte-identical"
else
  note FAIL "the repack leaves the ELF runtime byte-identical" "runtime changed"
fi

# --- a clean image is not touched at all ------------------------------------
# The self-disabling half. It only works because unsquashfs restores the stored
# modes: under `--appimage-extract` every directory came back 0700, so the
# script always believed it had something to fix and re-signed on every release.
make_clean_tree "$work/t2"
make_image "$work/t2" "$work/t2.AppImage"
cp "$work/t2.AppImage" "$work/t2.orig"
out="$("$fix" "$work/t2.AppImage" 2>&1)"
case "$out" in
  *"nothing to fix"*) note ok "a clean image reports nothing to fix" ;;
  *) note FAIL "a clean image reports nothing to fix" "got: $out" ;;
esac
if cmp -s "$work/t2.orig" "$work/t2.AppImage"; then
  note ok "a clean image is left byte-identical"
else
  note FAIL "a clean image is left byte-identical" "the file was rewritten"
fi

# --- the v1.4.0 defect: a stored 0700 directory -----------------------------
make_clean_tree "$work/t3"
chmod 700 "$work/t3/usr"
make_image "$work/t3" "$work/t3.AppImage"
out="$("$fix" "$work/t3.AppImage" 2>&1)"
case "$out" in
  *"/usr/: 700 -> 755"*) note ok "repack fixes a stored 0700 directory" ;;
  *) note FAIL "repack fixes a stored 0700 directory" "got: $out" ;;
esac
if "$check" "$work/t3.AppImage" >/dev/null 2>&1; then
  note ok "the directory-fixed image passes the guard"
else
  note FAIL "the directory-fixed image passes the guard" "guard still fails"
fi

# --- names differing only in case --------------------------------------------
# The real image has exactly this pair — `GitCat.png` (a file) and `gitcat.png`
# (a symlink) in the squashfs root. A case-insensitive scratch filesystem holds
# only one of them, which is how a repack silently loses a file; the script
# refuses outright there, and must preserve both where it does run.
make_clean_tree "$work/t4"
printf 'icon\n' > "$work/t4/Icon.png"
ln -s usr/share/icons/app.png "$work/t4/icon.png"
chmod 770 "$work/t4/AppRun.wrapped"
make_image "$work/t4" "$work/t4.AppImage"
entry_set "$work/t4.AppImage" > "$work/t4.before"
"$fix" "$work/t4.AppImage" >/dev/null 2>&1
entry_set "$work/t4.AppImage" > "$work/t4.after"
if diff -q "$work/t4.before" "$work/t4.after" >/dev/null; then
  note ok "entries differing only in case both survive a repack"
else
  note FAIL "entries differing only in case both survive a repack" \
    "$(diff "$work/t4.before" "$work/t4.after" | tr '\n' ' ')"
fi

# --- a file it cannot read is an error, not a silent success -----------------
head -c 100000 /dev/urandom > "$work/garbage.AppImage"
cp "$work/garbage.AppImage" "$work/garbage.orig"
if "$fix" "$work/garbage.AppImage" >/dev/null 2>&1; then
  note FAIL "a file with no squashfs fails" "exited 0"
else
  if cmp -s "$work/garbage.orig" "$work/garbage.AppImage"; then
    note ok "a file with no squashfs fails and is left alone"
  else
    note FAIL "a file with no squashfs fails and is left alone" "the file was modified"
  fi
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
