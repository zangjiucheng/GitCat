// Pure, DOM-free logic for merging plugin-contributed syntax grammars into
// legacy/main.ts's GRAMMARS/highlight machinery — split out from main.ts
// specifically so it has a real test file: main.ts itself boots a whole
// vanilla canvas app on import and has no unit test of its own (same
// "extract the leaf so it's testable" reasoning sound.ts's own header gives
// for why main.ts imports FROM it and never the reverse).
//
// A language grammar is DATA, never code — see PluginLanguage's own doc
// comment (src-tauri/src/plugin_registry.rs): a keyword list plus simple
// comment syntax, nothing that could inject a custom tokenizer or run
// against a diff's text.

/** One GRAMMARS entry: an ordered [token type, sticky RegExp] rule list. */
export type GrammarRule = readonly [string, RegExp];
export type Grammars = Record<string, GrammarRule[]>;

/** The subset of the Rust-side `PluginLanguage` shape this module reads. */
export interface PluginLanguageLike {
  id: string;
  extensions?: readonly string[] | null;
  keywords?: readonly string[] | null;
  lineComment?: string | null;
  blockComment?: { start: string; end: string } | null;
}

/** Escapes a literal string for safe interpolation into a RegExp source. */
export function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a GRAMMARS-shaped rule array for one plugin-declared language:
 * comments (if declared) then keywords (if any), reusing the SAME str/num/
 * punc rules `genericRules` (GRAMMARS.generic) already has. Those three are
 * intentionally not plugin-configurable — see PluginLanguage's own doc
 * comment for why: they are not actually language-specific in this
 * tokenizer's scope, so letting every plugin redeclare slightly different
 * versions would just be a source of drift for nothing gained.
 */
export function pluginRules(lang: PluginLanguageLike, genericRules: GrammarRule[]): GrammarRule[] {
  const rules: GrammarRule[] = [];
  const comParts: string[] = [];
  if (lang.lineComment) comParts.push(`${escRe(lang.lineComment)}[^\\n]*`);
  if (lang.blockComment) comParts.push(`${escRe(lang.blockComment.start)}[\\s\\S]*?${escRe(lang.blockComment.end)}`);
  if (comParts.length) rules.push(["com", new RegExp(comParts.join("|"), "y")]);
  const byType = (t: string): GrammarRule => genericRules.find(([type]) => type === t) as GrammarRule;
  rules.push(byType("str"));
  if (lang.keywords && lang.keywords.length) {
    rules.push(["key", new RegExp(`\\b(?:${lang.keywords.map(escRe).join("|")})\\b`, "y")]);
  }
  rules.push(byType("num"));
  rules.push(byType("punc"));
  return rules;
}

/**
 * (Re)builds `grammars` in place from the CURRENT list of enabled plugins'
 * declared `languages`, and returns the new extension -> grammar-id map.
 * Always a full rebuild, never an incremental patch: a plugin that just got
 * disabled/removed must stop being reachable, which an additive-only merge
 * could never express — so this first strips every key `grammars` holds
 * that is not in `builtinGrammarKeys`, then re-adds exactly what
 * `languages` says should exist now.
 *
 * Collision rule: the LAST entry in `languages` wins a given language id or
 * extension. Callers build `languages` by flattening enabled plugins in
 * registry order, so in practice this means "the plugin installed/enabled
 * most recently, among those claiming the same id/extension, wins" — a
 * simple, deterministic tie-break, not something install-time validation of
 * ONE manifest could even detect (a plugin cannot know what else is
 * installed).
 */
export function registerPluginLanguages(
  grammars: Grammars,
  builtinGrammarKeys: ReadonlySet<string>,
  builtinExtToLang: Readonly<Record<string, string>>,
  languages: readonly PluginLanguageLike[] | null | undefined,
): Record<string, string> {
  for (const key of Object.keys(grammars)) if (!builtinGrammarKeys.has(key)) delete grammars[key];
  const genericRules = grammars.generic;
  const next: Record<string, string> = { ...builtinExtToLang };
  for (const lang of languages || []) {
    if (!lang || !lang.id) continue;
    grammars[lang.id] = pluginRules(lang, genericRules);
    for (const ext of lang.extensions || []) next[String(ext).toLowerCase()] = lang.id;
  }
  return next;
}

/**
 * The highlighter's language for `path`'s own extension, looked up in
 * `extToLang` (built-ins merged with whatever registerPluginLanguages last
 * registered). Deliberately never consults the backend's own
 * `FileChange.lang` ("extension hint for the JS highlighter", per
 * guess_lang's own Rust doc comment): that hint predates plugin languages
 * and only ever distinguishes ts-family from everything else, so trusting
 * it would mean a plugin-covered file (say a `.py`) could never reach its
 * own grammar at all.
 */
export function resolveLangFromMap(path: string | null | undefined, extToLang: Readonly<Record<string, string>>): string {
  const m = /\.([^./\\]+)$/.exec(path || "");
  const ext = m ? m[1].toLowerCase() : "";
  return extToLang[ext] || "generic";
}
