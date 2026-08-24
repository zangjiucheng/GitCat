// The one piece of the panel-resize drag that is pure arithmetic, split out
// so it can be tested without a browser (legacy/main.ts is @ts-nocheck and
// boots a canvas on import).
//
// `fromFarEdge` is true for a panel whose draggable edge faces the centre of
// the window — the right-hand detail column, and the bottom one. For those,
// moving the cursor toward the centre GROWS the panel, so the delta is
// subtracted rather than added.
//
// The floor is `railW`, not `min`: dragging past the minimum is how a panel
// collapses, and the caller decides between "snap back to min" and "collapse
// to the rail" from the value this returns.
export function clampResize(startSize: number, delta: number, fromFarEdge: boolean, railW: number, max: number): number {
  const raw = fromFarEdge ? startSize - delta : startSize + delta;
  return Math.max(railW, Math.min(max, raw));
}
