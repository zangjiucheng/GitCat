// The only module in src/keymap/ that reads app state or the DOM. bindings.ts
// references these BY NAME (`when: ["repoOpen"]`), never by function, so the
// table stays loadable by the codegen and the compiler stays pure.

import * as bridge from "@/legacy/bridge";
import type { GuardTable, KeyCtx } from "./types.ts";

// NOTE — isTextInputFocused is NOT moved here from vimnav.svelte.ts:36, and is
// NOT re-exported from there. Two variants live in dispatch.ts's textProbe
// instead, because:
//   (a) the legacy 3-selector form and vimnav's select-inclusive form are
//       genuinely different guards today and unifying them is a behaviour
//       change (⌘Z with Sidebar.svelte:431's branch-from <select> focused would
//       stop undoing), which a zero-behaviour-change PR must not smuggle in;
//   (b) moving the function edits vimnav.svelte.ts, whose 376-line suite is the
//       only executable spec for gg / the modifier guard / Enter precedence.
//       Touching it here buys nothing and risks the net PR 3 depends on.
// src/keymap/guards.test.ts asserts the two implementations agree on every
// element type, so the duplication cannot silently drift. The re-export lands
// in the PR that ports vimnav.

export const GUARDS: GuardTable = {
  /** Every ⌘K action but repositories/external-tools/plugins forwards
   *  bridge.CUR_REPO; CodeSearch.svelte:18 bails on it outright. */
  repoOpen: () => !!(bridge.CUR_REPO as unknown as string | null),

  // These two are markers: dispatch.ts's textProbe reads which variant a
  // binding named and applies it before running any guard, so the predicates
  // themselves are trivially true. They exist so the variant is VISIBLE in the
  // table and in dumpKeymap() rather than implicit.
  notTextInput: () => true,
  notTextInputOrSelect: () => true,

  /** Replaces `document.querySelector(".scrim.on")`, repeated verbatim at
   *  vimnav.svelte.ts:139, Cmdk.svelte:30 and :45, CodeSearch.svelte:23 and
   *  legacy/main.ts:1680.
   *  DELIBERATELY the old selector, NOT [data-modal-blocking]. PR 0 added that
   *  attribute at index.html:2290 and TamaConfirm.svelte:35 and it has ZERO
   *  readers on this branch — switching to it would stop ⌘K bailing over
   *  Settings, Bisect and the expanded diff, which is a real behaviour change
   *  and belongs in its own PR. */
  noScrimOpen: () => !document.querySelector(".scrim.on"),

  /** Cmdk.svelte:26-29: "The terminal gets first claim on its own keys. xterm's
   *  helper textarea lets keydown bubble to window and Terminal.svelte
   *  registers no attachCustomKeyEventHandler." */
  notInTerminal: (c: KeyCtx) => !(c.event.target as Element | null)?.closest?.(".term-drawer"),

  graphHasRows: () => ((bridge.G as unknown as { N?: number } | null)?.N ?? 0) > 0,

  inTauri: () => !!(window as unknown as { __TAURI__?: unknown }).__TAURI__,
};
