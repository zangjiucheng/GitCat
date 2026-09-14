// The commit graph's key actions. The band (row -2) is the interesting part:
// it sits outside the [0, N-1] range every other row lives in, so every action
// has to say what it does there — and the audit's finding was that nothing did,
// which is why the row users visit most could not be reached by keyboard.
import { beforeEach, describe, expect, it, vi } from "vitest";

const st = vi.hoisted(() => ({ selectedRow: -1 }));
const fns = vi.hoisted(() => ({
  select: vi.fn(),
  deselect: vi.fn(),
  selectWorkdir: vi.fn(),
  bandH: vi.fn(() => 26),
  openCommitMenuForSelectedRow: vi.fn(() => true),
}));

vi.mock("@/legacy/bridge", () => ({
  state: st,
  get G() {
    return graphRef.current;
  },
  ...fns,
}));

const graphRef = vi.hoisted(() => ({ current: { N: 5 } as { N: number } | null }));

import { canvasKeys } from "./canvas.ts";

beforeEach(() => {
  st.selectedRow = -1;
  graphRef.current = { N: 5 };
  fns.bandH.mockReturnValue(26);
  fns.openCommitMenuForSelectedRow.mockReturnValue(true);
  vi.clearAllMocks();
});

describe("openMenu", () => {
  it("delegates to the legacy opener and declines when it refuses", () => {
    expect(canvasKeys.openMenu()).toBeUndefined();
    expect(fns.openCommitMenuForSelectedRow).toHaveBeenCalled();

    fns.openCommitMenuForSelectedRow.mockReturnValue(false);
    expect(canvasKeys.openMenu()).toBe(false);
  });
});

describe("move", () => {
  it("steps down and up through real rows", () => {
    st.selectedRow = 2;
    canvasKeys.move(1);
    expect(fns.select).toHaveBeenCalledWith(3);

    st.selectedRow = 2;
    canvasKeys.move(-1);
    expect(fns.select).toHaveBeenCalledWith(1);
  });

  it("steps UP off row 0 into the Uncommitted band", () => {
    // The gap the audit named: the band is row -2, outside the [0, N-1] clamp,
    // so j/k could never reach it.
    st.selectedRow = 0;
    expect(canvasKeys.move(-1)).toBeUndefined();
    expect(fns.selectWorkdir).toHaveBeenCalled();
  });

  it("declines to step up off row 0 when there is no band", () => {
    fns.bandH.mockReturnValue(0);
    st.selectedRow = 0;
    expect(canvasKeys.move(-1)).toBe(false);
    expect(fns.selectWorkdir).not.toHaveBeenCalled();
  });

  it("steps DOWN off the band onto the first commit", () => {
    st.selectedRow = -2;
    expect(canvasKeys.move(1)).toBeUndefined();
    expect(fns.select).toHaveBeenCalledWith(0);
  });

  it("declines to step up from the band — it is already the top", () => {
    st.selectedRow = -2;
    expect(canvasKeys.move(-1)).toBe(false);
    expect(fns.select).not.toHaveBeenCalled();
  });

  it("enters the list from nothing selected, at either end", () => {
    st.selectedRow = -1;
    canvasKeys.move(1);
    expect(fns.select).toHaveBeenCalledWith(0);

    st.selectedRow = -1;
    canvasKeys.move(-1);
    expect(fns.select).toHaveBeenCalledWith(4);
  });

  it("declines at the last row rather than wrapping", () => {
    st.selectedRow = 4;
    expect(canvasKeys.move(1)).toBe(false);
  });

  it("declines on an empty graph", () => {
    graphRef.current = { N: 0 };
    expect(canvasKeys.move(1)).toBe(false);
    graphRef.current = null;
    expect(canvasKeys.move(1)).toBe(false);
  });
});

describe("jump", () => {
  it("goes to the newest and oldest commit, never the band", () => {
    canvasKeys.jump("first");
    expect(fns.select).toHaveBeenCalledWith(0);
    canvasKeys.jump("last");
    expect(fns.select).toHaveBeenCalledWith(4);
  });

  it("declines on an empty graph", () => {
    graphRef.current = { N: 0 };
    expect(canvasKeys.jump("first")).toBe(false);
  });
});

describe("deselect", () => {
  it("clears a real selection through deselect(), not select(-1)", () => {
    // select(-1) leaves the detail panel showing the last commit, which reads
    // to the user as Escape having done nothing.
    st.selectedRow = 3;
    expect(canvasKeys.deselect()).toBeUndefined();
    expect(fns.deselect).toHaveBeenCalled();
    expect(fns.select).not.toHaveBeenCalled();
  });

  it("clears the band selection too", () => {
    st.selectedRow = -2;
    expect(canvasKeys.deselect()).toBeUndefined();
    expect(fns.deselect).toHaveBeenCalled();
  });

  it("declines when nothing is selected, so Escape keeps falling outward", () => {
    // -1 and -2 are DIFFERENT: treating them as one is how a "nothing
    // selected" check silently starts matching the band.
    st.selectedRow = -1;
    expect(canvasKeys.deselect()).toBe(false);
    expect(fns.deselect).not.toHaveBeenCalled();
  });
});
