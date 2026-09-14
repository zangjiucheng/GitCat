// The codegen loads accelerators.ts and chord.ts under
// `node --experimental-strip-types`, which has no bundler, no `@` alias and no
// way to resolve an extensionless import. It also must never pull in the app:
// guards.ts -> @/legacy/bridge -> legacy/main.ts is a canvas app that boots on
// import. These four files are the ones that have to stay clean for that.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PURE = ["accelerators.ts", "chord.ts", "claim.ts", "scopes.ts"];

describe.each(PURE)("src/keymap/%s", (file) => {
  const src = readFileSync(`src/keymap/${file}`, "utf8");
  const imports = [...src.matchAll(/^\s*import\b[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);

  it("imports nothing outside src/keymap/", () => {
    for (const spec of imports) {
      expect(spec, `${file} imports ${spec}`).toMatch(/^\.\/[\w.-]+\.ts$/);
    }
  });

  it("uses no @ alias, which node's type-stripping cannot resolve", () => {
    expect(src).not.toMatch(/from\s+"@\//);
  });
});

describe("scripts/keymap-gen.ts", () => {
  const gen = readFileSync("scripts/keymap-gen.ts", "utf8");

  it("reads only the pure modules, never bindings.ts", () => {
    expect(gen).not.toMatch(/from\s+"[^"]*bindings\.ts"/);
    expect(gen).toContain("accelerators.ts");
    expect(gen).toContain("chord.ts");
  });

  it("writes explicit .ts extensions, which type-stripping requires", () => {
    for (const m of gen.matchAll(/from\s+"(\.\.?\/[^"]+)"/g)) {
      expect(m[1]).toMatch(/\.ts$/);
    }
  });
});
