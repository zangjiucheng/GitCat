import { describe, expect, it } from "vitest";
import { clampResize, dragCeiling } from "./resize.ts";

describe("clampResize", () => {
  // The near-edge case: the sidebar, where dragging right grows the panel.
  it("grows with a positive delta when the panel is on the near edge", () => {
    expect(clampResize(300, 40, false, 28, 560)).toBe(340);
  });

  // The far-edge case: the right-hand detail panel and the bottom one both
  // grow when the cursor moves TOWARD the centre, i.e. on a negative delta.
  it("grows with a negative delta when the panel is on the far edge", () => {
    expect(clampResize(300, -40, true, 28, 560)).toBe(340);
  });

  it("never exceeds max", () => {
    expect(clampResize(500, 400, false, 28, 560)).toBe(560);
  });

  // railW, not min: dragging past the minimum is how you collapse, so the
  // clamp has to allow the rail width through for the caller to detect.
  it("floors at the rail width so a collapse is still reachable", () => {
    expect(clampResize(300, -1000, false, 28, 560)).toBe(28);
  });
});

describe("dragCeiling", () => {
  // A tall window: 60% of it comfortably exceeds the panel's own fixed max,
  // so the fixed max still wins.
  it("keeps the fixed max on a tall viewport", () => {
    expect(dragCeiling(720, 1200)).toBe(720);
  });

  // A short window: 60% of it undercuts the fixed max, so the viewport
  // ceiling wins instead — this is the case the graph-squeeze bug lived in.
  it("caps below the fixed max on a short viewport", () => {
    expect(dragCeiling(720, 800)).toBe(480);
  });

  it("is exactly 60% of viewport height at the boundary", () => {
    expect(dragCeiling(720, 1200 / 0.6)).toBeCloseTo(720, 5);
  });
});
