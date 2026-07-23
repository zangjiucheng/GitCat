// Tests for the pure snapshot-ribbon tick geometry. Imports ribbon.ts
// directly — it has no DOM/bridge dependency, so unlike legacy/main.ts it
// doesn't boot the canvas app and needs no mocks.
import { describe, it, expect } from "vitest";
import { ribbonTickFracs, RIBBON_TOP_FRAC, RIBBON_BOT_FRAC, RIBBON_MIN_TICK_PX } from "./ribbon.ts";

const H = 800;
const minGap = RIBBON_MIN_TICK_PX / H;
const EPS = 1e-9;

describe("ribbonTickFracs", () => {
  it("returns [] for no ticks", () => {
    expect(ribbonTickFracs([], H)).toEqual([]);
  });

  it("places a single tick inside the band", () => {
    const [f] = ribbonTickFracs([3600], H);
    expect(f).toBeGreaterThanOrEqual(RIBBON_TOP_FRAC);
    expect(f).toBeLessThanOrEqual(RIBBON_BOT_FRAC);
  });

  it("keeps ticks ascending, at least minGap apart, all within [TOP, BOT]", () => {
    const ages = [1, 5, 30, 300, 3600, 86400, 30 * 86400];
    const fracs = ribbonTickFracs(ages, H);
    expect(fracs.length).toBe(ages.length);
    for (let i = 0; i < fracs.length; i++) {
      expect(fracs[i]).toBeGreaterThanOrEqual(RIBBON_TOP_FRAC - EPS);
      expect(fracs[i]).toBeLessThanOrEqual(RIBBON_BOT_FRAC + EPS);
      if (i > 0) expect(fracs[i] - fracs[i - 1]).toBeGreaterThanOrEqual(minGap - EPS);
    }
  });

  it("packs a tight cluster of OLD snapshots against the bottom instead of spilling off-screen", () => {
    // 60 snapshots all ~30 days old: their log-ages are nearly identical and
    // near the bottom, so the forward min-gap pass marches the tail past
    // frac 1.0. The fix clamps the last to BOT and back-fills upward.
    const ages = new Array(60).fill(0).map((_, i) => 30 * 86400 + i);
    const fracs = ribbonTickFracs(ages, H);
    for (const f of fracs) expect(f).toBeLessThanOrEqual(RIBBON_BOT_FRAC + EPS); // nothing off the bottom
    expect(fracs[fracs.length - 1]).toBeCloseTo(RIBBON_BOT_FRAC, 6);
    expect(fracs[0]).toBeGreaterThanOrEqual(RIBBON_TOP_FRAC - EPS); // top still in the band
    for (let i = 1; i < fracs.length; i++) expect(fracs[i] - fracs[i - 1]).toBeGreaterThanOrEqual(minGap - EPS);
  });

  it("does NOT crash on a very large age array (the Math.max(1, ...ages) spread footgun)", () => {
    const big = new Array(200_000).fill(0).map((_, i) => i);
    let fracs: number[] = [];
    expect(() => {
      fracs = ribbonTickFracs(big, H);
    }).not.toThrow();
    expect(fracs.length).toBe(200_000);
    expect(Number.isFinite(fracs[0])).toBe(true);
    expect(Number.isFinite(fracs[fracs.length - 1])).toBe(true);
  });

  it("degrades to finite values (no NaN/Infinity) when H is non-positive", () => {
    for (const f of ribbonTickFracs([1, 100, 86400], 0)) expect(Number.isFinite(f)).toBe(true);
  });
});
