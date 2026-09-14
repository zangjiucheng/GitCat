// The working tree's key actions, kept out of bindings.ts so the table stays a
// table: `run: () => workdirKeys.stage()` reads as one line, and the DOM
// reading and the guard logic live somewhere testable.
//
// Every row action acts on the FOCUSED row, read out of the DOM, not on
// `workdirCtrl.selectedDiffFile`. Those are different gestures: selecting a row
// shows its diff, and moving a cursor over rows is navigation. Conflating them
// would make `d` discard whatever the user last previewed, which is the kind of
// surprise that makes people stop trusting single-letter keys.

import * as bridge from "@/legacy/bridge";
import { workdirCtrl } from "@/islands/workdir/workdir.svelte.ts";

export interface FocusedRow {
  readonly path: string;
  readonly staged: boolean;
  readonly untracked: boolean;
}

/**
 * The row the cursor is on, or null.
 *
 * `closest` rather than an exact match so a key pressed while focus sits on one
 * of a row's own action buttons still acts on that row — those buttons are the
 * only keyboard route to reveal/copy and deliberately stayed in the tab order.
 */
export function focusedRow(doc: Document = document): FocusedRow | null {
  const el = doc.activeElement?.closest?.<HTMLElement>("[data-wd-path]");
  if (!el) return null;
  const path = el.getAttribute("data-wd-path");
  if (!path) return null;
  return {
    path,
    staged: el.getAttribute("data-wd-staged") === "true",
    untracked: el.getAttribute("data-wd-untracked") === "true",
  };
}

function repo(): string | null {
  return (bridge.CUR_REPO as unknown as string | null) || null;
}

/**
 * Declining (returning false) rather than swallowing is the contract every one
 * of these follows: a key that cannot act here keeps falling outward to the
 * detail pane and then to global, instead of silently doing nothing.
 */
/**
 * Is focus in a field that is NOT the commit box?
 *
 * The commit chords are allowInTextInput so they can fire from the message
 * box — but the working tree holds other fields (the stash message, its
 * include-untracked checkbox), and ⌘↵ in those means "submit this form", not
 * "commit". Declining there also lets the field's own Enter handler run, which
 * capture-phase dispatch would otherwise suppress.
 */
function inForeignField(doc: Document = document): boolean {
  const el = doc.activeElement;
  if (!el?.closest?.("input, textarea, select, [contenteditable=true]")) return false;
  return !el.closest("[data-wd-commit-box]");
}

export const workdirKeys = {
  commit(amend: boolean): false | void {
    const r = repo();
    if (!r || workdirCtrl.busy) return false;
    if (inForeignField()) return false;
    // Amend is a rewrite, so it goes through the same toggle the button does
    // rather than committing straight over the previous commit.
    if (amend) workdirCtrl.amend = true;
    void workdirCtrl.commit(r);
  },

  stage(): false | void {
    const r = repo();
    const row = focusedRow();
    if (!r || !row || workdirCtrl.busy) return false;
    // Already staged — decline rather than issuing a no-op git call.
    if (row.staged) return false;
    void workdirCtrl.stageFile(r, row.path);
  },

  unstage(): false | void {
    const r = repo();
    const row = focusedRow();
    if (!r || !row || workdirCtrl.busy) return false;
    if (!row.staged) return false;
    void workdirCtrl.unstageFile(r, row.path);
  },

  stageAll(): false | void {
    const r = repo();
    if (!r || workdirCtrl.busy) return false;
    void workdirCtrl.stageAll(r);
  },

  unstageAll(): false | void {
    const r = repo();
    if (!r || workdirCtrl.busy) return false;
    void workdirCtrl.unstageAll(r);
  },

  discard(): false | void {
    const row = focusedRow();
    if (!repo() || !row || workdirCtrl.busy) return false;
    // Unstaged rows only. Discarding a STAGED row means unstage-then-discard,
    // which is two undoable steps presented as one irreversible key — the
    // context menu does not offer it either.
    if (row.staged) return false;
    // The same confirmation the context menu raises. A bare letter must never
    // reach an irreversible git operation directly.
    workdirCtrl.confirmDiscard(row.path, row.untracked);
  },
};
