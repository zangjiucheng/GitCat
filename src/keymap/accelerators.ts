// Menu-item id -> chord spec, for the NATIVE accelerators only. The codegen
// script reads THIS file, never bindings.ts: bindings.ts imports guards.ts ->
// legacy/bridge -> legacy/main.ts, which boots a whole canvas app on import
// (see e2e/keymap-safety.spec.ts:6-8). This file and chord.ts have zero app
// imports and use explicit .ts extensions, which is exactly what Node's
// type-stripping needs.
//
// src/keymap/boundary.test.ts asserts this file's import graph stays empty.
// bindings.ts imports these same specs, so the table and the menu cannot drift.
//
// Every entry here MUST already exist verbatim in src-tauri/src/menu.rs. PR 1
// adds none and changes none; keymap.accelerators.test.ts pins that.
export const ACCELERATORS = {
  "open-repo": "Mod+KeyO",          // menu.rs:66
  "new-branch": "Mod+Shift+KeyN",   // menu.rs:74
  "code-search": "Mod+KeyF",        // menu.rs:150
  "pickaxe-search": "Mod+Shift+KeyF", // menu.rs:160
  "settings": "Mod+Comma",          // menu.rs:238
  "open-terminal": "Mod+Backquote", // menu.rs:264
  "new-window": "Mod+KeyN",         // menu.rs:324
} as const;

export type MenuAccelId = keyof typeof ACCELERATORS;
