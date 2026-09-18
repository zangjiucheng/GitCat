// Truncating a label to fit, by bisection instead of one character at a time.
//
// #88. The canvas row draw used to strip a single character and re-measure,
// looping: `while (s.length > min && measure(s + "…") > maxw) s = s.slice(0, -1)`.
// That is one measureText per character REMOVED. LABEL_MAX caps a label at 220
// characters, so a long commit subject in a narrow message column cost ~216
// measures per row, every frame, for every visible row — a tail-latency cliff
// on exactly the repositories with long subjects or narrow columns, not a flat
// cost everybody pays. Bisection makes it ~8.
//
// Kept as its own module rather than a helper inside legacy/main.ts because
// that file boots the whole canvas app on import: here the algorithm can be
// tested directly against the scan it replaces, with a measurer of the test's
// own choosing.

/** Width of a candidate string, in px. The canvas's `measureText(s).width`. */
export type Measure = (s: string) => number;

/**
 * Snap `k` to a code-point boundary, never splitting a surrogate pair.
 *
 * The scan had this hazard too — `slice(0, -1)` happily cuts an emoji in half
 * and leaves a lone surrogate, which renders as a replacement glyph. Bisection
 * would merely land on a DIFFERENT half, so this closes it for both rather
 * than swapping one broken output for another.
 */
function cut(s: string, k: number): string {
  if (k > 0 && k < s.length) {
    const c = s.charCodeAt(k - 1);
    if (c >= 0xd800 && c <= 0xdbff) k--; // a high surrogate would be orphaned
  }
  return s.slice(0, k);
}

/**
 * The longest prefix of `s` that still fits `maxw` once "…" is appended, never
 * shorter than `min` characters.
 *
 * Returns the prefix WITHOUT the ellipsis; callers append it, exactly as the
 * scan did. `min` is the floor the callers already carried (4 for a commit
 * subject, 1 for an author or a ref chip): below it a hopeless width would
 * leave nothing but an ellipsis, so the floor wins over fitting.
 *
 * Identical to the scan's answer wherever measured width does not DECREASE as
 * characters are appended — which is what the scan itself assumed by stopping
 * at the first prefix that fits. (Bisection needs that assumption to be sound;
 * the scan needed it to be correct. Neither is safe if a font makes a longer
 * string narrower, and no font this app draws with does.)
 */
export function fitEllipsis(s: string, maxw: number, min: number, measure: Measure): string {
  // The caller has already established that `s` alone does not fit, so the full
  // length is not a candidate — but be defensive: a caller that skips that
  // check still gets the right answer rather than an out-of-range hi.
  if (s.length <= min) return s;
  if (measure(s + "…") <= maxw) return s;

  // Largest k in [min, s.length - 1] whose prefix fits. `lo` is the best fit
  // found so far and starts at the floor, so a width nothing fits still
  // returns the floor — the scan's own behaviour when it runs out of length.
  let lo = min;
  let hi = s.length - 1;
  while (lo < hi) {
    // Bias UP: with lo and hi adjacent, rounding down would retest lo forever.
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (measure(cut(s, mid) + "…") <= maxw) lo = mid;
    else hi = mid - 1;
  }
  return cut(s, lo);
}
