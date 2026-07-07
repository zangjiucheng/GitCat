// Typed wrappers over the Tauri command boundary — the single place the
// frontend names a backend command and its payload shape. Import these instead
// of calling `invoke` with string literals, so the compiler catches a wrong
// command name, a missing arg, or a mis-shaped result.

import type {
  PickResult,
  ConflictStatus,
  ResolveResult,
  ConflictSide,
  BisectStatus,
  BisectTerm,
  WriteResult,
  RefList,
  Snapshot,
  UndoResult,
} from "./types";

// `withGlobalTauri: true` injects `window.__TAURI__`. Reach it through a runtime
// getter so this module is import-safe in a plain browser (design mode), where
// IN_TAURI is false and callers take their demo branch instead of invoking.
interface TauriGlobal {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}
const tauri = (): TauriGlobal | undefined =>
  (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;

/** True only inside the Tauri webview (the `core` bridge exists). */
export const IN_TAURI: boolean = !!tauri()?.core;

function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const t = tauri();
  if (!t) return Promise.reject(new Error(`Tauri unavailable — cannot invoke "${cmd}".`));
  return t.core.invoke(cmd, args) as Promise<T>;
}

// ── cherry-pick (M2b) ───────────────────────────────────────────────────────
export const cherryPick = (path: string, sha: string, recordOrigin = false) =>
  invoke<PickResult>("cherry_pick", { path, sha, recordOrigin });
export const cherryPickContinue = (path: string) =>
  invoke<PickResult>("cherry_pick_continue", { path });
export const cherryPickAbort = (path: string) =>
  invoke<PickResult>("cherry_pick_abort", { path });

// ── conflict resolver (M2b) ─────────────────────────────────────────────────
export const conflictStatus = (path: string) =>
  invoke<ConflictStatus>("conflict_status", { path });
export const resolveConflictFile = (path: string, file: string, side: ConflictSide) =>
  invoke<ResolveResult>("resolve_conflict_file", { path, file, side });

// ── bisect (M3) — note `good` is an ARRAY ───────────────────────────────────
export const bisectStart = (path: string, bad: string, good: string[]) =>
  invoke<BisectStatus>("bisect_start", { path, bad, good });
export const bisectMark = (path: string, term: BisectTerm) =>
  invoke<BisectStatus>("bisect_mark", { path, term });
export const bisectStatus = (path: string) =>
  invoke<BisectStatus>("bisect_status", { path });
export const bisectReset = (path: string) =>
  invoke<BisectStatus>("bisect_reset", { path });

// ── branch ops (M2a) ────────────────────────────────────────────────────────
export const listRefs = (path: string) => invoke<RefList>("list_refs", { path });
export const checkout = (path: string, name: string) =>
  invoke<WriteResult>("checkout", { path, name });
export const createBranch = (
  path: string,
  name: string,
  startPoint: string | null = null,
  checkout: boolean | null = null,
) => invoke<WriteResult>("create_branch", { path, name, startPoint, checkout });
export const deleteBranch = (path: string, name: string, force: boolean) =>
  invoke<WriteResult>("delete_branch", { path, name, force });
export const renameBranch = (path: string, from: string, to: string) =>
  invoke<WriteResult>("rename_branch", { path, from, to });

// ── Safety Manager (M2a/M2c) ────────────────────────────────────────────────
export const listSnapshots = (path: string) => invoke<Snapshot[]>("list_snapshots", { path });
export const createSnapshot = (path: string) => invoke<Snapshot>("create_snapshot", { path });
export const undoLast = (path: string) => invoke<UndoResult>("undo_last", { path });
