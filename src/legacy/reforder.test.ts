import { describe, expect, it } from "vitest";
import { displayChips, orderRefs, mergeRefChips, rotateChips, type Chip } from "./reforder.ts";

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

  // The single-ref fast path skips the Map/Set the general path builds (this
  // runs per labelled visible row on every full frame, and one ref is by far
  // the common case), so it has to produce identical entries for every kind —
  // including an unmatched remote, which must keep its full remote-qualified
  // label rather than being unwrapped to the trailing name.
  //
  // Asserted against the general path RUN, not against copied literals: the
  // regression this guards is someone changing one path's entry shape, and
  // literals would happily agree with the stale one. A tag filler forces the
  // general path without pairing with anything.
  const ONE_OF_EACH: Chip[] = [
    { label: "main", kind: "head" },
    { label: "wip", kind: "branch" },
    { label: "v1.2.0", kind: "tag" },
    { label: "origin/main", kind: "remote" },
    { label: "weird", kind: "stash" },
  ];

  it("the one-ref fast path emits exactly what the general path would, per kind", () => {
    const FILLER: Chip = { label: "__filler", kind: "tag" };
    for (const c of ONE_OF_EACH) {
      const viaGeneral = mergeRefChips([c, FILLER]);
      expect(viaGeneral).toHaveLength(2);
      expect(mergeRefChips([c])).toEqual([viaGeneral[0]]);
    }
  });

  it("pins the one-ref entry shape per kind", () => {
    expect(ONE_OF_EACH.map((c) => mergeRefChips([c])[0])).toEqual([
      { label: "main", kind: "head", local: true, remote: false, refs: [ONE_OF_EACH[0]] },
      { label: "wip", kind: "branch", local: true, remote: false, refs: [ONE_OF_EACH[1]] },
      { label: "v1.2.0", kind: "tag", local: false, remote: false, refs: [ONE_OF_EACH[2]] },
      { label: "origin/main", kind: "remote", local: false, remote: true, refs: [ONE_OF_EACH[3]] },
      { label: "weird", kind: "stash", local: false, remote: false, refs: [ONE_OF_EACH[4]] },
    ]);
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

// The three helpers above are each tested in isolation; this block pins the
// COMPOSITION main.ts::displayChipsFor actually renders from — priority sort,
// then fold local+remote, then rotate — as one golden contract. Without it a
// refactor could reorder the stages and still pass every test above.
//
// Worth knowing while reading these, so nobody reads more into them than they
// hold. Swapping sort and merge is unobservable: both orders reduce to "the
// survivors of the fold, stably sorted by kind", since the fold preserves each
// entry's kind and first-appearance order. Rotating the RAW list instead of the
// merged one also coincides at small rotations — orderRefs sorts remotes last,
// so every ref the fold removes sits in the trailing remote block, and dropping
// them commutes with a rotation that doesn't reach past the survivors. It stops
// coinciding once the rotation exceeds the merged count, which is what the
// rot-4 case below pins.
//
// So what these assertions catch is a wrong priority table, a broken fold, a
// rotation that runs before the sort, and a rotation whose modulus is the raw
// ref count rather than the merged chip count.
describe("displayChips (the composed pipeline)", () => {
  it("returns [] for empty/nullish refs at any rotation", () => {
    expect(displayChips([], true, 0)).toEqual([]);
    expect(displayChips(null, false, 2)).toEqual([]);
    expect(displayChips(undefined, true, -1)).toEqual([]);
  });

  it("sorts, folds the local+remote pair, then rotates — tagsFirst", () => {
    const out = displayChips(MIXED, true, 0);
    expect(out.map((c) => c.label)).toEqual(["v1.2.0", "main", "feature"]);
    expect(out.map((c) => c.kind)).toEqual(["tag", "head", "branch"]);
    expect(out.map((c) => [c.local, c.remote])).toEqual([
      [false, false],
      [true, true],
      [true, false],
    ]);
    // The folded chip keeps BOTH real refs, in display order — the tooltip and
    // the label context menu act on these, never on the merged label.
    expect(out[1].refs.map((r) => r.label)).toEqual(["main", "origin/main"]);
  });

  it("branch-first promotes head + local branches ahead of the tag", () => {
    expect(displayChips(MIXED, false, 0).map((c) => c.label)).toEqual(["main", "feature", "v1.2.0"]);
  });

  it("rotation is applied last, to the sorted+merged list", () => {
    expect(displayChips(MIXED, true, 1).map((c) => c.label)).toEqual(["main", "feature", "v1.2.0"]);
    expect(displayChips(MIXED, true, 2).map((c) => c.label)).toEqual(["feature", "v1.2.0", "main"]);
  });

  it("rotation wraps on the MERGED chip count, not the raw ref count", () => {
    // MIXED is 4 refs but 3 chips (origin/main folds into main), and cycleRefs
    // takes its modulus from the chip count. rot 3 is therefore the identity —
    // that one agrees with a raw-list rotation too (see the block comment), so
    // it's the rot-4 line that discriminates: wrapping on 4 refs would leave
    // the list untouched instead of advancing it one place.
    expect(displayChips(MIXED, true, 3).map((c) => c.label)).toEqual(["v1.2.0", "main", "feature"]);
    expect(displayChips(MIXED, true, 4).map((c) => c.label)).toEqual(["main", "feature", "v1.2.0"]);
  });

  it("pairs a remote listed before its local, and leaves an unmatched remote alone", () => {
    const out = displayChips(
      [
        { label: "origin/feature", kind: "remote" },
        { label: "upstream/dev", kind: "remote" },
        { label: "feature", kind: "branch" },
      ],
      false,
      0,
    );
    expect(out.map((c) => c.label)).toEqual(["feature", "upstream/dev"]);
    expect(out[0].refs.map((r) => r.label)).toEqual(["feature", "origin/feature"]);
    expect([out[1].local, out[1].remote]).toEqual([false, true]);
  });

  it("does not mutate the caller's ref array", () => {
    const input: Chip[] = MIXED.map((c) => ({ ...c }));
    const snapshot = JSON.stringify(input);
    displayChips(input, false, 2);
    expect(JSON.stringify(input)).toEqual(snapshot);
  });
});
