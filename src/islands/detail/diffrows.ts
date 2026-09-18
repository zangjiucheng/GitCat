// Turning one file's raw hunk lines into the rows the diff viewer renders.
//
// Extracted from detail.svelte.ts's renderSelectedFileDiff so the two-commit
// compare (#49) draws its diff with the SAME line numbering, the same +/-
// classes and the same syntax highlighting, rather than a second copy that
// agrees today and drifts later. Pure: no controller state, no IPC, no DOM.

import * as bridge from "@/legacy/bridge";
import type { DiffRow } from "./detail.svelte.ts";

/** One file's textual diff, as both the commit detail and the range diff carry it. */
export interface DiffLines {
  readonly lang: string;
  /** `[marker, text]`, where marker is "@@" for a hunk header, "+", "-" or " ". */
  readonly lines: readonly (readonly [string, string])[];
  readonly truncated: boolean;
}

/**
 * Build the rows for one file.
 *
 * The line numbering is the part worth not duplicating: an added line advances
 * only the NEW counter, a removed line only the OLD one, and context advances
 * both — get that wrong and every number below the first change is off by one,
 * silently and only on files that have both kinds of change.
 */
export function buildDiffRows(d: DiffLines): DiffRow[] {
  let oldNo = 0;
  let newNo = 0;
  const rows: DiffRow[] = [];
  for (const [mk, txt] of d.lines) {
    if (mk === "@@") {
      rows.push({ kind: "hunk", text: txt });
      continue;
    }
    const cls = mk === "+" ? "add" : mk === "-" ? "del" : "";
    const ln = mk === "+" ? newNo++ : mk === "-" ? oldNo++ : (oldNo++, newNo++);
    rows.push({
      kind: "line",
      ln,
      mk: mk === "+" || mk === "-" ? mk : "",
      cls,
      html: bridge.highlight(txt, d.lang),
    });
  }
  if (d.truncated) rows.push({ kind: "note", text: "… diff truncated (file capped)" });
  return rows;
}
