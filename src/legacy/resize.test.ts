import { describe, expect, it } from "vitest";
import { clampResize } from "./resize.ts";

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
