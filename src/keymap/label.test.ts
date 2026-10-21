// Shortcut labels are spelled per platform from the keymap's own specs. The bug
// this pins: Windows and Linux users were told to press ⌘Z / ⌘K / ⌘⇧H — keys
// their keyboards do not have — because copy spelled the glyph literally.
import { afterEach, describe, expect, it, vi } from "vitest";

// bindings.ts -> guards.ts -> legacy/bridge boots the canvas app on import.
vi.mock("@/legacy/bridge", () => ({ CUR_REPO: "/repo", G: { N: 0 } }));

import { formatSpec, modifierLabel, shortcutLabel, shortcutParams } from "./label.ts";
import { SHORTCUTS } from "./shortcuts.ts";
import { BINDINGS } from "./bindings.ts";
import { setLocale, t } from "@/i18n/i18n.svelte.ts";

function onPlatform(navPlatform: string, ua: string) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(navPlatform);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
}
const MAC = ["MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15"] as const;
const WIN = ["Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/120"] as const;
const LINUX = ["Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15"] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatSpec", () => {
  it("keeps glyphs on macOS", () => {
    expect(formatSpec("Mod+KeyZ", "macos")).toBe("⌘Z");
    expect(formatSpec("Mod+Shift+KeyH", "macos")).toBe("⌘⇧H");
    expect(formatSpec("Mod+Alt+KeyK", "macos")).toBe("⌘⌥K");
    expect(formatSpec("Mod+Backslash", "macos")).toBe("⌘\\");
  });

  it.each(["win", "linux"] as const)("spells modifiers out on %s", (p) => {
    expect(formatSpec("Mod+KeyZ", p)).toBe("Ctrl+Z");
    expect(formatSpec("Mod+Shift+KeyH", p)).toBe("Ctrl+Shift+H");
    expect(formatSpec("Mod+Alt+KeyK", p)).toBe("Ctrl+Alt+K");
    expect(formatSpec("Mod+Backslash", p)).toBe("Ctrl+\\");
    expect(formatSpec("Shift+Escape", p)).toBe("Shift+Escape");
  });

  it("modifier labels follow the same rule", () => {
    expect([modifierLabel("Mod", "macos"), modifierLabel("Shift", "macos"), modifierLabel("Alt", "macos")]).toEqual(["⌘", "⇧", "⌥"]);
    expect([modifierLabel("Mod", "win"), modifierLabel("Shift", "win"), modifierLabel("Alt", "win")]).toEqual(["Ctrl", "Shift", "Alt"]);
  });
});

describe("shortcutLabel", () => {
  it("detects the platform when none is passed", () => {
    onPlatform(...MAC);
    expect(shortcutLabel("undo")).toBe("⌘Z");
    onPlatform(...WIN);
    expect(shortcutLabel("undo")).toBe("Ctrl+Z");
    onPlatform(...LINUX);
    expect(shortcutLabel("palette")).toBe("Ctrl+K");
  });

  it("names a chord the dispatcher actually binds, so copy cannot drift from the table", () => {
    const bound = new Set(BINDINGS.flatMap((b) => b.chords));
    for (const [name, spec] of Object.entries(SHORTCUTS)) {
      expect(bound.has(spec), `SHORTCUTS.${name} (${spec}) is in no binding`).toBe(true);
    }
  });

  it("exposes a {<name>Key} placeholder for every shortcut, plus bare modifiers", () => {
    const p = shortcutParams("win");
    for (const name of Object.keys(SHORTCUTS)) expect(p[`${name}Key`]).toBeTruthy();
    expect(p.modKey).toBe("Ctrl");
    expect(p.shiftKey).toBe("Shift");
  });
});

describe("migrated i18n strings", () => {
  it("the Reset HEAD note names the platform's undo key", () => {
    onPlatform(...WIN);
    expect(t("resethead.note_snapshot")).toContain("Ctrl+Z/Undo");
    expect(t("resethead.note_snapshot")).not.toContain("⌘");
    onPlatform(...MAC);
    expect(t("resethead.note_snapshot")).toContain("⌘Z/Undo");
  });

  it("topbar tooltips are spelled per platform", () => {
    onPlatform(...LINUX);
    expect(t("topbar.goto_head")).toBe("Jump to the current commit (HEAD)  Ctrl+Shift+H");
    expect(t("topbar.fetch_tip")).toBe("Fetch — update remote-tracking refs (Ctrl+Shift+D)");
    expect(t("topbar.pull_tip")).toBe("Pull (fast-forward only) (Ctrl+Shift+L)");
    expect(t("topbar.push_tip")).toBe("Push (Ctrl+Shift+P)");
    expect(t("topbar.undo_tip")).toBe("Global Undo — Safety Manager (Ctrl+Z)");
    onPlatform(...MAC);
    expect(t("topbar.push_tip")).toBe("Push (⌘⇧P)");
  });

  it("fills placeholders in every locale, alongside caller params", () => {
    onPlatform(...WIN);
    try {
      for (const loc of ["en", "zh", "ko"] as const) {
        setLocale(loc);
        const s = t("detail.covered", { ago: "5m" });
        expect(s, loc).toContain("Ctrl+Z");
        expect(s, loc).toContain("5m");
        expect(s, loc).not.toMatch(/\{\w+Key\}/);
        expect(t("help.navigate_p"), loc).toContain("<kbd>Ctrl</kbd>+");
        expect(t("help.navigate_p"), loc).not.toMatch(/⌘|⇧/);
      }
    } finally {
      setLocale("en");
    }
  });
});
