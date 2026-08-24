// The detail panel's chrome state: which tabs each view has, and which one it
// is showing.
//
// Tabs are declared as data rather than as a chain of {#if} branches, the same
// way SETTINGS_TABS is (islands/settings/settings.svelte.ts) — adding a tab is
// then one array entry, and TabStrip.svelte never learns what a tab contains.
//
// Each entry names an i18n key in its OWN view's namespace instead of the tab
// strip owning a third one. The two "commit" tabs therefore do not share a
// key: one names the commit you are looking at and the other the commit you
// are writing, and a translator must be free to render those differently even
// though they collide in English.

import { settingsCtrl } from "../settings/settings.svelte.ts";

export type PanelView = "commit" | "worktree";
export type PanelTabId = "commit" | "changes" | "stash";

export interface PanelTab {
  id: PanelTabId;
  /// Already-namespaced i18n key, resolved by the renderer with `t()`.
  labelKey: string;
}

export const COMMIT_VIEW_TABS: PanelTab[] = [
  { id: "commit", labelKey: "detail.tab_commit" },
  { id: "changes", labelKey: "detail.changes" },
];

/// The working tree gets a third: the stash is genuinely a separate thing, and
/// today it is the last of six stacked sections you have to scroll to find.
export const WORKTREE_VIEW_TABS: PanelTab[] = [
  { id: "commit", labelKey: "workdir.commit" },
  { id: "changes", labelKey: "workdir.changes" },
  { id: "stash", labelKey: "workdir.stash" },
];

class DetailPanelState {
  commitTab = $state<PanelTabId>("commit");
  worktreeTab = $state<PanelTabId>("commit");

  /**
   * The `Splitter` axis for the "changes" tab's two panes (file tree + diff),
   * shared by both the commit view and the working-tree view so neither one
   * declares its own copy.
   *
   * Derived from `settingsCtrl.detailPanelPlacement` — the `$state` field
   * `setDetailPanelPlacement` actually writes — rather than from the
   * `data-detail-placement` root attribute CSS reads: Svelte cannot track a
   * DOM attribute, so a `$derived` reading it would freeze at whatever value
   * was current on first read and never move again when the setting changes
   * live. The attribute is a projection of this setting for CSS's benefit,
   * not a store to read back.
   *
   * Bottom placement puts the panel's two panes side by side (own width is
   * scarce, height is plentiful), so the splitter drags left/right: axis
   * "x". Right placement stacks them (own height is scarce), so the
   * splitter drags up/down: axis "y".
   */
  changesSplitAxis = $derived<"x" | "y">(settingsCtrl.detailPanelPlacement === "bottom" ? "x" : "y");

  tabsFor(view: PanelView): PanelTab[] {
    return view === "commit" ? COMMIT_VIEW_TABS : WORKTREE_VIEW_TABS;
  }

  activeFor(view: PanelView): PanelTabId {
    return view === "commit" ? this.commitTab : this.worktreeTab;
  }

  /**
   * Show `id` in `view`.
   *
   * A tab the view does not declare is ignored rather than stored: it would
   * render a panel with no content and no visible tab to get back from.
   * Reachable through a stale keyboard shortcut or a future caller passing
   * the wrong view.
   *
   * The two views keep separate active tabs, so switching to the working tree
   * and back does not lose which commit tab you were reading.
   */
  select(view: PanelView, id: PanelTabId): void {
    if (!this.tabsFor(view).some((t) => t.id === id)) return;
    if (view === "commit") this.commitTab = id;
    else this.worktreeTab = id;
  }
}

export const detailPanelCtrl = new DetailPanelState();

/**
 * Per-axis bounds for the "changes" tab's file-list/diff `Splitter`, shared
 * by the commit view (Task 7) and — Task 8 — the working-tree view, so
 * neither declares its own copy of the numbers (the same duplication
 * `changesSplitAxis` above was introduced to avoid).
 *
 * A width and a height are different physical quantities bounded by
 * different available space, so this is two full configs rather than one
 * range serving both:
 *
 * - "x" (bottom placement): the file list sits beside the diff in a row that
 *   spans the whole window, so its width can be generous. Reuses the
 *   expanded-diff modal's own established width bounds for the identical
 *   widget — a file tree beside its diff (Detail.svelte's `.diffx-files`
 *   Splitter: min 160, max 620, default 280) — rather than inventing new
 *   numbers for what is visually the same control, just embedded in the
 *   panel instead of a modal.
 * - "y" (right placement): the file list stacks ABOVE the diff inside a
 *   column only 240-560px wide (legacy/main.ts's own `--detail-w` bounds for
 *   that column). A max as generous as "x"'s — or as the bottom PANEL's own
 *   height ceiling (720, `--detail-h`) — would let the file list swallow the
 *   whole column on an ordinary laptop screen, leaving nothing for the diff
 *   it sits above. Both its max and its default are smaller, so the diff
 *   pane keeps room by default.
 *
 * Separate storage keys, not one shared key: a width remembered in pixels
 * makes a poor height, and vice versa — sharing a key would silently reapply
 * one axis's saved size to the other the next time placement changes.
 */
export const CHANGES_SPLIT: Record<"x" | "y", { min: number; max: number; defaultSize: number; storageKey: string }> = {
  x: { min: 160, max: 620, defaultSize: 280, storageKey: "gitcat.detailChangesW" },
  y: { min: 160, max: 420, defaultSize: 200, storageKey: "gitcat.detailChangesH" },
};
