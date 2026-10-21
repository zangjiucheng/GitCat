// The ONE place a shortcut becomes display text outside the help overlay's own
// table walk. Everything funnels into chord.ts's formatChord, so a label in a
// tooltip, a danger dialog and the "?" overlay are spelled identically:
// "⌘⇧H" on macOS, "Ctrl+Shift+H" on Windows/Linux.
//
// Kept free of the registry singleton (and therefore of the dispatcher and
// legacy/main.ts): i18n imports this to fill `{undoKey}`-style placeholders.
import { formatChord, parseChord, type Platform } from "./chord.ts";
import { platform as detectPlatform } from "./platform.ts";
import { SHORTCUTS, type ShortcutName } from "./shortcuts.ts";

/** Format a raw chord spec ("Mod+Shift+KeyH") for display. */
export function formatSpec(spec: string, p: Platform = detectPlatform()): string {
  return formatChord(parseChord(spec), p);
}

/** Display label for a named shortcut from SHORTCUTS. */
export function shortcutLabel(name: ShortcutName, p: Platform = detectPlatform()): string {
  return formatSpec(SHORTCUTS[name], p);
}

/** A bare modifier, for copy like "{modKey}+scroll" or "hold {shiftKey}". */
export function modifierLabel(m: "Mod" | "Shift" | "Alt", p: Platform = detectPlatform()): string {
  const mac = p === "macos";
  if (m === "Mod") return mac ? "⌘" : "Ctrl";
  if (m === "Shift") return mac ? "⇧" : "Shift";
  return mac ? "⌥" : "Alt";
}

/**
 * Every placeholder an i18n string may use for a key: `{<name>Key}` for each
 * SHORTCUTS entry (`{undoKey}`, `{paletteKey}`, …) plus `{modKey}`,
 * `{shiftKey}` and `{altKey}` for a bare modifier.
 */
export function shortcutParams(p: Platform = detectPlatform()): Record<string, string> {
  const out: Record<string, string> = {
    modKey: modifierLabel("Mod", p),
    shiftKey: modifierLabel("Shift", p),
    altKey: modifierLabel("Alt", p),
  };
  for (const name of Object.keys(SHORTCUTS) as ShortcutName[]) out[`${name}Key`] = shortcutLabel(name, p);
  return out;
}
