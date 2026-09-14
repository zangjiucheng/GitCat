import { ACCELERATORS } from "./accelerators.ts";
import { keymap } from "./registry.ts";
import { focusPane } from "./panes.ts";
import { workdirKeys } from "./actions/workdir.ts";
import { canvasKeys } from "./actions/canvas.ts";
import type { Binding } from "./types.ts";

// THE TABLE. PR 1 ships it ENTIRELY in mode:"shadow": the dispatcher matches,
// counts (dump().shadow[id]) and does nothing. No claim, no run, no
// preventDefault — so every existing listener stays authoritative and this file
// cannot change behaviour. Flipping one binding live is a 3-line diff:
//   1. drop `mode`/`owns`, fill in `run`
//   2. delete the old listener AND its `// @keymap-owns <id>` marker comment
//   3. if the action lives in legacy/main.ts, export it + one line in bridge.ts
// `pnpm keymap:check` fails if you do 1 without 2, or 2 without 1.
//
// `run` is absent on every row on purpose. A shadow run() is unreachable, and
// three of the actions (globalUndo legacy/main.ts:2324, closeHelpPage :1945,
// disarmDanger :2521) are NOT in legacy/main.ts's export list at :3743-3753 nor
// in bridge.ts — adding those exports is part of the PR that makes them live.

