// Built-in Tama characters (PER-53) — the registry, currently EMPTY.
//
// The mechanism ships; the content does not. GitCat used to bundle two hue-shift
// recolours of Tama (Momo/pink, Sora/blue), but a global recolour tints her skin
// too and reads as "off" rather than as a real alternate character, so they were
// removed (PER-53 follow-up). This registry stays as the extension point: a
// genuinely PAINTED alternate character (8 poses matching the keys below) can be
// dropped in here as a `BuiltinSkin` and it becomes a no-install option in the
// Settings → Tama → Skin picker. Until then, alternate characters come only from
// SKIN PLUGINS (a plugin.json with a `tama.poses` map — see the "Tama skins"
// section of docs/plugins.md), which let anyone bring their own art.
//
// A built-in (when present) is pure frontend: each pose is a real image asset
// `import`ed here (Vite turns a `.webp` import into a hashed asset-URL string),
// so `poses` is a plain poseKey -> URL map handed straight to bridge.applyTamaSkin
// — no backend round-trip, which is why a built-in also works in design mode
// (!IN_TAURI). `voicePitch` is a multiplier for legacy/sound.ts (a character can
// sound different, not just look different); `copy.greeting` is surfaced once on
// apply.

// The 8 painted poses every Tama look provides — the same keys as legacy/main.ts's
// TAMA_IMG. A skin maps each to an image URL; any pose it omits falls back to the
// built-in painted art (see tamaPose).
export type TamaPoseKey = "hero" | "curious" | "confident" | "thinking" | "happy" | "alarm" | "shocked" | "sleep";

export interface BuiltinSkin {
  // The "builtin:*" prefix keeps a built-in id distinct from any plugin id in the
  // shared tamaSkinPluginId persistence (a plugin id can never start with
  // "builtin:" — plugin ids match ^[a-z0-9][a-z0-9-]*$, no colon), so the picker
  // and the boot-apply path can tell the two sources apart from the id alone.
  id: `builtin:${string}`;
  name: string;
  poses: Record<TamaPoseKey, string>;
  // Multiplier fed to sound.ts's setVoicePitch (clamped there to [0.5, 2.0]).
  voicePitch: number;
  // Optional greeting line, surfaced once when the character is applied.
  copy?: Record<string, string>;
}

// No built-in characters ship today (see the module note). To add a painted one:
// import its 8 pose web/png assets and push a BuiltinSkin here.
export const BUILTIN_SKINS: BuiltinSkin[] = [];

// Fast lookup by id for the picker's setTamaSkin / the boot-apply path. A built-in
// id that isn't found returns undefined and the caller falls back to Default — the
// same silent fail-safe the plugin path uses for a removed plugin.
export function builtinSkinById(id: string | null | undefined): BuiltinSkin | undefined {
  if (!id) return undefined;
  return BUILTIN_SKINS.find((s) => s.id === id);
}

// Whether a persisted/selected id names a built-in character (vs a plugin id or
// Default). Cheap prefix check — see BuiltinSkin.id's own note on why the prefix
// is unambiguous.
export function isBuiltinSkinId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith("builtin:");
}
