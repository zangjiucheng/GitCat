// Hand-written mirrors of the Rust command payloads.
//
// Every backend struct is `#[serde(rename_all = "camelCase")]`, so keys are
// camelCase here. serde `Option<T>` serializes as the key PRESENT with value
// `null` (never omitted) → model as `T | null`, NOT optional `?`.
//
// TODO(Phase 1): auto-generate this file from the Rust commands with
// tauri-specta so it can never drift from the serde structs.

// ── cherry-pick (git_pick.rs) ───────────────────────────────────────────────
export type PickState = "clean" | "empty" | "conflict" | "error";

/** git_pick.rs::PickResult — one cherry-pick / continue / abort step. */
export interface PickResult {
  state: PickState;
  message: string;
  conflictedFiles: string[];
  backupRef: string | null;
}

// ── conflict resolver (conflict.rs) ─────────────────────────────────────────
/** conflict.rs::ConflictFile — three merge stages as text. An absent side is
 *  "" ; a binary side is the marker "‹binary›". */
export interface ConflictFile {
  path: string;
  ours: string;
  base: string;
  theirs: string;
}

/** conflict.rs::ConflictStatus */
export interface ConflictStatus {
  inProgress: boolean;
  op: string;
  files: ConflictFile[];
}

/** conflict.rs::ResolveResult — `remaining` is the count still unmerged. */
export interface ResolveResult {
  ok: boolean;
  remaining: number;
  message: string;
}

export type ConflictSide = "ours" | "theirs";

// ── bisect (git_bisect.rs) ──────────────────────────────────────────────────
export type BisectTerm = "good" | "bad" | "skip";

/** git_bisect.rs::CommitInfo */
export interface CommitInfo {
  sha: string;
  subject: string;
}

/** git_bisect.rs::BisectStatus — plain return (never a Result); failure is
 *  `ok:false` + `message`. Running = inProgress && !firstBad; done = !!firstBad. */
export interface BisectStatus {
  ok: boolean;
  inProgress: boolean;
  current: CommitInfo | null;
  badRef: string | null;
  goodRefs: string[];
  remainingRevs: number;
  estSteps: number;
  firstBad: CommitInfo | null;
  log: string[];
  message: string;
  backupRef: string | null;
}

// ── branch ops (git_write.rs) ───────────────────────────────────────────────
/** git_write.rs::WriteResult — standard mutation result. */
export interface WriteResult {
  ok: boolean;
  message: string;
  backupRef: string | null;
}

/** git_write.rs::LocalBranch — ahead/behind are null with no upstream. */
export interface LocalBranch {
  name: string;
  sha: string;
  ahead: number | null;
  behind: number | null;
}

/** git_write.rs::SimpleRef — a remote branch or tag. */
export interface SimpleRef {
  name: string;
  sha: string;
}

/** git_write.rs::RefList — `head` is null when detached/unborn. */
export interface RefList {
  head: string | null;
  locals: LocalBranch[];
  remotes: SimpleRef[];
  tags: SimpleRef[];
}

// ── Safety Manager (safety.rs) ──────────────────────────────────────────────
/** safety.rs::Snapshot — note `reference` serializes as `ref`. */
export interface Snapshot {
  ref: string;
  ts: number;
  sha: string;
  subject: string;
}

/** safety.rs::UndoResult */
export interface UndoResult {
  ok: boolean;
  message: string;
  restoredTo: string | null;
  sealed: string | null;
}

// load_graph → GraphData and commit_detail → CommitDetail remain owned by the
// legacy canvas module (untyped) in Phase 0; add them here when that path migrates.
