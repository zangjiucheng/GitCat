#!/usr/bin/env bash
# Encodes a raw screen recording into the three web assets the homepage embeds:
#
#   docs/public/demo.webm         VP9,   what almost every visitor actually gets
#   docs/public/demo.mp4          H.264, the fallback (older Safari, some Android)
#   docs/public/demo-poster.jpg   the click-to-play still
#
# Usage:
#   scripts/encode-demo.sh <recording> [poster-timestamp]
#   scripts/encode-demo.sh ~/Desktop/gitcat.mov 00:00:12
#
# Why this exists: the demo has been re-recorded three times, and each time the
# encode settings were rediscovered from scratch. Recording is the manual part
# (see CONTRIBUTING.md's "Docs site assets" for the how) — encoding shouldn't be.
#
# The source can be any resolution ≥1080p; it is scaled to 1920×1080 with
# lanczos. Audio is dropped outright: the video is silent by design, and a
# muted-but-present track just makes browsers show a pointless volume control.
set -euo pipefail

SRC=${1:?usage: scripts/encode-demo.sh <recording> [poster-timestamp]}
POSTER_AT=${2:-00:00:03}
OUT=${DEMO_OUT:-$(cd "$(dirname "$0")/.." && pwd)/docs/public}
mkdir -p "$OUT"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 1; }
[ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 1; }

# fps=30 before the scale so the frame-rate conversion happens on the larger
# image; yuv420p because VP9/H.264 4:4:4 plays nowhere useful.
VF="fps=30,scale=1920:-2:flags=lanczos,format=yuv420p"

echo "==> H.264  → demo.mp4"
# crf 22 / preset slow is the point where screen text stops showing mosquito
# noise around glyph edges at this bitrate. +faststart moves the moov atom to
# the front so the browser can start playing before the whole file lands.
ffmpeg -y -hide_banner -loglevel error -stats -i "$SRC" \
  -an -vf "$VF" \
  -c:v libx264 -crf 22 -preset slow -profile:v high -level 4.1 \
  -movflags +faststart \
  "$OUT/demo.mp4"

echo "==> VP9    → demo.webm (2-pass)"
# Two-pass, not the single-pass CRF the earlier encodes used — those landed the
# webm at the same ~16 MB as the H.264, and since every current browser except
# old Safari takes the webm, that made the smaller format the one nobody gets.
# row-mt + tile-columns are what keep libvpx-vp9 from taking all afternoon on a
# 1080p source; expect a few minutes for a minute of footage either way.
VP9_COMMON=(-an -vf "$VF" -c:v libvpx-vp9 -b:v 0 -crf 33
  -row-mt 1 -tile-columns 2 -frame-parallel 1 -threads 8
  -deadline good -cpu-used 2 -auto-alt-ref 1 -lag-in-frames 25)
PASSLOG=$(mktemp -t gitcat-vp9.XXXXXX)
ffmpeg -y -hide_banner -loglevel error -stats -i "$SRC" "${VP9_COMMON[@]}" \
  -pass 1 -passlogfile "$PASSLOG" -f null /dev/null
ffmpeg -y -hide_banner -loglevel error -stats -i "$SRC" "${VP9_COMMON[@]}" \
  -pass 2 -passlogfile "$PASSLOG" "$OUT/demo.webm"
rm -f "$PASSLOG"*

echo "==> poster → demo-poster.jpg (at $POSTER_AT)"
# -ss before -i seeks by keyframe (fast); q:v 3 keeps text crisp without the
# poster ballooning past the ~300 KB it needs to be.
ffmpeg -y -hide_banner -loglevel error \
  -ss "$POSTER_AT" -i "$SRC" -frames:v 1 \
  -vf "scale=1920:-2:flags=lanczos" -q:v 3 \
  "$OUT/demo-poster.jpg"

echo
echo "done:"
for f in demo.webm demo.mp4 demo-poster.jpg; do
  printf '  %-18s %s\n' "$f" "$(du -h "$OUT/$f" | cut -f1)"
done
echo
echo "Check the poster frame before committing — a mid-scroll or mid-menu"
echo "still is the most common thing wrong with it."
