// The "?" overlay, generated from the table.
//
// It used to be hand-written, and it had already drifted: its "↑↓ PgUp PgDn
// Home End — scroll" line stopped being true the moment the arrow keys started
// moving the selection. A hand-written shortcut list is a second source of
// truth that nothing checks, which is the same failure mode that let ⌘⇧F mean
// two different things for months (#131).
//
// THE SCOPE-FIRST ORDERING IS THE POINT, not a nicety. Modifier chords are
// discoverable — they are in menus, and they are global. Bare letters are not:
// `s` means stage in the working tree, checkout is `c` in the sidebar, `x`
// opens a menu in three different places. A flat list of forty rows does not
// teach that. Press "?" with the working tree focused and the FIRST thing on
// screen is what those letters do HERE, which is the only thing that makes a
// scoped letter learnable rather than a hidden mode.

import { formatChord, parseChord, type Platform } from "./chord.ts";
import type { Binding, HelpSection } from "./types.ts";
import type { ScopeId } from "./scopes.ts";

export interface HelpRow {
  readonly chord: string;
  readonly labelKey: string;
  /** True for a row that belongs to the scope the user is in right now. */
  readonly inScope: boolean;
}

export interface HelpGroup {
  /** i18n key for the group heading, or a scope name for the leading group. */
  readonly titleKey: string;
  readonly rows: readonly HelpRow[];
}

const SECTION_TITLE: Record<HelpSection, string> = {
  search: "vimnav.sec_search",
  sync: "vimnav.sec_sync",
  view: "vimnav.sec_view",
  navigate: "vimnav.sec_navigate",
  actions: "vimnav.sec_actions",
};

const SCOPE_TITLE: Partial<Record<ScopeId, string>> = {
  graph: "vimnav.scope_graph",
  sidebar: "vimnav.scope_sidebar",
  detail: "vimnav.scope_detail",
  workdir: "vimnav.scope_workdir",
};

/**
 * Keys vimnav still owns directly. They are listed so the overlay stays
 * COMPLETE rather than only showing what has been migrated — an overlay that
 * silently omits j/k would be worse than the hand-written one it replaces.
 * Each moves into the table proper when vimnav migrates, and this list goes.
 */
const UNMIGRATED: readonly {
  chord: (p: Platform) => string;
  labelKey: string;
  section: HelpSection;
}[] = [
  { chord: () => "j / k", labelKey: "vimnav.down_up", section: "navigate" },
  { chord: () => "gg / G", labelKey: "vimnav.first_last", section: "navigate" },
  // Spelled per platform like every generated row. The hand-written overlay
  // hardcoded ⌘ here, so Windows and Linux users were shown a key their
  // keyboard does not have.
  { chord: (p) => (p === "macos" ? "⌘D / ⌘U" : "Ctrl+D / Ctrl+U"), labelKey: "vimnav.half_page", section: "navigate" },
  { chord: () => "Enter", labelKey: "vimnav.enter", section: "navigate" },
  { chord: (p) => (p === "macos" ? "⌘+scroll, + / -" : "Ctrl+scroll, + / -"), labelKey: "vimnav.zoom", section: "view" },
  { chord: () => "?", labelKey: "vimnav.toggle_help", section: "actions" },
];

const rowKey = (r: HelpRow) => `${r.chord}|${r.labelKey}`;

/** Drop repeats, optionally against rows already emitted in an earlier group. */
function dedupe(rows: readonly HelpRow[], seen = new Set<string>()): HelpRow[] {
  const out: HelpRow[] = [];
  for (const r of rows) {
    const k = rowKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function chordsOf(b: Binding, platform: Platform): string {
  return b.chords.map((c) => formatChord(parseChord(c, b.matchOn), platform)).join(" / ");
}

/**
 * Build the overlay's groups.
 *
 * `active` is the scope the next keystroke would resolve against — see
 * panes.ts. When it has scoped bindings they lead, under their own heading;
 * everything else follows in section order, exactly as before.
 */
export function helpGroups(
  bindings: readonly Binding[],
  active: ScopeId,
  platform: Platform,
): HelpGroup[] {
  const visible = bindings.filter((b) => b.help && !b.help.hidden);
  const byOrder = (a: Binding, b: Binding) => (a.help!.order ?? 0) - (b.help!.order ?? 0);

  const groups: HelpGroup[] = [];
  // Shared across every group, not per-group. Excluding only the ACTIVE scope's
  // bindings from the sections below left the other pane's identical row to
  // print anyway: `x` is "open the actions menu" on the graph AND in the
  // sidebar, so with the graph active it appeared in the leading group and
  // again under Actions — one key, listed twice, which is exactly what rule 3
  // in #144 is trying to avoid teaching.
  const emitted = new Set<string>();

  const scoped = visible.filter((b) => b.scope === active).sort(byOrder);
  const scopeTitle = SCOPE_TITLE[active];
  if (scoped.length && scopeTitle) {
    groups.push({
      titleKey: scopeTitle,
      rows: dedupe(
        scoped.map((b) => ({ chord: chordsOf(b, platform), labelKey: b.labelKey, inScope: true })),
        emitted,
      ),
    });
  }

  const sections: HelpSection[] = ["search", "sync", "view", "navigate", "actions"];
  for (const section of sections) {
    const rows: HelpRow[] = visible
      // A binding already shown in the leading group is not repeated: the
      // overlay is a reference, and the same chord twice reads as two keys.
      .filter((b) => b.help!.section === section && !(scoped.length && scopeTitle && b.scope === active))
      .sort(byOrder)
      .map((b) => ({ chord: chordsOf(b, platform), labelKey: b.labelKey, inScope: b.scope === active }));

    for (const u of UNMIGRATED) {
      if (u.section === section) rows.push({ chord: u.chord(platform), labelKey: u.labelKey, inScope: false });
    }
    // The same chord with the same label in two scopes is ONE row. `x` opens
    // the actions menu on the graph and in the sidebar, which is rule 3 in
    // #144 working — printing it twice would read as two different keys.
    const deduped = dedupe(rows, emitted);
    if (deduped.length) groups.push({ titleKey: SECTION_TITLE[section], rows: deduped });
  }

  return groups;
}
