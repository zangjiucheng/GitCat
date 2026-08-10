// Pure ordering for a commit's ref chips — the graph's ref labels, in either
// layout (inline or the left column) — extracted from legacy/main.ts's canvas
// code (which has no unit tests: it boots the whole app on import) so the
// priority + rotation logic can actually be tested.
//
// The backend (git_read.rs::collect_refs) already hands us each commit's refs
// stably sorted tag -> head -> branch -> remote. One knob sits on top of that:
//
//   * `tagsFirst` — the global "label priority" preference. `true` keeps the
//     backend order (a commit's tag wins the one visible slot when only one
//     fits); `false` promotes the checked-out branch / local branches ahead
//     of tags for people who'd rather see the branch there.
//
// The per-commit "+N" overflow rotation is a separate concern, handled by
// rotateChips below on the MERGED display list (never here) — see its own
// comment for why.
//
// Display-only; nothing here mutates the input.

export type RefKind = "head" | "branch" | "tag" | "remote" | string;
export interface Chip {
  label: string;
  kind: RefKind;
}

// tag -> head -> branch -> remote (mirrors the backend's own ordering, so
// tagsFirst is effectively a stable no-op re-sort — cheap and idempotent).
const TAG_FIRST: Record<string, number> = { tag: 0, head: 1, branch: 2, remote: 3 };
// head -> branch -> tag -> remote: the current branch and other local branches
// come before tags; remotes still trail.
const BRANCH_FIRST: Record<string, number> = { head: 0, branch: 1, tag: 2, remote: 3 };

// A copy of `refs`, stably reordered by the chosen priority. Empty in, empty
// out. Never mutates the argument.
export function orderRefs<T extends Chip>(refs: readonly T[] | null | undefined, tagsFirst: boolean): T[] {
  // Nothing to order below two refs, and this runs per labelled visible row on
  // every full frame — so the common one-ref row skips the decorate/sort/
  // undecorate below (three arrays plus a wrapper object per ref) entirely,
  // just as mergeRefChips skips its Map and Set for the same row.
  if (!refs || refs.length < 2) return refs ? refs.slice() : [];
  const pri = tagsFirst ? TAG_FIRST : BRANCH_FIRST;
  // Stable sort by kind priority: decorate with the original index so equal
  // kinds keep their incoming relative order (two tags stay in backend order).
  return refs
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (pri[a.r.kind] ?? 9) - (pri[b.r.kind] ?? 9) || a.i - b.i)
    .map((x) => x.r);
}

// One DISPLAY chip, possibly standing for several co-located refs. The graph
// paints `label` once with a monitor glyph when `local` and a cloud glyph when
// `remote` — so a local branch sitting exactly on its remote counterpart reads
// as one "[🖥☁ name]" chip instead of two chips saying the same name twice.
// `refs` keeps every member (display order) for the hover tooltip and the
// label context menu, which still act on real refs, never on the merged label.
export interface MergedChip {
  label: string;
  kind: RefKind;
  local: boolean;
  remote: boolean;
  refs: Chip[];
}

// Fold a commit's ordered ref list into display chips: a remote named
// `<remote>/<name>` merges into the local branch/head chip labelled `<name>`
// on the same commit (several remotes fold into that same chip); everything
// else passes through one-to-one. Matching strips only the FIRST path segment
// (the remote name) — `origin/feat/x` pairs with local `feat/x`. Entry order is
// first appearance in the input, so the caller's priority sort (orderRefs)
// still decides what leads. Pure: never mutates the input.
export function mergeRefChips<T extends Chip>(refs: readonly T[]): MergedChip[] {
  // Empty in, empty out — this runs per visible row on every frame, and most
  // rows have no refs, so skip the Map/array allocations below entirely.
  if (!refs.length) return [];
  // One ref is the overwhelmingly common labelled row, and it can't pair with
  // anything, so it takes the same shortcut: no Map, no Set, no second pass.
  // Same shape the general path below produces for a lone ref of any kind.
  if (refs.length === 1) {
    const r = refs[0];
    const local = r.kind === "branch" || r.kind === "head";
    return [{ label: r.label, kind: r.kind, local, remote: r.kind === "remote", refs: [r] }];
  }
  // Index every local (branch/head) ref by name in its OWN full pass first,
  // before the fold-remotes-in pass below — so a remote that appears EARLIER
  // in the input than its matching local (e.g. backend order happens to list
  // `origin/main` before `main`) still finds it: pairing must not depend on
  // input order.
  const localByName = new Map<string, MergedChip>();
  for (const r of refs) {
    if (r.kind === "branch" || r.kind === "head") {
      const entry: MergedChip = { label: r.label, kind: r.kind, local: true, remote: false, refs: [r] };
      localByName.set(r.label, entry);
    }
  }
  const merged: MergedChip[] = [];
  const emitted = new Set<MergedChip>();
  for (const r of refs) {
    if (r.kind === "branch" || r.kind === "head") {
      const entry = localByName.get(r.label)!;
      if (!emitted.has(entry)) { emitted.add(entry); merged.push(entry); }
      continue;
    }
    if (r.kind === "remote") {
      const slash = r.label.indexOf("/");
      const name = slash >= 0 ? r.label.slice(slash + 1) : r.label;
      const home = localByName.get(name);
      if (home) { home.remote = true; home.refs.push(r); continue; }
    }
    merged.push({ label: r.label, kind: r.kind, local: false, remote: r.kind === "remote", refs: [r] });
  }
  return merged;
}

// Rotate `list` left by `rot` places (any integer; negative and out-of-range
// values wrap into [0, n)). Empty in, empty out. Never mutates the argument.
//
// Lives here rather than inline in main.ts's displayChipsFor because rotation
// must walk the MERGED display list (what's actually painted — a local+remote
// pair folded into one chip counts once), never the raw per-commit ref list;
// keeping the math next to mergeRefChips makes that dependency obvious and
// lets both be exercised by the same unit tests.
export function rotateChips<T>(list: readonly T[], rot: number): T[] {
  const n = list.length;
  if (n === 0) return [];
  const k = ((rot % n) + n) % n;
  return k === 0 ? list.slice() : list.slice(k).concat(list.slice(0, k));
}

// The whole display pipeline in one place: priority sort, THEN fold local +
// remote pairs, THEN rotate. main.ts::displayChipsFor is a thin wrapper that
// only supplies the row's raw refs, the tagsFirst preference and the row's
// rotation counter, so the composition itself is unit-testable rather than
// living in the canvas file that no test can import.
//
// The order of the three steps is the contract, not an implementation detail:
//
//   * sort BEFORE merge — merging keeps first-appearance order, so it must be
//     handed a list that is already in priority order.
//   * rotate LAST, over MERGED entries — a folded local+remote pair is ONE
//     chip on screen, so cycling past it must take one click, not two, and the
//     modulus has to be the merged count (what cycleRefs also counts).
export function displayChips(
  refs: readonly Chip[] | null | undefined,
  tagsFirst: boolean,
  rot: number,
): MergedChip[] {
  return rotateChips(mergeRefChips(orderRefs(refs, tagsFirst)), rot);
}
