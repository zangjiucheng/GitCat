// The marker gate. Every shadow binding names the listener it shadows (`owns`),
// and that listener carries a `// @keymap-owns <id>` comment. Flipping a binding
// live means deleting BOTH — this test is what stops someone doing one without
// the other, which would either double-fire the action or silently drop it.
//
// Reads with fs.readFileSync, never grep: src/main.ts contains NUL bytes (at
// lines 409-410), so grep/rg reports "Binary file matches" and skips it — taking
// two global handlers with it.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/legacy/bridge", () => ({ CUR_REPO: "/repo", G: { N: 0 } }));

import { BINDINGS } from "./bindings.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|svelte|js)$/.test(p) && !/\.(test|spec)\.ts$/.test(p)) out.push(p);
  }
  return out;
}

const files = walk("src");
const marked = new Map<string, string[]>(); // binding id -> files that claim it
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/@keymap-owns ([\w. ]+)/g)) {
    for (const id of m[1].trim().split(/\s+/)) {
      if (!marked.has(id)) marked.set(id, []);
      marked.get(id)!.push(f);
    }
  }
}

const shadow = BINDINGS.filter((b) => b.mode === "shadow");

describe("@keymap-owns markers", () => {
  it("has shadow bindings to check", () => {
    expect(shadow.length).toBeGreaterThan(0);
  });

  it.each(shadow.map((b) => [b.id]))("%s is marked on the listener it shadows", (id) => {
    expect(marked.get(id), `no // @keymap-owns ${id} anywhere under src/`).toBeDefined();
  });

  it("has no marker left behind for a binding that is no longer shadow", () => {
    const shadowIds = new Set(shadow.map((b) => b.id));
    const orphans = [...marked.keys()].filter((id) => !shadowIds.has(id));
    expect(orphans, "these ids are marked but are not shadow bindings").toEqual([]);
  });

  it("finds src/main.ts's handlers despite its NUL bytes", () => {
    // The regression guard for the scanner itself: if someone switches this to
    // grep, the two ids below go silently unchecked and nobody notices.
    const mainTs = join("src", "main.ts");
    expect(marked.get("app.settings")).toContain(mainTs);
    expect(marked.get("repo.open")).toContain(mainTs);
    expect(readFileSync("src/main.ts").includes(0)).toBe(true);
  });
});
