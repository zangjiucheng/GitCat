# Language Pack

Adds keyword-aware diff syntax highlighting for **Python, Rust, Go, Java, C,
C++ and Shell**. GitCat's built-in highlighter only really understands
JS/TS — every other file falls back to a "generic" grammar with comments,
strings and numbers but **no keywords at all**. This plugin has no `run`
commands and does nothing when invoked; it exists purely to declare
`languages`.

## What it shows

- The **`languages`** manifest field — a purely DECLARATIVE syntax grammar,
  not code. Each entry is:

  ```jsonc
  {
    "id": "python",                 // becomes the highlighter's grammar id
    "extensions": ["py", "pyw"],    // no leading dot, matched case-insensitively
    "keywords": ["def", "class", "return", /* … */],
    "lineComment": "#",             // optional
    "blockComment": { "start": "/*", "end": "*/" } // optional
  }
  ```

  String/number/punctuation highlighting is NOT configurable here — every
  language reuses GitCat's own built-in rules for those; a plugin only ever
  supplies the parts that are actually language-specific: keywords and
  comment syntax.

- **Once installed and enabled**, opening a diff on a `.py`/`.rs`/`.go`/
  `.java`/`.c`/`.h`/`.cpp`/`.sh` file (in the commit detail view, the
  two-commit compare, blame, or the 3-way conflict resolver — everywhere
  GitCat highlights a diff) picks up keyword highlighting for that language
  automatically. No restart needed beyond re-selecting the file.

- **Extension collisions**: if more than one enabled plugin declares the same
  file extension, the plugin that was installed/enabled MOST RECENTLY wins
  for that extension — see [`docs/plugins.md`](../../docs/plugins.md#languages).

## Install

Settings → **Plugins** → **Install plugin…** and pick this folder's
`plugin.json` (or the folder itself). Open any commit that touches one of the
covered file types and its diff now shows keyword highlighting.

## Extending it

Copy this manifest and add your own language, or add extensions/keywords to
an existing entry — it's just JSON, no code involved. See
[`docs/plugins.md`](../../docs/plugins.md#languages) for the full field
reference.
