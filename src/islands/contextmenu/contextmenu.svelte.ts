// Shared right-click menu — one component + one controller, used by every
// surface that needs a context menu.
//
// Why shared rather than another hand-rolled one: Workdir already grew its
// own (a backdrop div plus an absolutely positioned div), Sidebar grew a
// second, and this change adds two more surfaces. A fourth copy would mean
// four places to fix the next positioning or dismissal bug in. Sidebar's own
// menus are deliberately NOT migrated here — they are unrelated to this
// change and rewriting them would put working code at risk for tidiness.
//
// The controller owns only what a caller can get wrong; rendering, viewport
// clamping and dismissal are ContextMenu.svelte's.

export type ContextMenuItem = {
  /// Stable, translation-independent identity: the `{#each}` key, and what
  /// tests address an item by. Keying on the label instead would collide the
  /// moment two items translate to the same string, and would make every
  /// assertion depend on the active locale.
  id: string;
  /// Already translated by the caller — this module never calls `t()`, so it
  /// stays free of any i18n or app dependency.
  label: string;
  run: () => void;
  /// Renders in the danger colour (destructive actions, e.g. Discard).
  danger?: boolean;
  /// Shown but unrunnable — used for an action that does not apply to THIS
  /// row (revealing a file the commit deleted, which is not on disk). Kept
  /// visible rather than hidden so the menu's shape doesn't shift between
  /// rows, which is what makes a menu hard to build muscle memory for.
  disabled?: boolean;
  /// Draws a divider above this item. Groups the actions a surface already
  /// had from the ones this change adds.
  separatorBefore?: boolean;
};

type OpenMenu = { items: ContextMenuItem[]; x: number; y: number };

class ContextMenuState {
  menu = $state<OpenMenu | null>(null);

  /**
   * Show `items` at the click point. A second call replaces whatever was
   * open — right-clicking another row must not leave the previous row's
   * actions on screen, pointing at a file the user has moved away from.
   *
   * An empty list is a no-op rather than an empty box, so callers can build
   * their list conditionally and pass it straight through.
   */
  open(items: ContextMenuItem[], x: number, y: number): void {
    if (!items.length) return;
    this.menu = { items, x, y };
  }

  close(): void {
    this.menu = null;
  }

  /**
   * Run an item's action.
   *
   * Closes FIRST: several of these actions open a dialog or a confirm
   * scrim, and this menu's own backdrop would otherwise still be mounted to
   * swallow the first click in whatever just opened.
   */
  run(item: ContextMenuItem): void {
    if (item.disabled) return;
    this.close();
    item.run();
  }
}

export const contextMenuCtrl = new ContextMenuState();
