import { describe, expect, it } from "vitest";
import { shouldOfferStashUndo } from "./undoflow.ts";
import type { UndoResult } from "../ipc/bindings";

const res = (partial: Partial<UndoResult>): UndoResult => ({
  ok: false,
  message: "",
  restoredTo: null,
  sealed: null,
  reason: null,
  ...partial,
});

describe("shouldOfferStashUndo", () => {
  it("offers stash-undo for a dirty-worktree refusal, whatever the message language", () => {
    // The backend's message is an i18n key / localized text — e.g. zh — which
    // the old /uncommitted changes/i regex could never match.
    expect(shouldOfferStashUndo(res({ reason: "dirty_worktree", message: "err_misc.worktree_has_uncommitted_undo" }), false)).toBe(true);
    expect(shouldOfferStashUndo(res({ reason: "dirty_worktree", message: "工作区有未提交的更改 —— 请先提交或贮藏后再撤销。" }), false)).toBe(true);
  });

  it("does not offer it for other refusals, even if the message mentions uncommitted changes", () => {
    for (const reason of ["nothing_to_undo", "cannot_verify_clean", "snapshot_failed", "stale_selection", "failed"] as const) {
      expect(shouldOfferStashUndo(res({ reason, message: "uncommitted changes" }), false)).toBe(false);
    }
    expect(shouldOfferStashUndo(res({ reason: null, message: "Working tree has uncommitted changes" }), false)).toBe(false);
  });

  it("never offers it on success, a missing result, or the stash-undo path", () => {
    expect(shouldOfferStashUndo(res({ ok: true, reason: null }), false)).toBe(false);
    expect(shouldOfferStashUndo(null, false)).toBe(false);
    expect(shouldOfferStashUndo(undefined, false)).toBe(false);
    expect(shouldOfferStashUndo(res({ reason: "dirty_worktree" }), true)).toBe(false);
  });
});
