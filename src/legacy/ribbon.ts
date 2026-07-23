// Vertical snapshot-ribbon tick geometry — pure (no DOM, no bridge), so it is
// unit-testable and shared by legacy/main.ts's positionTicks().
//
// The ribbon is deliberately NOT a real time axis. An earlier version placed
// ticks by log-compressed elapsed time, but that made a burst (or a long tail
// of old snapshots) pile up in a cluster — visually noisy and unhelpful. It's
// now just an EVENLY-SPACED list of the newest snapshots (newest at the top,
// growing down), so nothing ever heaps together.

export const RIBBON_TOP_FRAC = 0.08;
export const RIBBON_BOT_FRAC = 0.92;
// Smallest pitch a tick may occupy — positionTicks sizes its "how many fit"
// cap off this, so a full ribbon never packs tighter than this. Kept a little
// above the 12px tick height (index.html's .tick) so ticks stay individually
// clickable even when the band is full, never overlapping.
export const RIBBON_MIN_TICK_PX = 15;
// Preferred pitch between ticks when there's room to spare, so a handful of
// snapshots are a compact, comfortably-clickable list near the top rather than
// tiny marks stretched across a tall ribbon.
export const RIBBON_TICK_GAP_PX = 22;

/**
 * Vertical position of each of `count` ticks as a fraction (0..1) of the
 * ribbon height `H`, evenly spaced from the top. Uses the preferred gap when
 * there's room; once there are enough ticks that the preferred gap wouldn't
 * fit, it tightens to exactly fill the band [TOP, BOT]. Never overflows the
 * bottom, never overlaps (the caller caps `count` to what fits at MIN_TICK_PX).
 */
export function ribbonTickFracs(count: number, H: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [RIBBON_TOP_FRAC];
  const span = RIBBON_BOT_FRAC - RIBBON_TOP_FRAC;
  // The gap is the smaller of "comfortable" and "just fills the band" — so few
  // ticks stay compact near the top and many ticks spread to fill it exactly,
  // and the last tick can never pass BOT (i*gap <= (count-1)*span/(count-1)).
  const gap = Math.min(RIBBON_TICK_GAP_PX / (H > 0 ? H : 1), span / (count - 1));
  const fracs = new Array<number>(count);
  for (let i = 0; i < count; i++) fracs[i] = RIBBON_TOP_FRAC + i * gap;
  return fracs;
}
