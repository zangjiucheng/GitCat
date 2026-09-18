// Scope definitions. Called once from src/main.ts, after the table is
// registered and before any island can push.
//
// defineScope is separate from pushScope so that a scope's CONTRACT — its rank,
// whether it terminates the walk, and above all what it does with Escape — is
// declared in one place a reviewer can read, rather than being an emergent
// property of whichever island happened to push last.
//
// `escape` has no default on purpose (see scopes.ts): legacy/main.ts's
// unguarded `if (e.key === "Escape") disarmDanger()` is exactly the bug that a
// default would let someone write again.

import { keymap } from "./registry.ts";

export function defineScopes(): void {
  // The canvas. Bottom of the interactive stack, always reachable, and the
  // scope the vim keys will belong to from PR 3. Escape deselects, so it is
  // "own" — but it is NOT modal: the palette and the help overlay above it must
  // still resolve.
  keymap.defineScope({ id: "graph", rank: 10, escape: "own", owner: "legacy/main.ts" });

  // The three panes. Ranked above the graph so a pane with focus wins a bare
  // letter, and below every overlay.
  keymap.defineScope({ id: "sidebar", rank: 20, escape: "transparent", owner: "Sidebar.svelte" });
  keymap.defineScope({ id: "detail", rank: 20, escape: "transparent", owner: "Detail.svelte" });
  keymap.defineScope({ id: "workdir", rank: 20, escape: "transparent", owner: "Workdir.svelte" });

  // A [data-vimnav-list] row cursor, wherever it is. Transparent so Escape
  // still reaches the pane or overlay that owns the list.
  keymap.defineScope({ id: "list", rank: 30, escape: "transparent", owner: "vimnav.svelte.ts" });

  // Any ordinary island scrim. Modal: nothing below it is reachable, which is
  // the typed replacement for the `document.querySelector(".scrim.on")` probe
  // repeated in five files.
  keymap.defineScope({ id: "modal", rank: 100, modal: true, escape: "own", owner: "islands/*" });

  // The palette sits ABOVE ordinary modals — it is the app's escape hatch, not
  // a peer of the dialogs it can be opened over.
  keymap.defineScope({ id: "palette", rank: 200, modal: true, escape: "own", owner: "Cmdk.svelte" });

  keymap.defineScope({ id: "lightbox", rank: 210, modal: true, escape: "own", owner: "PreviewLightbox.svelte" });
  keymap.defineScope({ id: "help", rank: 220, modal: true, escape: "own", owner: "#helpScrim" });

  // The destructive pair — #dangerScrim and TamaConfirm, the two scrims PR 0
  // marked with data-modal-blocking. Highest rank, so nothing can be opened
  // over an armed irreversible action and then take its Escape.
  keymap.defineScope({ id: "danger", rank: 300, modal: true, escape: "own", owner: "#dangerScrim / TamaConfirm" });

  // The terminal takes Escape NATIVELY: it is a real character readline and vim
  // both want, and Terminal.svelte registers no attachCustomKeyEventHandler, so
  // anything the registry swallows here never reaches the shell.
  keymap.defineScope({ id: "terminal", rank: 40, escape: "native", owner: "Terminal.svelte" });
}
