import { describe, expect, it } from "vitest";
import { escRe, pluginRules, registerPluginLanguages, resolveLangFromMap, type GrammarRule, type Grammars } from "./pluginGrammars.ts";

// The built-in `generic` grammar, exactly as legacy/main.ts's own GRAMMARS.generic
// defines it — duplicated here (not imported: main.ts can't be imported in a test,
// see this module's own header) so pluginRules' "reuse generic's str/num/punc"
// claim is tested against the REAL shape, not a stand-in that could drift.
const GENERIC: GrammarRule[] = [
  ["com", /#[^\n]*|\/\/[^\n]*/y],
  ["str", /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/y],
  ["num", /\b\d+(?:\.\d+)?\b/y],
  ["punc", /[{}()[\];,.:=<>+\-*/%]+/y],
];

/** Mirrors legacy/main.ts's own highlight() tokenizing loop, minus the HTML
 * escaping/wrapping — returns [type, matchedText] pairs (type "" for an
 * unmatched single character) so a test can assert on structure directly. */
function tokenize(src: string, rules: GrammarRule[]): [string, string][] {
  const out: [string, string][] = [];
  let i = 0;
  outer: while (i < src.length) {
    for (const [type, re] of rules) {
      re.lastIndex = i;
      const m = re.exec(src);
      if (m && m.index === i) {
        out.push([type, m[0]]);
        i += m[0].length || 1;
        continue outer;
      }
    }
    out.push(["", src[i]]);
    i++;
  }
  return out;
}

describe("escRe", () => {
  it("escapes every regex metacharacter", () => {
    expect(escRe("a.b*c?d")).toBe("a\\.b\\*c\\?d");
    expect(escRe("(x|y)[z]")).toBe("\\(x\\|y\\)\\[z\\]");
    expect(escRe("$100^2")).toBe("\\$100\\^2");
    expect(escRe("//")).toBe("//"); // no regex-special chars, unchanged
  });
});

describe("pluginRules", () => {
  it("reuses generic's own str/num/punc rule objects verbatim", () => {
    const rules = pluginRules({ id: "bare", extensions: ["xyz"] }, GENERIC);
    const byType = (t: string) => rules.find(([type]) => type === t);
    expect(byType("str")).toBe(GENERIC.find(([t]) => t === "str")); // same object, not a copy
    expect(byType("num")).toBe(GENERIC.find(([t]) => t === "num"));
    expect(byType("punc")).toBe(GENERIC.find(([t]) => t === "punc"));
  });

  it("omits the com/key rules entirely when neither is declared", () => {
    const rules = pluginRules({ id: "bare", extensions: ["xyz"] }, GENERIC);
    expect(rules.map(([t]) => t)).toEqual(["str", "num", "punc"]);
  });

  it("tokenizes keywords, a line comment, strings, numbers and punctuation", () => {
    const rules = pluginRules(
      { id: "python", extensions: ["py"], keywords: ["def", "return"], lineComment: "#" },
      GENERIC,
    );
    const tokens = tokenize('def add(a, b): # sums two\n    return a+1', rules);
    expect(tokens).toContainEqual(["key", "def"]);
    expect(tokens).toContainEqual(["key", "return"]);
    expect(tokens).toContainEqual(["com", "# sums two"]);
    expect(tokens).toContainEqual(["num", "1"]);
    // "add"/"a"/"b" are plain identifiers, never highlighted as keywords —
    // proves the keyword regex is anchored to \b(?:...)\b, not a substring test.
    expect(tokens.some(([t, v]) => t === "key" && v === "add")).toBe(false);
  });

  it("does not partially match a keyword inside a longer identifier", () => {
    // "definitely" contains "def" but must not be split into key+plain.
    const rules = pluginRules({ id: "python", extensions: ["py"], keywords: ["def"] }, GENERIC);
    const tokens = tokenize("definitely", rules);
    expect(tokens.some(([t]) => t === "key")).toBe(false);
  });

  it("tokenizes a block comment, non-greedily up to its first end delimiter", () => {
    const rules = pluginRules(
      { id: "c", extensions: ["c"], blockComment: { start: "/*", end: "*/" } },
      GENERIC,
    );
    const tokens = tokenize("/* one */ x /* two */", rules);
    const comments = tokens.filter(([t]) => t === "com").map(([, v]) => v);
    expect(comments).toEqual(["/* one */", "/* two */"]);
  });

  it("recognizes BOTH line and block comments when a language declares both", () => {
    const rules = pluginRules(
      { id: "rust", extensions: ["rs"], lineComment: "//", blockComment: { start: "/*", end: "*/" } },
      GENERIC,
    );
    const tokens = tokenize("// line\n/* block */", rules);
    const comments = tokens.filter(([t]) => t === "com").map(([, v]) => v);
    expect(comments).toEqual(["// line", "/* block */"]);
  });

  it("escapes a comment/keyword delimiter that is itself a regex metacharacter", () => {
    // A pathological but legal manifest: a keyword containing a regex-special
    // character must be matched LITERALLY, not interpreted as a pattern.
    const rules = pluginRules({ id: "weird", extensions: ["w"], keywords: ["a.b", "c+d"] }, GENERIC);
    const tokens = tokenize("a.b x c+d y a_b", rules);
    expect(tokens).toContainEqual(["key", "a.b"]);
    expect(tokens).toContainEqual(["key", "c+d"]);
    // "a_b" must NOT match the "a.b" keyword pattern (which would happen if
    // '.' were left as an unescaped regex wildcard).
    expect(tokens.some(([t, v]) => t === "key" && v === "a_b")).toBe(false);
  });
});

describe("registerPluginLanguages", () => {
  const builtinKeys = new Set(["ts", "generic"]);
  const builtinExt = { ts: "ts", tsx: "ts", js: "ts", jsx: "ts", mjs: "ts", cjs: "ts" };
  const freshGrammars = (): Grammars => ({ ts: [], generic: GENERIC });

  it("adds a grammar entry per language and merges its extensions", () => {
    const grammars = freshGrammars();
    const extToLang = registerPluginLanguages(grammars, builtinKeys, builtinExt, [
      { id: "python", extensions: ["py", "pyw"], keywords: ["def"] },
    ]);
    expect(grammars.python).toBeDefined();
    expect(extToLang.py).toBe("python");
    expect(extToLang.pyw).toBe("python");
    // Built-ins survive untouched.
    expect(extToLang.ts).toBe("ts");
  });

  it("a rebuild with fewer languages removes the grammar/extensions a PRIOR call added", () => {
    const grammars = freshGrammars();
    registerPluginLanguages(grammars, builtinKeys, builtinExt, [
      { id: "python", extensions: ["py"] },
      { id: "rust", extensions: ["rs"] },
    ]);
    expect(grammars.python).toBeDefined();
    expect(grammars.rust).toBeDefined();

    // Simulates the "rust" plugin being disabled/removed: only python remains.
    const extToLang = registerPluginLanguages(grammars, builtinKeys, builtinExt, [{ id: "python", extensions: ["py"] }]);
    expect(grammars.python).toBeDefined();
    expect(grammars.rust).toBeUndefined();
    expect(extToLang.rs).toBeUndefined();
  });

  it("never removes a built-in grammar key, even across rebuilds with zero plugin languages", () => {
    const grammars = freshGrammars();
    registerPluginLanguages(grammars, builtinKeys, builtinExt, [{ id: "python", extensions: ["py"] }]);
    registerPluginLanguages(grammars, builtinKeys, builtinExt, []);
    expect(Object.keys(grammars).sort()).toEqual(["generic", "ts"]);
  });

  it("the LAST language in the list wins a duplicate id or extension", () => {
    const grammars = freshGrammars();
    const extToLang = registerPluginLanguages(grammars, builtinKeys, builtinExt, [
      { id: "python", extensions: ["py"], keywords: ["first"] },
      { id: "python", extensions: ["py"], keywords: ["second"] },
    ]);
    expect(extToLang.py).toBe("python");
    // The SECOND declaration's grammar is what's actually installed.
    const keyRule = grammars.python.find(([t]) => t === "key");
    expect(keyRule?.[1].source).toContain("second");
    expect(keyRule?.[1].source).not.toContain("first");
  });

  it("two DIFFERENT ids claiming the same extension: the later one wins the extension map", () => {
    const grammars = freshGrammars();
    const extToLang = registerPluginLanguages(grammars, builtinKeys, builtinExt, [
      { id: "lang-a", extensions: ["x"] },
      { id: "lang-b", extensions: ["x"] },
    ]);
    expect(extToLang.x).toBe("lang-b");
    // Both grammars still exist — only the extension MAP entry was contested.
    expect(grammars["lang-a"]).toBeDefined();
    expect(grammars["lang-b"]).toBeDefined();
  });

  it("extensions are matched case-insensitively via lowercasing at registration", () => {
    const grammars = freshGrammars();
    const extToLang = registerPluginLanguages(grammars, builtinKeys, builtinExt, [
      { id: "python", extensions: ["PY"] },
    ]);
    expect(extToLang.py).toBe("python");
  });

  it("tolerates a null/empty languages list and a malformed entry without throwing", () => {
    const grammars = freshGrammars();
    expect(() => registerPluginLanguages(grammars, builtinKeys, builtinExt, null)).not.toThrow();
    expect(() => registerPluginLanguages(grammars, builtinKeys, builtinExt, [null as any, { id: "" } as any])).not.toThrow();
  });
});

describe("resolveLangFromMap", () => {
  const extToLang = { ts: "ts", js: "ts", py: "python" };

  it("resolves a known extension", () => {
    expect(resolveLangFromMap("src/app.ts", extToLang)).toBe("ts");
    expect(resolveLangFromMap("scripts/build.py", extToLang)).toBe("python");
  });

  it("falls back to generic for an unknown extension, no extension, or an empty/nullish path", () => {
    expect(resolveLangFromMap("README.md", extToLang)).toBe("generic");
    expect(resolveLangFromMap("Makefile", extToLang)).toBe("generic");
    expect(resolveLangFromMap("", extToLang)).toBe("generic");
    expect(resolveLangFromMap(null, extToLang)).toBe("generic");
    expect(resolveLangFromMap(undefined, extToLang)).toBe("generic");
  });

  it("is case-insensitive on the extension", () => {
    expect(resolveLangFromMap("src/App.TS", extToLang)).toBe("ts");
  });

  it("uses the FINAL extension of a multi-dot filename", () => {
    expect(resolveLangFromMap("archive.tar.gz", { gz: "gzip" })).toBe("gzip");
  });

  it("handles a Windows-style backslash path the same as a forward-slash one", () => {
    expect(resolveLangFromMap("src\\app.py", extToLang)).toBe("python");
  });
});
