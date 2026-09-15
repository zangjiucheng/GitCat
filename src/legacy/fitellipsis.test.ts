// Bisection must return EXACTLY what the character-at-a-time scan returned.
//
// That is the whole safety property of #88: this is a performance change, so
// any difference in output is a regression, not an improvement. The scan is
// reproduced here verbatim and the two are compared over a large sweep of
// strings and widths.
import { describe, expect, it } from "vitest";
import { fitEllipsis, type Measure } from "./fitellipsis.ts";

/** The loop this replaces, copied from legacy/main.ts before the change. */
function scan(s: string, maxw: number, min: number, measure: Measure): string {
  let out = s;
  while (out.length > min && measure(out + "…") > maxw) out = out.slice(0, -1);
  return out;
}

/**
 * A measurer with per-character widths, so the sweep exercises proportional
 * text rather than a monospace special case where every cut point is
 * interchangeable. Deterministic: 'i' is narrow, 'W' is wide.
 */
const proportional: Measure = (s) => {
  let w = 0;
  for (const ch of s) w += ch === "i" || ch === "l" ? 3 : ch === "W" || ch === "M" ? 14 : ch === "…" ? 8 : 7;
  return w;
};

const ALPHABET = "abcdefgWMil ._-/";
function pseudoRandomString(seed: number, len: number): string {
  let x = seed >>> 0;
  let out = "";
  for (let i = 0; i < len; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out += ALPHABET[x % ALPHABET.length];
  }
  return out;
}

describe("fitEllipsis agrees with the scan it replaces", () => {
  it("over a sweep of lengths and widths", () => {
    const mismatches: string[] = [];
    for (let len = 1; len <= 120; len += 7) {
      for (let seed = 1; seed <= 12; seed++) {
        const s = pseudoRandomString(seed * 977, len);
        for (let maxw = 0; maxw <= 400; maxw += 13) {
          for (const min of [1, 4]) {
            const a = fitEllipsis(s, maxw, min, proportional);
            const b = scan(s, maxw, min, proportional);
            if (a !== b) {
              mismatches.push(
                `len=${len} seed=${seed} maxw=${maxw} min=${min}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
              );
            }
          }
        }
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it("returns the whole string when it already fits", () => {
    expect(fitEllipsis("short", 9999, 4, proportional)).toBe("short");
  });

  it("never returns fewer than `min` characters, even when nothing fits", () => {
    // A column too narrow for even one character still leaves the floor, so
    // the row shows something rather than a bare ellipsis.
    expect(fitEllipsis("WWWWWWWWWW", 1, 4, proportional)).toBe("WWWW");
    expect(fitEllipsis("WWWWWWWWWW", 1, 1, proportional)).toBe("W");
  });

  it("does not split a surrogate pair", () => {
    // The scan's slice(0,-1) could leave a lone high surrogate, which renders
    // as a replacement glyph; bisection would only land on a different half.
    const s = "ab😀cd😀ef";
    for (let maxw = 0; maxw <= 120; maxw += 3) {
      const out = fitEllipsis(s, maxw, 1, proportional);
      const last = out.charCodeAt(out.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff, `orphaned surrogate at maxw=${maxw}: ${JSON.stringify(out)}`).toBe(false);
    }
  });
});

describe("cost", () => {
  it("measures a logarithmic number of candidates, not a linear one", () => {
    // The point of the change, asserted rather than assumed. LABEL_MAX is 220,
    // so the scan's worst case is ~216 measures for ONE row's subject.
    const s = pseudoRandomString(42, 220);
    let bisectCalls = 0;
    let scanCalls = 0;
    const countedA: Measure = (x) => (bisectCalls++, proportional(x));
    const countedB: Measure = (x) => (scanCalls++, proportional(x));

    const a = fitEllipsis(s, 200, 4, countedA);
    const b = scan(s, 200, 4, countedB);
    expect(a).toBe(b);
    expect(scanCalls, "the scan should be the linear one").toBeGreaterThan(150);
    expect(bisectCalls, `bisection took ${bisectCalls} measures`).toBeLessThan(12);
  });
});
