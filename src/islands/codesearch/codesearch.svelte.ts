// Search Code — controller (Svelte 5 runes singleton).
//
// Tools-menu/⌘K "Search Code…" — full-text search of the current checkout
// (or a chosen historical commit's tree), wrapping code_search.rs's
// `code_search` command (`git grep`). Complements pickaxesearch.svelte.ts's
// "Search Commit Content" (searches historical DIFFS, returns commits): this
// searches file CONTENT and returns file+line+text.
//
// Structural mirror of pickaxesearch.svelte.ts's own shape almost exactly
// (open/query/busy/error/data/repo fields; show() deliberately does NOT
// reset the form or clear a previous result on reopen, same "nothing here
// can go stale behind your back" reasoning — there's no repo-wide list to
// refresh, only whatever was last typed/found).
//
// openHistory/openBlame: peer-island calls into fileHistoryCtrl/blameCtrl's
// own openFor(repo, atCommit, file, oldPath?) — the SAME reusable entry
// point those controllers already expose to Detail.svelte's/Workdir.svelte's
// file-tree rows (see their own header docs). Closes this modal first, same
// convention as pickaxeSearchCtrl.jumpToCommit's own close-then-navigate
// order.

import { commands } from "../../ipc/bindings";
import { IN_TAURI } from "../../ipc/env";
import type { CodeSearchMatch, CodeSearchResults } from "../../ipc/bindings";
import { fileHistoryCtrl } from "../filehistory/filehistory.svelte.ts";
import { blameCtrl } from "../blame/blame.svelte.ts";

// Demo data (design-mode only) — a small canned result list, same spirit as
// every other island's DEMO constant, so the browser preview still shows a
// populated result list without a real backend.
const DEMO_RESULTS: CodeSearchResults = {
  truncated: false,
  matches: [
    { path: "src/auth/session.ts", line: 42, text: "  extendSessionTtl(session, RATE_LIMIT_WINDOW_MS);" },
    { path: "src/auth/session.ts", line: 88, text: "export function extendSessionTtl(session, ms) {" },
    { path: "src/auth/token-store.ts", line: 12, text: "  // extendSessionTtl reads this table directly" },
  ],
};

class CodeSearchState {
  open = $state(false);
  query = $state("");
  caseSensitive = $state(false);
  atCommit = $state(""); // blank = working tree
  busy = $state(false);
  error = $state("");
  data = $state<CodeSearchResults | null>(null);

  repo = "";

  // Entry point (Tools menu / ⌘K). Deliberately does NOT reset the form or
  // clear a previous result on reopen — see module doc.
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
      this.data = { ...DEMO_RESULTS, matches: DEMO_RESULTS.matches.map((m) => ({ ...m })) };
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
      const atCommit = this.atCommit.trim() || null;
      const res = await commands.codeSearch(this.repo, q, this.caseSensitive, atCommit);
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

  openHistory(m: CodeSearchMatch): void {
    this.close();
    void fileHistoryCtrl.openFor(this.repo, this.atCommit.trim() || null, m.path);
  }

  openBlame(m: CodeSearchMatch): void {
    this.close();
    void blameCtrl.openFor(this.repo, this.atCommit.trim() || null, m.path, null);
  }
}

export const codeSearchCtrl = new CodeSearchState();
export type { CodeSearchMatch, CodeSearchResults };