export const BINDINGS: readonly Binding[] = [
  // ── palette ────────────────────────────────────────────────────────────
  {
    id: "palette.toggle",
    // NOTE both chords. Cmdk.svelte:24 is `(meta||ctrl) && !alt && key==="k"` —
    // shiftKey is NOT excluded, so ⌘⇧K toggles the palette TODAY. An exact
    // four-bit mask would silently drop it, so PR 1 registers both and the
    // narrowing (if wanted) becomes a visible decision in a later PR.
    chords: ["Mod+KeyK", "Mod+Shift+KeyK"],
    scope: "global",
    layer: "always",
    when: ["notInTerminal", "noScrimOpen"],
    dispatch: "js",
    // Cmdk.svelte's ⌘K branch has NO text-input guard — deliberately, because
    // ⌘K is how the auto-focused palette CLOSES. Without this the dispatcher's
    // default-deny would refuse inside the palette's own input, the shadow
    // counter would read 0 while the legacy handler still toggled, and the
    // equivalence measurement would be quietly wrong for the close path.
    // (The "/" row below keeps the guard, because "/" is a typed character.)
    allowInTextInput: true,
    toggle: true, // menu.rs:118 deliberately gives the "cmdk" item NO accelerator
    labelKey: "vimnav.palette",
    help: { section: "search", order: 5 },
    mode: "shadow",
    owns: "Cmdk.svelte:24 onWindowKeydown (wired at :96)",
  },
  {
    id: "palette.slash",
    chords: ["/"],
    scope: "global",
    layer: "always",
    when: ["notTextInputOrSelect", "noScrimOpen"],
    dispatch: "js",
    toggle: true,
    labelKey: "vimnav.palette",
    help: { section: "search", order: 6, hidden: true },
    mode: "shadow",
    owns: "Cmdk.svelte:37 onWindowKeydown",
    // parseChord gives bare punctuation shiftOptional:true, which is
    // LOAD-BEARING and not overridable: Cmdk.svelte:41-43 states "/" is
    // Shift-typed on AZERTY and QWERTZ. It also gives altGrTolerant:true, which
    // is a real (intended) WIDENING vs Cmdk.svelte:44's `ctrlKey||altKey`
    // rejection — flagged in the PR description, inert while shadow.
  },

  // ── search ─────────────────────────────────────────────────────────────
  {
    id: "search.code",
    chords: [ACCELERATORS["code-search"]],
    scope: "global",
    when: ["repoOpen", "notTextInputOrSelect", "noScrimOpen"],
    dispatch: "both", // menu.rs:150; codeSearchCtrl.show() is idempotent, not a toggle
    menu: { id: "code-search" },
    labelKey: "vimnav.search_code",
    help: { section: "search", order: 10 },
    mode: "shadow",
    owns: "CodeSearch.svelte:17 onKeydown (wired at :34)",
  },

  {
    id: "search.pickaxe",
    chords: [ACCELERATORS["pickaxe-search"]],
    scope: "global",
    when: ["repoOpen", "notTextInput"],
    dispatch: "both", // menu.rs:160 + the new main.ts fallback added in commit E
    menu: { id: "pickaxe-search" },
    labelKey: "menu.pickaxe_search",
    help: { section: "search", order: 20 },
    mode: "shadow",
    owns: "src/main.ts pickaxe ⌘⇧F fallback listener",
  },

  // ── app chrome ─────────────────────────────────────────────────────────
  {
    id: "app.settings",
    chords: [ACCELERATORS.settings],
    scope: "global",
    when: ["notTextInput"],
    dispatch: "both", // menu.rs:238; muda's Win32 "," is unreliable (main.ts:537-541)
    menu: { id: "settings" },
    labelKey: "menu.settings",
    help: { section: "actions", order: 20 },
    mode: "shadow",
    owns: "src/main.ts:545",
  },
  {
    id: "repo.open",
    chords: [ACCELERATORS["open-repo"]],
    scope: "global",
    when: ["notTextInput"],
    dispatch: "both", // menu.rs:66; WebView2 swallows Ctrl+O (main.ts:558-563)
    menu: { id: "open-repo" },
    labelKey: "menu.open_repo",
    help: { section: "actions", order: 30 },
    mode: "shadow",
    owns: "src/main.ts:565",
    // The `|| e.key === "O"` arm at main.ts:569 is effectively dead — !shiftKey
    // is already required, so "O" only arrives under CapsLock. Mod+KeyO
    // collapses both arms correctly; this is the one place the e.code rule is a
    // strict improvement with no downside.
  },
  {
    id: "view.focusMode",
    chords: ["Mod+Backslash", "Mod+Shift+Backslash"],
    scope: "global",
    when: ["notTextInput"],
    dispatch: "js",
    toggle: true, // no accelerator in menu.rs, correctly
    labelKey: "vimnav.focus_mode",
    help: { section: "view", order: 30 },
    mode: "shadow",
    owns: "legacy/main.ts:2169",
    // Two chords because legacy/main.ts:2170 is `!e.altKey` only — Shift is a
    // don't-care today, so ⌘⇧\\ also toggles. Same treatment as ⌘⇧K.
  },

  // ── navigation ─────────────────────────────────────────────────────────
  { id: "nav.uncommitted", chords: ["Mod+Shift+KeyU"], scope: "global",
    when: ["notTextInput"], dispatch: "js", labelKey: "vimnav.jump_uncommitted",
    help: { section: "view", order: 10 }, mode: "shadow", owns: "legacy/main.ts:2190" },
  // NOTE: no `menu` field. The "uncommitted-changes" item exists in menu.rs but
  // deliberately carries NO accelerator; declaring it here would make codegen
  // add one, and on macOS the native key equivalent is consumed before the
  // webview keydown — a silent, platform-divergent behaviour change inside the
  // PR whose whole property is inertness.

  { id: "nav.head", chords: ["Mod+Shift+KeyH"], scope: "global",
    when: ["notTextInput"], dispatch: "js", labelKey: "vimnav.jump_head",
    help: { section: "view", order: 20 }, mode: "shadow", owns: "legacy/main.ts:2197" },

  // ── remote sync. One listener (legacy/main.ts:2206) splits into three rows —
  //    the shape the table exists for. Today a ⌘⇧<anything else> falls out of
  //    that handler WITHOUT preventDefault; three separate bindings reproduce
  //    that exactly. menu.rs:91-93 gives Fetch/Pull/Push no accelerators on
  //    purpose, so all three stay dispatch:"js" and codegen must not emit them.
  { id: "remote.fetch", chords: ["Mod+Shift+KeyD"], scope: "global",
    when: ["notTextInput"], dispatch: "js", labelKey: "vimnav.fetch",
    help: { section: "sync", order: 10 }, mode: "shadow", owns: "legacy/main.ts:2206" },
  { id: "remote.pull", chords: ["Mod+Shift+KeyL"], scope: "global",
    when: ["notTextInput"], dispatch: "js", labelKey: "vimnav.pull",
    help: { section: "sync", order: 20 }, mode: "shadow", owns: "legacy/main.ts:2206" },
  { id: "remote.push", chords: ["Mod+Shift+KeyP"], scope: "global",
    when: ["notTextInput"], dispatch: "js", destructive: true, labelKey: "vimnav.push",
    help: { section: "sync", order: 30 }, mode: "shadow", owns: "legacy/main.ts:2206" },

  // ── undo ───────────────────────────────────────────────────────────────
  // legacy/main.ts:2398-2412 is PR 0's rewrite and is already the exact-mask /
  // e.code model, so it is the reference implementation this table copies.
  { id: "edit.undo", chords: ["Mod+KeyZ"], scope: "global",
    when: ["notTextInput"], dispatch: "js", destructive: true, labelKey: "vimnav.undo",
    help: { section: "actions", order: 10 }, mode: "shadow", owns: "legacy/main.ts:2406" },
  { id: "edit.redoUnsupported", chords: ["Mod+Shift+KeyZ"], scope: "global",
    when: ["notTextInput"], dispatch: "js", labelKey: "legacy.redo_unsupported",
    help: { section: "actions", order: 11, hidden: true },
    mode: "shadow", owns: "legacy/main.ts:2406" },
  // Claimed rather than left unbound — legacy/main.ts:2403-2405: "an unclaimed
  // chord is how the loose match crept back in". A tombstone, hence hidden.

  // ── scopes ─────────────────────────────────────────────────────────────
  // The first LIVE binding in the stack. Escape takes a dedicated path in
  // dispatch.ts: top scope only, then stop — which is the whole fix for one
  // Escape dismissing two layers (#129). Every island that pushes "modal"
  // inherits it, so this single row replaces a `<svelte:window>` handler per
  // island as each one migrates.
  {
    id: "modal.close",
    chords: ["Escape"],
    scope: "modal",
    dispatch: "js",
    labelKey: "vimnav.esc",
    help: { section: "actions", order: 90 },
    // Returning false when no activation offers an onEscape declines the key
    // rather than swallowing it, so Escape keeps falling outward.
    run: () => (keymap.closeTopScope() ? undefined : false),
  },

  // ── pane focus ─────────────────────────────────────────────────────────
  // ⌘1..3, not ⌘1..4. There is no workdir pane: main.ts refuses to mount
  // Workdir a second time because it renders INSIDE #detail, swapped in by
  // DetailPanel when the working tree is selected. "workdir" is a state of the
  // detail pane, not a region of its own.
  //
  // Live, and plain .focus() calls rather than scope overrides — DOM focus and
  // keyboard scope then cannot disagree, because the scope is read back out of
  // the focus these set (panes.ts).
  {
    id: "pane.graph",
    chords: ["Mod+Digit1"],
    scope: "global",
    // Works from inside a text field, and has to: focusPane lands on the pane's
    // first real control, which for the sidebar is the ref filter INPUT. With
    // the usual text guard, focus that entered a field could never leave by
    // keyboard — the chord that exists to move between panes would be the one
    // thing a field swallows.
    allowInTextInput: true,
    dispatch: "js",
    labelKey: "vimnav.pane_graph",
    help: { section: "view", order: 1 },
    run: () => (focusPane("graph") ? undefined : false),
  },
  {
    id: "pane.sidebar",
    chords: ["Mod+Digit2"],
    scope: "global",
    // Works from inside a text field, and has to: focusPane lands on the pane's
    // first real control, which for the sidebar is the ref filter INPUT. With
    // the usual text guard, focus that entered a field could never leave by
    // keyboard — the chord that exists to move between panes would be the one
    // thing a field swallows.
    allowInTextInput: true,
    dispatch: "js",
    labelKey: "vimnav.pane_sidebar",
    help: { section: "view", order: 2 },
    run: () => (focusPane("sidebar") ? undefined : false),
  },
  {
    id: "pane.detail",
    chords: ["Mod+Digit3"],
    scope: "global",
    // Works from inside a text field, and has to: focusPane lands on the pane's
    // first real control, which for the sidebar is the ref filter INPUT. With
    // the usual text guard, focus that entered a field could never leave by
    // keyboard — the chord that exists to move between panes would be the one
    // thing a field swallows.
    allowInTextInput: true,
    dispatch: "js",
    labelKey: "vimnav.pane_detail",
    help: { section: "view", order: 3 },
    run: () => (focusPane("detail") ? undefined : false),
  },

  // ── working tree ───────────────────────────────────────────────────────
  // The surface with the worst coverage in the audit: there was NO commit chord
  // anywhere in src/ before this, so committing meant Tab-walking to the button.
  //
  // Every row binding acts on the FOCUSED row, read from the DOM
  // (data-wd-path), not from selectedDiffFile — selecting a row to view its
  // diff and moving a cursor over rows are different gestures, and conflating
  // them would make `d` discard whatever was last previewed.
  {
    id: "workdir.commit",
    chords: ["Mod+Enter"],
    scope: "workdir",
    when: ["repoOpen"],
    // The ONLY binding in the table allowed inside a text input, and it has to
    // be: the whole point is committing without leaving the message box.
    allowInTextInput: true,
    dispatch: "js",
    labelKey: "vimnav.commit",
    help: { section: "actions", order: 5 },
    run: () => workdirKeys.commit(false),
  },
  {
    id: "workdir.amend",
    chords: ["Mod+Shift+Enter"],
    scope: "workdir",
    when: ["repoOpen"],
    allowInTextInput: true,
    dispatch: "js",
    // NOT destructive, and compile() is what forced the question: it refuses
    // destructive + allowInTextInput outright. `destructive` in this table
    // means "irreversible without the Safety Manager" — reset --hard, discard,
    // force push. An amend fires commit.created, which seals a snapshot, so ⌘Z
    // rewinds it like any other commit. Marking it destructive would also be
    // self-defeating: the rule exists to keep a BARE LETTER away from an
    // irreversible op in a text field, and this is ⌘⇧Enter in the very box it
    // amends from.
    labelKey: "vimnav.amend",
    help: { section: "actions", order: 6 },
    run: () => workdirKeys.commit(true),
  },
  {
    id: "workdir.stage",
    chords: ["s"],
    scope: "workdir",
    when: ["repoOpen"],
    dispatch: "js",
    labelKey: "vimnav.stage",
    help: { section: "actions", order: 7 },
    run: () => workdirKeys.stage(),
  },
  {
    id: "workdir.unstage",
    chords: ["u"],
    scope: "workdir",
    when: ["repoOpen"],
    dispatch: "js",
    labelKey: "vimnav.unstage",
    help: { section: "actions", order: 8 },
    run: () => workdirKeys.unstage(),
  },
  {
    id: "workdir.stageAll",
    chords: ["S"],
    scope: "workdir",
    when: ["repoOpen"],
    dispatch: "js",
    labelKey: "vimnav.stage_all",
    help: { section: "actions", order: 9 },
    run: () => workdirKeys.stageAll(),
  },
  {
    id: "workdir.unstageAll",
    chords: ["U"],
    scope: "workdir",
    when: ["repoOpen"],
    dispatch: "js",
    labelKey: "vimnav.unstage_all",
    help: { section: "actions", order: 10 },
    run: () => workdirKeys.unstageAll(),
  },
  {
    id: "workdir.discard",
    chords: ["d"],
    scope: "workdir",
    when: ["repoOpen"],
    dispatch: "js",
    destructive: true,
    labelKey: "vimnav.discard",
    help: { section: "actions", order: 11 },
    // Routed through the SAME confirmDiscard the context menu uses — a bare
    // letter never reaches an irreversible git operation directly. Note there
    // is deliberately no Shift+D for discard-all: rule 5 in #144 says Shift
    // must not escalate a destructive verb to its bulk form.
    run: () => workdirKeys.discard(),
  },

  // ── commit graph ───────────────────────────────────────────────────────
  // Ten commit operations hung off a right-click with NO keyboard opener: every
  // one of the app's 12 oncontextmenu handlers reads e.clientX/e.clientY, and a
  // synthesised event has none. `x` is #144's rule 3 — one key that opens the
  // actions menu for whatever the cursor is on, in every scope — which is what
  // keeps ~25 low-frequency operations off dedicated letters.
  {
    id: "canvas.menu",
    chords: ["x", "Shift+F10"],
    scope: "graph",
    // graphHasRows only, deliberately NOT repoOpen: the contextmenu listener
    // this mirrors opens the menu in design mode too (it passes CUR_REPO
    // through as-is), and a keyboard twin that refused where the mouse works
    // would be a worse kind of inconsistency than a menu over a demo graph.
    when: ["graphHasRows"],
    dispatch: "js",
    labelKey: "vimnav.row_menu",
    help: { section: "actions", order: 12 },
    run: () => canvasKeys.openMenu(),
  },
  // Arrow keys move the SELECTION. They moved state.scrollTarget before, while
  // j/k moved the selection — two contradictory meanings of "navigate" on one
  // surface, and the arrow one left the cursor behind wherever it started.
  {
    id: "canvas.down",
    chords: ["ArrowDown"],
    scope: "graph",
    when: ["graphHasRows"],
    dispatch: "js",
    labelKey: "vimnav.select_next",
    help: { section: "navigate", order: 10 },
    run: () => canvasKeys.move(1),
  },
  {
    id: "canvas.up",
    chords: ["ArrowUp"],
    scope: "graph",
    when: ["graphHasRows"],
    dispatch: "js",
    labelKey: "vimnav.select_prev",
    help: { section: "navigate", order: 11 },
    // Stepping up off row 0 lands on the pinned Uncommitted band — row -2,
    // which sits outside moveCanvasSelection's [0, N-1] clamp, so the row users
    // visit most could not be reached by keyboard at all.
    run: () => canvasKeys.move(-1),
  },
  {
    id: "canvas.first",
    chords: ["Home"],
    scope: "graph",
    when: ["graphHasRows"],
    dispatch: "js",
    labelKey: "vimnav.select_first",
    help: { section: "navigate", order: 12 },
    // Aliased to the same jump gg/G perform, so Home/End and gg/G stop meaning
    // different things (Home set scrollTarget and left the cursor behind).
    run: () => canvasKeys.jump("first"),
  },
  {
    id: "canvas.last",
    chords: ["End"],
    scope: "graph",
    when: ["graphHasRows"],
    dispatch: "js",
    labelKey: "vimnav.select_last",
    help: { section: "navigate", order: 13 },
    run: () => canvasKeys.jump("last"),
  },
  {
    id: "canvas.deselect",
    chords: ["Escape"],
    scope: "graph",
    // noScrimOpen is load-bearing, not defensive. The graph is the pane scope's
    // fallback, so it is active whenever focus is anywhere unremarkable — which
    // includes while the expanded-diff overlay is up. Without this guard the
    // FIRST Escape after closing a dialog would deselect and CLAIM the key,
    // suppressing the legacy handler that closes the overlay underneath.
    when: ["noScrimOpen"],
    dispatch: "js",
    labelKey: "vimnav.deselect",
    help: { section: "navigate", order: 14, hidden: true },
    // The graph scope sits at the bottom of the stack, so every open overlay
    // gets Escape first and this only runs when there is nothing else to close.
    run: () => canvasKeys.deselect(),
  },

  // ── accelerator-only. No JS side at all: `run` is absent and the dispatcher
  //    never reaches them (no listener exists to shadow). They are here so
  //    codegen emits their accelerator and the (chord, scope) uniqueness gate
  //    can see them — menu.rs:322's comment ("CmdOrCtrl+Shift+N is already
  //    File's New Branch, CmdOrCtrl+N is otherwise unused") becomes machine-
  //    checked instead of asserted in prose.
  { id: "branch.new", chords: [ACCELERATORS["new-branch"]], scope: "global",
    dispatch: "accelerator", menu: { id: "new-branch" }, labelKey: "menu.new_branch",
    help: { section: "actions", order: 40 } },
  { id: "window.new", chords: [ACCELERATORS["new-window"]], scope: "global",
    dispatch: "accelerator", menu: { id: "new-window" }, labelKey: "menu.new_window",
    help: { section: "actions", order: 50 } },
  { id: "terminal.toggle", chords: [ACCELERATORS["open-terminal"]], scope: "global",
    dispatch: "accelerator", toggle: true, menu: { id: "open-terminal" },
    labelKey: "menu.open_terminal", help: { section: "view", order: 40 } },
  // ^ THE live test case for the both+toggle throw: a genuine toggle
  //   (terminalCtrl.toggle) with an accelerator and no JS twin. "accelerator" +
  //   toggle is legal; "both" + toggle throws. Someone "fixing" dev-mode by
  //   adding a JS twin here would make the drawer cancel itself on
  //   Windows/Linux — now a compile error, then a boot throw.
];
