#!/usr/bin/env bash
# Fail if an AppImage ships a file the world cannot execute.
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
# Usage:
#   scripts/check-appimage-perms.sh app.AppImage [more.AppImage...]
#   scripts/check-appimage-perms.sh path/to/squashfs-root      # already extracted
set -euo pipefail

# GNU coreutils vs BSD/macOS. The CI runner is Linux; the directory form is
# also usable on a Mac, which is where this script's own test runs.
mode_of() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%OLp' "$1"
}

# World-executable means the last digit of the octal mode has the 1 bit.
world_x() {
  local m="${1: -1}"
  case "$m" in 1|3|5|7) return 0 ;; *) return 1 ;; esac
}

check_tree() {
  local root="$1" label="$2" fail=0
  # DIRECTORIES FIRST, including the root. A directory the world cannot enter
  # makes every mode inside it irrelevant, and this is not hypothetical: the
  # v1.4.0 repack fixed AppRun.wrapped and left every directory at 0700, so the
  # AppImage failed on `AppRun` itself — one level up from anything this used to
  # look at. Checking only `-type f` is how that shipped.
  local d m
  for d in $(find "$root" -type d); do
    m="$(mode_of "$d")"
    case "${m: -1}" in
      1|3|5|7) ;;
      *) echo "  BROKEN  ${d#"$root"}/ is $m — the world cannot enter it, so nothing inside can be reached"; fail=1 ;;
    esac
  done
  # AppRun and AppRun.wrapped are what the launch path itself needs.
  local must
  for must in AppRun AppRun.wrapped; do
    [ -e "$root/$must" ] || continue
    local m; m="$(mode_of "$root/$must")"
    if world_x "$m"; then
      echo "  ok      $must $m"
    else
      echo "  BROKEN  $must is $m — the world cannot execute it, so the app will not start for a user who does not own it"
      fail=1
    fi
  done
  # Anything else executable by its owner but not by the world fails the same
  # way the moment the launch path reaches it.
  local f m
  while IFS= read -r f; do
    case "${f#"$root"/}" in AppRun|AppRun.wrapped) continue ;; esac
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
  work="$(mktemp -d)"
  abs="$(cd "$(dirname "$target")" && pwd)/$(basename "$target")"
  chmod +x "$abs"
  # --appimage-extract is served by the AppImage RUNTIME in the ELF header, not
  # by AppRun — so it still works when AppRun.wrapped is the unreadable one.
  ( cd "$work" && "$abs" --appimage-extract >/dev/null )
  if [ -d "$work/squashfs-root" ]; then
    check_tree "$work/squashfs-root" "$target" || status=1
  else
    echo "  could not extract" >&2; status=1
  fi
  rm -rf "$work"
done

if [ "$status" -ne 0 ]; then
  echo
  echo "An AppImage would not start for a user who does not own its files." >&2
  echo "Repack it with the offending files at 0755 before publishing." >&2
  exit 1
fi
echo "OK — world-executable where it matters"
