// Vertical snapshot-ribbon tick geometry — pure (no DOM, no bridge), so it is
// unit-testable and shared by legacy/main.ts's positionTicks(). Split out of
// that file to fix two problems its inline version had:
//   1. `Math.max(1, ...ages)` RangeError'd ("Maximum call stack size exceeded")
//      once the age array grew large enough — a real crash as snapshots pile
//      up (e.g. retention set to "keep everything"). A plain loop never does.
//   2. A tight cluster of OLD snapshots — all at ~the same log-compressed age —
//      marched the minimum-gap pass past the ribbon bottom (frac > 1), spilling
//      ticks off-screen (and onto the graph below). We now anchor an overshoot
//      to the bottom and back-fill upward so the cluster packs neatly instead.

export const RIBBON_TOP_FRAC = 0.08;
export const RIBBON_BOT_FRAC = 0.92;
export const RIBBON_MIN_TICK_PX = 7;

/**
 * Vertical position of each tick as a fraction (0..1) of the ribbon height `H`,
 * given each snapshot's AGE in seconds, ASCENDING (newest / smallest age
 * first). Log-compresses elapsed time (log1p) so a recent burst spreads out
 * near the top while a long tail compresses toward the bottom, enforces a
 * minimum pixel gap so near-simultaneous snapshots never overlap, and keeps
 * the whole set inside [TOP, BOT] — never off the bottom.
 */
export function ribbonTickFracs(agesAscending: number[], H: number): number[] {
  const n = agesAscending.length;
  if (n === 0) return [];
  // Degenerate ribbon height — return something finite rather than dividing by
  // it. (positionTicks already bails on H<=0, so this is just belt-and-braces.)
  if (!(H > 0)) return agesAscending.map(() => RIBBON_TOP_FRAC);

  // Non-spread max: `Math.max(1, ...agesAscending)` throws on a large array;
  // a loop is O(n) with no argument-count limit, at any length.
  let maxAge = 1;
  for (let i = 0; i < n; i++) if (agesAscending[i] > maxAge) maxAge = agesAscending[i];

  const span = RIBBON_BOT_FRAC - RIBBON_TOP_FRAC;
  const denom = Math.log1p(maxAge) || 1; // maxAge>=1 => >0; the ||1 is defensive
  const fracs = agesAscending.map((age) => RIBBON_TOP_FRAC + span * (Math.log1p(Math.max(0, age)) / denom));

  const minGap = RIBBON_MIN_TICK_PX / H;
  // Forward pass: keep each tick at least minGap below its predecessor.
  for (let i = 1; i < n; i++) if (fracs[i] < fracs[i - 1] + minGap) fracs[i] = fracs[i - 1] + minGap;

  // If a cluster marched the tail past the bottom, clamp the last tick to
  // BOT_FRAC and back-fill upward keeping minGap — packs the cluster against
  // the bottom instead of overflowing off-screen. (positionTicks sizes its cap
  // so a full set fits when bottom-anchored; more than that can't be shown.)
  if (fracs[n - 1] > RIBBON_BOT_FRAC) {
    fracs[n - 1] = RIBBON_BOT_FRAC;
    for (let i = n - 2; i >= 0; i--) if (fracs[i] > fracs[i + 1] - minGap) fracs[i] = fracs[i + 1] - minGap;
  }
  return fracs;
}
