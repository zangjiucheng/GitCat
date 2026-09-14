// Every binding's labelKey must resolve in `en`. ko/zh are best-effort by
// policy: i18n.svelte.ts:13-20 says English is the source of truth and there is
// "deliberately no CI gate requiring cross-locale key parity", so a gap there is
// reported, never failed. Overruling that policy inside a keyboard PR would be
// smuggling in a contributor-workflow change.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/legacy/bridge", () => ({ CUR_REPO: "/repo", G: { N: 0 } }));

import { BINDINGS } from "./bindings.ts";

function keysFor(locale: string): Set<string> {
  const out = new Set<string>();
  const dir = `src/i18n/locales/${locale}`;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts")) continue;
    const ns = f.slice(0, -3);
    for (const m of readFileSync(`${dir}/${f}`, "utf8").matchAll(/^ {2}"?([A-Za-z0-9_.-]+)"?:/gm)) {
      out.add(`${ns}.${m[1]}`);
    }
  }
  return out;
}

const en = keysFor("en");
const labelKeys = [...new Set(BINDINGS.map((b) => b.labelKey))];

describe("labelKey resolution", () => {
  it("found the en locale at all", () => {
    expect(en.size).toBeGreaterThan(100);
  });

  it.each(labelKeys.map((k) => [k]))("%s exists in en", (k) => {
    expect(en.has(k), `${k} is missing from src/i18n/locales/en/`).toBe(true);
  });

  it("reports ko/zh gaps without failing, per the stated no-parity policy", () => {
    const report: Record<string, string[]> = {};
    for (const loc of ["ko", "zh"]) {
      const have = keysFor(loc);
      report[loc] = labelKeys.filter((k) => !have.has(k));
      if (report[loc].length) {
        console.warn(`keymap i18n: ${loc} is missing ${report[loc].length} label(s): ${report[loc].join(", ")}`);
      }
    }
    // The assertion is only that the check RAN — a gap is information, not a
    // failure. If this ever becomes a hard gate, change the policy first.
    expect(Object.keys(report)).toEqual(["ko", "zh"]);
  });
});
