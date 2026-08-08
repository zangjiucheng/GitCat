import { describe, expect, it } from "vitest";
import { orderRefs, mergeRefChips, rotateChips, type Chip } from "./reforder.ts";

// A commit carrying one of every kind, in the backend's own delivered order
// (tag -> head -> branch -> remote, per git_read.rs::collect_refs).
const MIXED: Chip[] = [
  { label: "v1.2.0", kind: "tag" },
  { label: "main", kind: "head" },
  { label: "feature", kind: "branch" },
  { label: "origin/main", kind: "remote" },
];
const labels = (cs: Chip[]) => cs.map((c) => c.label);

describe("orderRefs", () => {
  it("returns [] for empty/nullish input without throwing", () => {
    expect(orderRefs([], true)).toEqual([]);
    expect(orderRefs(null, true)).toEqual([]);
    expect(orderRefs(undefined, false)).toEqual([]);
  });

  it("tagsFirst keeps the backend order (tag, head, branch, remote)", () => {
    expect(labels(orderRefs(MIXED, true))).toEqual(["v1.2.0", "main", "feature", "origin/main"]);
  });

  it("branch-first promotes head + local branches ahead of tags, remotes still last", () => {
    expect(labels(orderRefs(MIXED, false))).toEqual(["main", "feature", "v1.2.0", "origin/main"]);
  });

  it("is a stable sort — two tags keep their incoming relative order", () => {
    const twoTags: Chip[] = [
      { label: "v2.0", kind: "tag" },
      { label: "v1.9", kind: "tag" },
      { label: "main", kind: "head" },
    ];
    expect(labels(orderRefs(twoTags, false))).toEqual(["main", "v2.0", "v1.9"]);
  });

  it("does not mutate the input array", () => {
    const before = labels(MIXED);
    orderRefs(MIXED, false);
    expect(labels(MIXED)).toEqual(before);
  });

  it("treats an unknown kind as lowest priority (trails known kinds)", () => {
    const withMystery: Chip[] = [
      { label: "weird", kind: "note" },
      { label: "main", kind: "head" },
    ];
    expect(labels(orderRefs(withMystery, true))).toEqual(["main", "weird"]);
    expect(labels(orderRefs(withMystery, false))).toEqual(["main", "weird"]);
  });
});

describe("mergeRefChips", () => {
  it("folds a local branch and its same-named remote into one entry with both markers", () => {
    const out = mergeRefChips([
      { label: "stable", kind: "branch" },
      { label: "origin/stable", kind: "remote" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ label: "stable", kind: "branch", local: true, remote: true });
    expect(out[0].refs.map((r) => r.label)).toEqual(["stable", "origin/stable"]);
  });

  it("keeps the head kind when the current branch pairs with its remote", () => {
    const out = mergeRefChips([
      { label: "main", kind: "head" },
      { label: "origin/main", kind: "remote" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("head");
    expect(out[0].local && out[0].remote).toBe(true);
  });

  it("folds several remotes of the same name into the one local entry", () => {
    const out = mergeRefChips([
      { label: "main", kind: "head" },
      { label: "origin/main", kind: "remote" },
      { label: "upstream/main", kind: "remote" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].refs.map((r) => r.label)).toEqual(["main", "origin/main", "upstream/main"]);
  });

  it("an unmatched remote keeps its full remote-qualified label and only the cloud marker", () => {
    const out = mergeRefChips([{ label: "origin/feature/x", kind: "remote" }]);
    expect(out).toEqual([
      { label: "origin/feature/x", kind: "remote", local: false, remote: true, refs: [{ label: "origin/feature/x", kind: "remote" }] },
    ]);
  });

  it("an unmatched local gets only the monitor marker; tags get neither", () => {
    const out = mergeRefChips([
      { label: "wip", kind: "branch" },
      { label: "v1.0.0", kind: "tag" },
    ]);
    expect(out[0]).toMatchObject({ label: "wip", local: true, remote: false });
    expect(out[1]).toMatchObject({ label: "v1.0.0", kind: "tag", local: false, remote: false });
  });

  it("matches on the segment after the FIRST slash only — origin/feat/x pairs with local feat/x", () => {
    const out = mergeRefChips([
      { label: "feat/x", kind: "branch" },
      { label: "origin/feat/x", kind: "remote" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("feat/x");
  });

  it("preserves first-appearance order and never mutates its input", () => {
    const input = [
      { label: "v2.0.0", kind: "tag" },
      { label: "main", kind: "head" },
      { label: "origin/dev", kind: "remote" },
      { label: "origin/main", kind: "remote" },
    ] as const;
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = mergeRefChips(input);
    expect(out.map((c) => c.label)).toEqual(["v2.0.0", "main", "origin/dev"]);
    expect(input).toEqual(snapshot);
  });

  it("returns [] for empty input", () => {
    expect(mergeRefChips([])).toEqual([]);
  });

  it("a remote appearing BEFORE its matching local still folds into the local's entry — the merged entry's position follows the LOCAL's appearance, not the remote's", () => {
    const out = mergeRefChips([
      { label: "origin/main", kind: "remote" },
      { label: "main", kind: "head" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ label: "main", kind: "head", local: true, remote: true });
    expect(out[0].refs.map((r) => r.label)).toEqual(["main", "origin/main"]);
  });
});

describe("rotateChips", () => {
  it("returns [] for empty input regardless of rot", () => {
    expect(rotateChips([], 0)).toEqual([]);
    expect(rotateChips([], 5)).toEqual([]);
    expect(rotateChips([], -3)).toEqual([]);
  });

  it("rot 0 returns the list in its original order", () => {
    expect(rotateChips(["a", "b", "c"], 0)).toEqual(["a", "b", "c"]);
  });

  it("wraps a negative rot around the length", () => {
    expect(rotateChips(["a", "b", "c"], -1)).toEqual(["c", "a", "b"]);
  });

  it("wraps an overflowing rot around the length", () => {
    expect(rotateChips(["a", "b", "c"], 4)).toEqual(["b", "c", "a"]);
  });

  it("rotates a mergeRefChips display list (merged entries), not raw refs", () => {
    const merged = mergeRefChips([
      { label: "main", kind: "head" },
      { label: "origin/main", kind: "remote" },
      { label: "wip", kind: "branch" },
    ]);
    expect(merged.map((c) => c.label)).toEqual(["main", "wip"]);
    expect(rotateChips(merged, 1).map((c) => c.label)).toEqual(["wip", "main"]);
  });

  it("does not mutate the input array", () => {
    const input = ["a", "b", "c"];
    rotateChips(input, 1);
    expect(input).toEqual(["a", "b", "c"]);
  });
});
