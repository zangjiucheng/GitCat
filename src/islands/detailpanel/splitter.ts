// The splitter's arithmetic and its persistence, kept out of the component so
// they can be tested without mounting anything.

export function clampSplit(size: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, size));
}

/**
 * The stored pane size, or `fallback`.
 *
 * A value outside [min, max] is discarded rather than clamped: it means the
 * stored blob is stale (the range changed) or hand-edited, and silently
 * clamping a 0 to the minimum hides that. Reading throws in a private window
 * with storage disabled, so this never lets that reach the caller.
 */
export function loadSplitSize(key: string, min: number, max: number, fallback: number): number {
  try {
    const v = parseFloat(localStorage.getItem(key) ?? "");
    return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
  } catch {
    return fallback;
  }
}

export function saveSplitSize(key: string, size: number): void {
  try {
    localStorage.setItem(key, String(Math.round(size)));
  } catch {
    /* storage disabled — the size is still live for this session */
  }
}
