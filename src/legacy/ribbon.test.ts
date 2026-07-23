// Tests for the pure snapshot-ribbon tick geometry. Imports ribbon.ts
// directly — it has no DOM/bridge dependency, so unlike legacy/main.ts it
// doesn't boot the canvas app and needs no mocks.
import { describe, it, expect } from "vitest";
import { ribbonTickFracs, RIBBON_TOP_FRAC, RIBBON_BOT_FRAC, RIBBON_TICK_GAP_PX } from "./ribbon.ts";

const H = 800;
const EPS = 1e-9;

describe("ribbonTickFracs (even spacing)", () => {
  it("returns [] for no ticks", () => {
    expect(ribbonTickFracs(0, H)).toEqual([]);
  });

  it("puts a single tick at the top", () => {
    expect(ribbonTickFracs(1, H)).toEqual([RIBBON_TOP_FRAC]);
  });

  it("spaces ticks with a constant gap, newest at top, none past the bottom", () => {
    const fracs = ribbonTickFracs(8, H);
    expect(fracs.length).toBe(8);
    expect(fracs[0]).toBeCloseTo(RIBBON_TOP_FRAC, 9);
    const g0 = fracs[1] - fracs[0];
    for (let i = 1; i < fracs.length; i++) {
      expect(fracs[i] - fracs[i - 1]).toBeCloseTo(g0, 9); // equal gaps — nothing piles up
      expect(fracs[i]).toBeLessThanOrEqual(RIBBON_BOT_FRAC + EPS);
    }
  });

  it("caps the gap so a few ticks stay compact near the top (no stretch to the extremes)", () => {
    const fracs = ribbonTickFracs(3, H);
    expect(fracs[1] - fracs[0]).toBeCloseTo(RIBBON_TICK_GAP_PX / H, 9);
  });

  it("tightens to exactly fill the band once there are enough ticks", () => {
    const span = RIBBON_BOT_FRAC - RIBBON_TOP_FRAC;
    const count = Math.floor((span * H) / RIBBON_TICK_GAP_PX) + 6; // more than the preferred gap can fit
    const fracs = ribbonTickFracs(count, H);
    expect(fracs[fracs.length - 1]).toBeCloseTo(RIBBON_BOT_FRAC, 6);
    for (const f of fracs) expect(f).toBeLessThanOrEqual(RIBBON_BOT_FRAC + EPS);
  });

  it("stays finite for a large count and for non-positive H", () => {
    for (const f of ribbonTickFracs(5000, H)) expect(Number.isFinite(f)).toBe(true);
    for (const f of ribbonTickFracs(4, 0)) expect(Number.isFinite(f)).toBe(true);
  });
});
