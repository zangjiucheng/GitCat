// Tests for the hover highlight's lane trace. Graphs are hand-built in the
// backend's CSR shape: gap g's segments are gapStart[g]..gapStart[g+1].
import { describe, it, expect } from "vitest";
import { BranchTrace, type TraceGraph } from "./branchtrace.ts";

// Build a TraceGraph from per-row lanes and per-gap [top, bot] segments.
function graph(lanes: number[], gaps: [number, number][][]): TraceGraph {
  const gapStart = [0], gapTop: number[] = [], gapBot: number[] = [];
  for (const segs of gaps) {
    for (const [t, b] of segs) {
      gapTop.push(t);
      gapBot.push(b);
    }
    gapStart.push(gapTop.length);
  }
  return { N: lanes.length, commitLane: lanes, gapStart, gapTop, gapBot };
}

const rows = (tr: BranchTrace, n: number) => [...Array(n).keys()].filter((r) => tr.has(r));

// 0 A (lane 0) ─┐            A and B are two branch tips with parent C.
// 1 B (lane 1) ─┤            E is a third tip, off D, unrelated to A.
// 2 C (lane 0)  │
// 3 E (lane 1) ─┤
// 4 D (lane 0)
const forked = graph(
  [0, 1, 0, 1, 0],
  [
    [[0, 0]], //         A → C
    [[0, 0], [1, 0]], // A's line passes; B → C
    [[0, 0]], //         C → D
    [[0, 0], [1, 0]], // C's line passes; E → D
  ],
);

describe("BranchTrace", () => {
  it("follows a tip's lines to its ancestors and skips other branches' commits", () => {
    expect(rows(new BranchTrace(forked, 0), 5)).toEqual([0, 2, 4]);
    expect(rows(new BranchTrace(forked, 1), 5)).toEqual([1, 2, 4]);
    expect(rows(new BranchTrace(forked, 3), 5)).toEqual([3, 4]);
  });

  it("never includes rows above the traced commit", () => {
    expect(new BranchTrace(forked, 2).has(0)).toBe(false);
    expect(new BranchTrace(forked, 2).has(1)).toBe(false);
  });

  it("follows both parents of a merge", () => {
    // 0 M (lane 0) merges P (lane 1) into Q (lane 0); R is unrelated.
    // 0 M ─┬─┐
    // 1 R  │ │ │  (lane 2, its own line ends off-graph)
    // 2 P    ●    (lane 1) → S
    // 3 Q  ●      (lane 0) → S
    // 4 S  ●
    const g = graph(
      [0, 2, 1, 0, 0],
      [
        [[0, 0], [0, 1]], //         M → Q and M → P
        [[0, 0], [1, 1], [2, 2]], // pass-throughs; R's line goes on
        [[0, 0], [1, 0]], //         P → S; Q's line passes
        [[0, 0]], //                 Q → S
      ],
    );
    expect(rows(new BranchTrace(g, 0), 5)).toEqual([0, 2, 3, 4]);
  });

  it("answers in any order and stops at an unfinished gap", () => {
    const tr = new BranchTrace(forked, 0);
    expect(tr.has(4)).toBe(true);
    expect(tr.has(1)).toBe(false); // asked after a further row
    // Streaming: the last row's gap isn't known yet.
    const partial = { ...forked, gapStart: [0, 1] };
    const p = new BranchTrace(partial, 0);
    expect(p.has(1)).toBe(false);
    expect(p.has(2)).toBe(false);
  });
});
