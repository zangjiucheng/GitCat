// The Rust/JS boundary. src-tauri/src/keymap_generated.rs is committed but
// generated; `pnpm keymap:check` proves it is in sync with accelerators.ts.
// These assert the other half — that accelerators.ts is in sync with menu.rs,
// which no codegen can check because menu.rs is hand-written.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCELERATORS } from "./accelerators.ts";
import { parseChord, toAccelerator } from "./chord.ts";

const menuRs = readFileSync("src-tauri/src/menu.rs", "utf8");
const generated = readFileSync("src-tauri/src/keymap_generated.rs", "utf8");

// The pre-PR list, hard-coded. If someone changes a shortcut, this line is
// where they have to say so out loud.
const BEFORE: Record<string, string> = {
  "open-repo": "CmdOrCtrl+O",
  "new-branch": "CmdOrCtrl+Shift+N",
  "code-search": "CmdOrCtrl+F",
  "pickaxe-search": "CmdOrCtrl+Shift+F",
  settings: "CmdOrCtrl+,",
  "open-terminal": "CmdOrCtrl+`",
  "new-window": "CmdOrCtrl+N",
};

describe("accelerators.ts", () => {
  it("still produces exactly the seven accelerators that shipped before PR 1", () => {
    const now = Object.fromEntries(
      Object.entries(ACCELERATORS).map(([id, spec]) => [id, toAccelerator(parseChord(spec))]),
    );
    expect(now).toEqual(BEFORE);
  });

  it("names only menu item ids that exist in menu.rs", () => {
    for (const id of Object.keys(ACCELERATORS)) {
      expect(menuRs, id).toContain(`"${id}"`);
    }
  });
});

describe("keymap_generated.rs", () => {
  it("contains every accelerator, sorted, and nothing else", () => {
    const rows = [...generated.matchAll(/\("([^"]+)",\s*"([^"]+)"\)/g)].map((m) => [m[1], m[2]]);
    expect(Object.fromEntries(rows)).toEqual(BEFORE);
    expect(rows.map((r) => r[0])).toEqual([...rows.map((r) => r[0])].sort());
  });

  it("is marked generated so nobody hand-edits it", () => {
    expect(generated).toContain("@generated");
    expect(generated).toContain("DO NOT EDIT");
  });
});

describe("menu.rs", () => {
  it("hard-codes no accelerator of its own any more", () => {
    // Exactly one `.accelerator(` remains — inside the `mk` helper, fed by the
    // generated table. A second one means someone re-introduced a literal.
    expect(menuRs.match(/\.accelerator\(/g) ?? []).toHaveLength(1);
    expect(menuRs).toContain("crate::keymap_generated::accel(id)");
  });

  it("leaves the predefined Close Window item alone", () => {
    // ⌘W comes from here. The OS supplies predefined items' accelerators, so it
    // must never be routed through `mk` — and scopes.ts RESERVES the chord.
    expect(menuRs).toContain(".close_window()");
  });
});
