// The detail panel's key actions.
//
// Which VIEW is on screen is not a property of the keymap — DetailPanel swaps
// Detail for Workdir whenever the working tree is selected, and each view keeps
// its own active tab so switching away and back does not lose your place. The
// pane scope is what tells them apart: focus inside the working tree resolves
// to "workdir", everything else in #detail to "detail" (see panes.ts).

import { detailPanelCtrl, type PanelView } from "@/islands/detailpanel/detailpanel.svelte.ts";
import { workdirCtrl } from "@/islands/workdir/workdir.svelte.ts";

/**
 * Which view the panel is SHOWING.
 *
 * Read from workdirCtrl.selected, the same signal DetailPanel itself derives
 * from — not from the pane marker under focus. Those are different questions
 * and the difference bites: Workdir's own tab strip, the expanded-diff header
 * and #detail's chrome all sit in the parent `detail` pane, so a focus-based
 * answer cycled the HIDDEN commit tabs while the working tree was on screen.
 * The visible strip did not move, and switching back to a commit landed on a
 * different tab than the one you left.
 */
function viewFor(): PanelView {
  return workdirCtrl.selected ? "worktree" : "commit";
}

export const detailKeys = {
  /**
   * Cycle to the next tab of whichever view is showing.
   *
   * Wraps, because a three-tab strip with no wrap means the last tab is a dead
   * end you have to Shift-cycle out of — and `t` is one key, not two.
   */
  cycleTab(dir: 1 | -1 = 1): false | void {
    const view = viewFor();
    const tabs = detailPanelCtrl.tabsFor(view);
    if (tabs.length < 2) return false;
    const cur = detailPanelCtrl.activeFor(view);
    const i = tabs.findIndex((t) => t.id === cur);
    // An unknown active tab means the view changed under us; land on the first
    // rather than guessing an offset from -1.
    const next = i < 0 ? 0 : (i + dir + tabs.length) % tabs.length;
    detailPanelCtrl.select(view, tabs[next].id);
  },

};
