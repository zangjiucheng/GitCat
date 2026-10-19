// Pure decision for globalUndo() in legacy/main.ts (which has no unit tests:
// it boots the whole app on import) — whether a refused undo should offer the
// "stash, undo, re-apply" path (undo_last_stashing).
//
// Branches on UndoResult.reason, the backend's machine-readable refusal code
// (safety.rs's UndoRefusal), NEVER on `message`: `message` is localized display
// text (an i18n key resolved by be()), so the old English regex
// /uncommitted changes/i never matched it and the offer could never appear.

import type { UndoResult } from "../ipc/bindings";

/** True when a plain undo_last refused ONLY because the working tree is dirty,
 *  so stash → undo → pop can safely run instead. Never for the stash-undo path
 *  (stash_undo_apply), which has its own semantics. */
export function shouldOfferStashUndo(res: Partial<UndoResult> | null | undefined, useStashUndo: boolean): boolean {
  if (useStashUndo || !res || res.ok) return false;
  return res.reason === "dirty_worktree";
}
