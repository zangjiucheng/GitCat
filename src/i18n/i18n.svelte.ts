// Lightweight i18n for GitCat (Linear PER-76/PER-77). No framework: a reactive
// current-locale + a `t()` that reads it, so any Svelte 5 island template calling
// `t()` re-renders on a language switch automatically. A separate LOCALE_CHANGED
// event covers the consumers that are NOT Svelte-reactive: the vanilla
// `legacy/main.ts` canvas + DOM, and the Rust native-menu rebuild.
//
// Strings live in per-namespace files under `locales/<loc>/<namespace>.ts` (each
// a flat `Record<string,string>`), auto-loaded by glob below. The filename is the
// namespace, so a key is `"<namespace>.<key>"`. Glob loading is deliberate: a new
// namespace file needs NO central registry edit, which is what lets the
// string-extraction work fan out file-by-file with no merge conflicts.

export type Locale = "en" | "zh";

export const LOCALES: { id: Locale; label: string }[] = [
  { id: "en", label: "English" },
  { id: "zh", label: "中文" },
];

// Per-namespace dicts. `import.meta.glob` MUST be called DIRECTLY — Vite only
// static-replaces the literal `import.meta.glob(...)` call form; aliasing it to a
// variable leaves it undefined at runtime (throws on load / under vitest). Typed
// by vite/client (src/vite-env.d.ts).
type GlobMod = { default?: Record<string, string> };
const enModules = import.meta.glob("./locales/en/*.ts", { eager: true }) as Record<string, GlobMod>;
const zhModules = import.meta.glob("./locales/zh/*.ts", { eager: true }) as Record<string, GlobMod>;

function build(mods: Record<string, GlobMod>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, mod] of Object.entries(mods)) {
    const m = /([^/]+)\.ts$/.exec(path);
    const ns = m ? m[1] : path;
    for (const [k, v] of Object.entries(mod.default ?? {})) out[`${ns}.${k}`] = v;
  }
  return out;
}

const DICTS: Record<Locale, Record<string, string>> = { en: build(enModules), zh: build(zhModules) };

const STORAGE_KEY = "gitcat.locale";
function readStored(): Locale {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "en" || v === "zh") return v;
  } catch {
    // storage disabled (private mode) — fall through to default
  }
  return "en";
}

// The reactive current locale. Module-level `$state` (Svelte 5) so a template
// that reads it — via `t()` or `locale()` — re-renders when it changes.
let current = $state<Locale>(readStored());

/** The active locale. Reactive: reading this in a template tracks it. */
export function locale(): Locale {
  return current;
}

// Non-reactive consumers subscribe here (legacy canvas redraw, native-menu
// rebuild) since a `$state` read can't reach them.
export const i18nEvents = new EventTarget();

/** Switch language: update the reactive locale, persist, and notify subscribers. */
export function setLocale(loc: Locale): void {
  if (loc === current) return;
  current = loc;
  try {
    localStorage.setItem(STORAGE_KEY, loc);
  } catch {
    // ignore — see readStored()
  }
  i18nEvents.dispatchEvent(new CustomEvent("change", { detail: loc }));
}

/**
 * Translate `"namespace.key"`, interpolating `{name}` placeholders from `params`.
 * Reads the reactive locale (so a template call re-renders on switch). Falls back
 * to the English string, then the key itself, so a missing translation never
 * blanks the UI.
 */
export function t(key: string, params?: Record<string, string | number | null | undefined>): string {
  let s = DICTS[current][key] ?? DICTS.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(v == null ? "" : String(v));
    }
  }
  return s;
}
