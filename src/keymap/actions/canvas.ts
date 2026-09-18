// The commit graph's key actions.
//
// Everything here acts on `state.selectedRow`, which is the canvas's ONE piece
// of cursor state (a single integer — there is no multi-select, which is why
// the audit's `v` proposal was deferred rather than bound).
//
// The pinned "Uncommitted changes" band is row -2, a sentinel that sits outside
// the [0, N-1] range every other row lives in. Each action below has to say
// what it does there rather than assuming a commit, which is exactly what the
// audit found missing: the row users visit most could not be reached by j/k and
// Enter on it did nothing.

import * as bridge from "@/legacy/bridge";
import { scrollRowIntoView } from "@/islands/vimnav/vimnav.svelte.ts";

// legacy/main.ts:1875-1880 — three distinct values, and conflating the first
// two is how a "nothing selected" check silently starts matching the band.
const NONE = -1;
const BAND = -2;

function selectedRow(): number {
  const r = (bridge.state as unknown as { selectedRow?: number }).selectedRow;
  return typeof r === "number" ? r : NONE;
}

function rowCount(): number {
  return ((bridge.G as unknown as { N?: number } | null)?.N ?? 0);
}

/**
 * Select a row AND bring it on screen.
 *
 * bridge.select() only sets state.selectedRow and swaps the detail panel — it
 * does not scroll. vimnav's own j/k/gg/G always pair it with scrollRowIntoView
 * for that reason, and because these bindings CLAIM their keys, the old canvas
 * handler that used to move scrollTarget no longer runs. Without this the
 * cursor walks off screen and the graph sits still, which reads as the key
 * doing nothing at all.
 *
 * The band (row -2) is deliberately not scrolled to: it lives in fixed screen
 * space above the graph and is always visible.
 */
function show(row: number): void {
  bridge.select(row);
  scrollRowIntoView(row);
}

export const canvasKeys = {
  /**
   * Open the commit actions menu on the selected row.
   *
   * This is the pressure valve from #144's rule 3: ~25 low-frequency operations
   * live behind it instead of each minting a letter. Declines on the band and
   * with nothing selected — none of cherry-pick / merge / revert / reset /
   * branch-here / tag-here mean anything for uncommitted changes.
   */
  openMenu(): false | void {
    if (!bridge.openCommitMenuForSelectedRow()) return false;
  },

  /**
   * Move the selection by one row.
   *
   * Extends the clamp to include the band, which `moveCanvasSelection` does
   * not: the band is row -2 and its range check is [0, N-1], so the row users
   * visit most was unreachable by keyboard. Stepping up from row 0 lands on it;
   * stepping down from it lands on row 0.
   */
  move(dir: 1 | -1): false | void {
    const row = selectedRow();
    const n = rowCount();
    if (!n) return false;
    if (row === BAND) {
      if (dir < 0) return false; // already at the top
      show(0);
      return;
    }
    if (row === NONE) {
      show(dir > 0 ? 0 : n - 1);
      return;
    }
    if (dir < 0 && row === 0) {
      // Step UP off the first commit into the band, when there is one.
      if (bridge.bandH() > 0) {
        bridge.selectWorkdir();
        return;
      }
      return false;
    }
    const next = row + dir;
    if (next < 0 || next >= n) return false;
    show(next);
  },

  /** Jump to the first or last commit. Never lands on the band. */
  jump(where: "first" | "last"): false | void {
    const n = rowCount();
    if (!n) return false;
    show(where === "first" ? 0 : n - 1);
  },

  /**
   * Clear the selection.
   *
   * Registered LAST in the Escape chain (canvas scope sits at the bottom of the
   * stack), so every open overlay gets Escape first and this only runs when
   * there is genuinely nothing else to close.
   */
  deselect(): false | void {
    if (selectedRow() === NONE) return false;
    // bridge.deselect(), NOT select(-1): the latter only asks detailCtrl to
    // select a row that does not exist and leaves the panel showing the last
    // commit, which looks to the user like Escape did nothing.
    bridge.deselect();
  },
};
