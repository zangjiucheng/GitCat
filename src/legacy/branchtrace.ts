// Which rows of the loaded graph are reachable from one row's commit — the
// "this branch's history" highlight shown while a branch/tag label is hovered.
// Pure (no DOM, no bridge), so it is unit-testable; legacy/main.ts owns one.
//
// It follows the drawn lines instead of asking git: gap g (between rows g and
// g+1) holds segments {top lane at row g → bottom lane at row g+1}, and at any
// row a lane carries exactly one line, so the set of lanes the traced lines
// occupy at row g+1 is the bottom lanes of the segments leaving the lanes they
// occupy at row g. A line ends at the commit in its lane — that commit is a
// parent, so it is reached, and its own outgoing segments carry the trace on.
//
// The walk is lazy: draw() only ever asks about visible rows, so `has(r)`
// extends it no further than r. Hovering a tip at the top of a 100k-commit
// history costs as many gaps as are on screen, not the whole history.

export type TraceGraph = {
  N: number;
  commitLane: ArrayLike<number>;
  gapStart: ArrayLike<number>;
  gapTop: ArrayLike<number>;
  gapBot: ArrayLike<number>;
};

export class BranchTrace {
  readonly g: TraceGraph;
  readonly from: number;
  private upTo: number;
  private active: Set<number>;
  private readonly on = new Set<number>();

  constructor(g: TraceGraph, from: number) {
    this.g = g;
    this.from = from;
    this.upTo = from;
    this.on.add(from);
    this.active = new Set([g.commitLane[from]]);
  }

  /** Is `row`'s commit an ancestor of (or) the traced one, as far as the loaded rows show? */
  has(row: number): boolean {
    if (row < this.from) return false; // rows are child-before-parent
    this.extendTo(row);
    return this.on.has(row);
  }

  private extendTo(row: number) {
    const { g } = this;
    const to = Math.min(row, g.N - 1);
    while (this.upTo < to && this.active.size) {
      const gap = this.upTo;
      const lo = g.gapStart[gap], hi = g.gapStart[gap + 1];
      // A streaming load's last gap isn't finalized yet: stop, and pick up from
      // here once a later batch arrives (main.ts rebuilds on a new G anyway).
      if (lo === undefined || hi === undefined) return;
      const next = new Set<number>();
      for (let i = lo; i < hi; i++) if (this.active.has(g.gapTop[i])) next.add(g.gapBot[i]);
      this.upTo = gap + 1;
      if (next.has(g.commitLane[gap + 1])) this.on.add(gap + 1);
      this.active = next;
    }
  }
}
