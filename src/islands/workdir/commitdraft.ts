// Per-repo persistence for the in-progress commit message, kept out of the
// controller so it can be tested without runes — same split as
// detailpanel/splitter.ts.
//
// Why this exists: `workdirCtrl.select()` clears `message` unconditionally, and
// select() runs on ⌘⇧U, on every repo switch, when the Dashboard opens and when
// a repo is closed and reopened. Nothing persisted it, so each of those silently
// threw away whatever the user had typed. That is a data-loss bug on its own,
// and it is also what makes keyboard navigation hostile — you cannot encourage
// people to jump around by keyboard while jumping destroys their work.
//
// localStorage rather than a Rust settings file for the same reason the theme
// lives there: a draft is per-machine scratch state, it must survive a reload
// without a round-trip, and losing it when storage is disabled is acceptable.

const PREFIX = "gitcat.commitDraft:";

// Long messages are real (a wrapped body with bullet points), but an unbounded
// write would let one repo's draft fill the origin's storage quota and start
// throwing for every other key. 32 KB is far past any commit message a person
// types and far short of a quota problem.
const MAX = 32 * 1024;

function keyFor(repo: string): string {
  return PREFIX + repo;
}

/** The stored draft for `repo`, or `""` — never throws. */
export function loadCommitDraft(repo: string): string {
  if (!repo) return "";
  try {
    return localStorage.getItem(keyFor(repo)) ?? "";
  } catch {
    return "";
  }
}

/**
 * Persist `message` for `repo`.
 *
 * An empty (or whitespace-only) message REMOVES the entry rather than storing
 * "": a cleared box means the user is done with that draft, and keeping empty
 * keys around would accumulate one per repo ever opened.
 */
export function saveCommitDraft(repo: string, message: string): void {
  if (!repo) return;
  try {
    if (!message.trim()) localStorage.removeItem(keyFor(repo));
    else localStorage.setItem(keyFor(repo), message.slice(0, MAX));
  } catch {
    /* storage disabled — the draft is still live for this session */
  }
}

/** Drop `repo`'s draft, for when the message has actually been committed. */
export function clearCommitDraft(repo: string): void {
  saveCommitDraft(repo, "");
}
