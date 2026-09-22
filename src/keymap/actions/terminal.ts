// The one key the embedded terminal does NOT hand to the shell.
//
// Everything else it does hand over: see Terminal.svelte's
// `attachCustomKeyEventHandler` and the `terminal` scope in scopedefs.ts. The
// consequence, and #142's first half, is that once focus is in the shell there
// is no keyboard way back out.
//
// Escape cannot be that way out. It is a real character readline and vim both
// want, and the scope's own contract already says so (`escape: "native"`), so a
// binding on Escape here would contradict the file next to it. Shift+Escape is
// the answer: no shell binds it, and it is what a user who pressed Escape and
// stayed put will try next.

import { focusPane } from "../panes.ts";

/**
 * Move focus from the shell back to the app, leaving the drawer open.
 *
 * Lands on the graph, the app's fallback pane — somewhere every other chord
 * works from, which is the point of having a way out at all. Returns false when
 * the graph pane is not there to land on, so the binding declines the key and
 * the walk continues rather than swallowing it.
 *
 * The drawer stays open on purpose: "get me out of the shell" and "close the
 * shell" are different intentions, and the second already has both a key (the
 * toggle) and a button.
 */
export function terminalFocusOut(): boolean {
  return focusPane("graph");
}
