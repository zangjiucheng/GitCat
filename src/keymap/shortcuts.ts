// The chords that UI COPY mentions by name — tooltips, the help page, danger
// dialogs ("… so ⌘Z/Undo can move it back"). One spec per name, and
// bindings.ts builds its rows from these same constants, so the text a user
// reads and the key the dispatcher matches cannot drift apart.
//
// Copy never spells a chord itself. An i18n string writes `{undoKey}` and t()
// fills it from here via label.ts, which formats per platform: "⌘Z" on macOS,
// "Ctrl+Z" on Windows/Linux. Spelling "⌘Z" into a string is how Windows users
// ended up being told to press a key their keyboard does not have.
//
// Zero imports beyond the other pure keymap modules, like accelerators.ts:
// i18n imports this, and i18n must not pull the dispatcher (or legacy/main.ts
// behind guards.ts) in with it.
import { ACCELERATORS } from "./accelerators.ts";

export const SHORTCUTS = {
  undo: "Mod+KeyZ",
  palette: "Mod+KeyK",
  head: "Mod+Shift+KeyH",
  uncommitted: "Mod+Shift+KeyU",
  fetch: "Mod+Shift+KeyD",
  pull: "Mod+Shift+KeyL",
  push: "Mod+Shift+KeyP",
  focusMode: "Mod+Backslash",
  codeSearch: ACCELERATORS["code-search"],
  pickaxe: ACCELERATORS["pickaxe-search"],
  terminalFocusOut: "Shift+Escape",
} as const;

export type ShortcutName = keyof typeof SHORTCUTS;
