import { describe, expect, it } from "vitest";
import { clampSplit, loadSplitSize } from "./splitter.ts";

describe("clampSplit", () => {
  it("passes a value inside the range through", () => {
    expect(clampSplit(300, 160, 720)).toBe(300);
  });
  it("clamps below and above", () => {
    expect(clampSplit(10, 160, 720)).toBe(160);
    expect(clampSplit(9000, 160, 720)).toBe(720);
  });
});

describe("loadSplitSize", () => {
  it("returns the default when nothing is stored", () => {
    localStorage.removeItem("gitcat.test.split");
    expect(loadSplitSize("gitcat.test.split", 160, 720, 300)).toBe(300);
  });

  // A hand-edited or stale value must not be able to wedge a pane at zero
  // width, which is unrecoverable without clearing storage.
  it("rejects a stored value outside the range", () => {
    localStorage.setItem("gitcat.test.split", "0");
    expect(loadSplitSize("gitcat.test.split", 160, 720, 300)).toBe(300);
    localStorage.setItem("gitcat.test.split", "not a number");
    expect(loadSplitSize("gitcat.test.split", 160, 720, 300)).toBe(300);
  });

  it("returns a stored value inside the range", () => {
    localStorage.setItem("gitcat.test.split", "412");
    expect(loadSplitSize("gitcat.test.split", 160, 720, 300)).toBe(412);
  });
});
