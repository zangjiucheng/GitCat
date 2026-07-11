// Pickaxe / diff-content search — controller (Svelte 5 runes singleton).
//
// Tools-menu/⌘K "Search Commit Content…" — searches the WHOLE commit
// history's DIFFS (not just subject/sha/author, the way ⌘K's own commit
// fuzzy-match over already-loaded rows already covers — see cmdk.svelte.ts's
// own header doc) for a string/pattern, wrapping pickaxe.rs's
// `pickaxe_search` command (`git log -S<query>` / `git log -G<query>`).
//
// Structural mirror of plumbing.svelte.ts's own "on-demand form -> search(),
// never an auto-refreshing repo-wide refresh()" shape (search() only runs
// when the user submits the form, exactly like inspect() — there's nothing
// repo-wide to proactively load on show(), only whatever the user types)
// CROSSED with filehistory.svelte.ts's own "list of matching commits +
// jumpToCommit" shape (a pickaxe search returns a LIST, not Plumbing's single
// object).
//
// jumpToCommit(sha): deliberately its OWN copy of fileHistoryCtrl's (itself a
// copy of blameCtrl's/cmdk's) — see filehistory.svelte.ts's own doc comment
// on this codebase's "duplicate the small sha-lookup + scroll/select body per
// controller" convention; not shared here either.
//
// Two distinct, non-interchangeable modes exposed as a real mode selector,
// not one merged "search string + regex toggle" (see pickaxe.rs's own module
// doc for the empirically-verified git semantics behind this):
//   - "added-removed" (-S): occurrence-COUNT-change search, literal by
//     default, with its own optional "treat as regex" checkbox.
//   - "diff-match" (-G): any added/removed diff LINE matches — always regex,
//     the view never renders a regex checkbox for this mode (the field is
//     simply not sent as true from here in that case, since there's no
//     control to set it).

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import type { PickaxeMatch, PickaxeResults } from "../../ipc/bindings";

export type PickaxeMode = "added-removed" | "diff-match";

// Demo data (design-mode only) — a small canned result list, same spirit as
// every other island's DEMO constant, so the browser preview still shows a
// populated result list without a real backend.
const DEMO_RESULTS: PickaxeResults = {
  truncated: false,
  entries: [
    {
      sha: "a1b2c3da1b2c3da1b2c3da1b2c3da1b2c3da1b2",
      shortSha: "a1b2c3d",
      subject: "extend session ttl, add rate limiting",
      an: { n: "You", e: "you@example.com", t: 0 },
    },
    {
      sha: "bb01ccdbb01ccdbb01ccdbb01ccdbb01ccdbb01",
      shortSha: "bb01ccd",
      subject: "rename token-store -> auth/session",
      an: { n: "Ada Lovelace", e: "ada@example.com", t: 0 },
    },
    {
      sha: "e4f5061e4f5061e4f5061e4f5061e4f5061e4f5",
      shortSha: "e4f5061",
      subject: "create token store",
      an: { n: "Ada Lovelace", e: "ada@example.com", t: 0 },
    },
  ],
};

class PickaxeSearchState {
  open = $state(false);
  query = $state("");
  mode = $state<PickaxeMode>("added-removed");
  regex = $state(false);
  allRefs = $state(false);
  file = $state("");
  busy = $state(false);
  error = $state("");
  data = $state<PickaxeResults | null>(null);

  repo = "";

  // Lazily-built sha(7-char)->row map, cached against bridge.G's identity —
  // own copy of fileHistoryCtrl's/blameCtrl's identical cache (see module
  // doc on why this isn't shared).
  private cacheG: unknown = null;
  private shaRowIndex: Map<string, number> = new Map();

  // Entry point (Tools menu / ⌘K). Deliberately does NOT reset the form or
  // clear a previous result on reopen — same "nothing here can go stale
  // behind your back" reasoning as plumbing.svelte.ts's own show(): unlike
  // reflog/rerere/remotes there's no repo-wide list to refresh, only whatever
  // the user last typed/found, which is still worth showing again.
  show(repo: string | null): void {
    this.repo = repo || "";
    this.open = true;
  }

  close(): void {
    if (this.busy) return;
    this.open = false;
  }

  // ── the whole surface: run the search and store the result (or error) ───
  async search(): Promise<void> {
    if (this.busy) return;
    const q = this.query.trim();
    if (!q) {
      this.data = null;
      this.error = "Enter something to search for.";
      return;
    }

    if (!IN_TAURI) {
      // Browser design-mode: no backend to call — show a canned example so
      // the result-list shape still demos.
      this.error = "";
      this.data = { ...DEMO_RESULTS, entries: DEMO_RESULTS.entries.map((e) => ({ ...e })) };
      return;
    }

    if (!this.repo) {
      this.data = null;
      this.error = "Open a repository first.";
      return;
    }

    this.busy = true;
    this.error = "";
    try {
      const file = this.file.trim() || null;
      // `regex` is only ever meaningfully true for "added-removed" (the view
      // never renders the checkbox for "diff-match") — forwarded as-is
      // regardless of mode, since pickaxe.rs's own command already ignores
      // it for "diff-match" (see that module's doc comment); no need to
      // re-guard the same decision here too.
      const res = await commands.pickaxeSearch(this.repo, q, this.mode, this.regex, this.allRefs, file, null);
      if (res.status === "ok") {
        this.data = res.data;
        this.error = "";
      } else {
        this.data = null;
        this.error = String(res.error ?? "Search failed.");
      }
    } catch (e) {
      this.data = null;
      this.error = "Search failed — " + e;
    } finally {
      this.busy = false;
    }
  }

  private ensureShaIndex(): void {
    if (this.cacheG === bridge.G) return;
    const map = new Map<string, number>();
    const G: any = bridge.G,
      BACKEND: any = bridge.BACKEND;
    const N = G ? G.N : 0;
    for (let r = 0; r < N; r++) {
      const sha: string = BACKEND ? BACKEND.rows[r]?.sha : bridge.hhex(r);
      if (sha) map.set(sha, r);
    }
    this.shaRowIndex = map;
    this.cacheG = bridge.G;
  }

  private rowForSha(shortSha7: string): number | null {
    this.ensureShaIndex();
    const row = this.shaRowIndex.get(shortSha7);
    return row == null ? null : row;
  }

  // Click a result row -> jump to that commit on the canvas. Own copy of
  // fileHistoryCtrl.jumpToCommit's body — see module doc on why this is
  // deliberately duplicated rather than shared.
  jumpToCommit(sha: string): void {
    const row = this.rowForSha(sha.slice(0, 7));
    this.close();
    if (row == null) {
      bridge.tama.warn("commit not loaded in the current graph");
      return;
    }
    const G: any = bridge.G;
    if (!G || row < 0 || row >= G.N) return;
    bridge.state.scrollTarget = bridge.clampScroll(row * bridge.layout.rowH - (bridge.view.cssH - bridge.bandH()) * 0.4);
    bridge.select(row);
    try {
      bridge.cv.focus();
    } catch (_) {
      /* best-effort focus, never blocks the jump */
    }
  }
}

export const pickaxeSearchCtrl = new PickaxeSearchState();
export type { PickaxeMatch, PickaxeResults };
