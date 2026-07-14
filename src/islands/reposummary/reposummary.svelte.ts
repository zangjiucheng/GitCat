// Repository Summary — controller (Svelte 5 runes singleton).
//
// Structural mirror of Reflog Rescue / Dangling Recovery (reflog.svelte.ts /
// danglingrecovery.svelte.ts): a real .scrim/.modal, opened on demand (Tools
// menu / ⌘K — see menu.rs/cmdk.svelte.ts). `refresh` is the public,
// idempotent, safely-repeatable hook `show()` calls, so the data is always
// live rather than however stale it was the last time this was open. Unlike
// both of those, this is PURE READ — no mutation action at all, so there's
// no `busy`/re-entrancy-guard state to speak of.
//
// THE ONE ADDITION beyond that shared template: `maybeAutoShow`, the hook
// that makes this modal appear automatically the FIRST time a given repo is
// ever opened in GitCat (see repo_registry.rs's `claim_repo_summary_first_open`
// doc comment for why that check lives in the registry, not here). Its sole
// call site is legacy/main.ts's `openRepo()`, right after `bisectCtrl.probeOnOpen`
// and before that function's own `return true` — see that file's own comment
// for why auto-show must be ordered last among repo-open side effects.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import type { RepoSummary } from "../../ipc/bindings";

// Canned demo data (design-mode only) — same spirit as reflog.svelte.ts's own
// DEMO constant, so the browser preview still shows a populated modal without
// a real backend.
const DEMO: RepoSummary = {
  windowDays: 365,
  totalCommits: 128,
  truncated: false,
  churn: [
    { path: "index.html", touches: 61 },
    { path: "src/legacy/main.ts", touches: 45 },
    { path: "src-tauri/src/lib.rs", touches: 42 },
    { path: "src/ipc/bindings.ts", touches: 38 },
    { path: "src/main.ts", touches: 34 },
  ],
  contributors: [
    { name: "You", email: "you@example.com", commits: 96 },
    { name: "A. Collaborator", email: "collab@example.com", commits: 32 },
  ],
  busFactor: 1,
  monthly: [
    { month: "2026-05", commits: 18 },
    { month: "2026-06", commits: 54 },
    { month: "2026-07", commits: 56 },
  ],
  problemAreas: {
    files: [
      { path: "src-tauri/src/git_rebase.rs", bugfixTouches: 6, totalTouches: 14 },
      { path: "src/islands/resolver/Resolver.svelte", bugfixTouches: 4, totalTouches: 9 },
    ],
    revertOrHotfixCommits: 3,
    totalCommits: 128,
  },
};

class RepoSummaryState {
  open = $state(false);
  loading = $state(false); // refresh() in flight
  error = $state("");
  demo = $state(false);
  summary = $state<RepoSummary | null>(null);
  // curious while browsing the summary — same framing as every other
  // read-only modal's tamaImg. Lazy-init to "" (set for real in show()) — see
  // reflog.svelte.ts's tamaImg field comment for why a field initializer
  // can't read bridge.TAMA_IMG directly.
  tamaImg = $state("");

  repo = "";

  // Entry point (Tools menu / ⌘K). Always re-fetches — see refresh()'s own
  // "never stale" doc above.
  show(repo: string | null): void {
    this.open = true;
    this.tamaImg = bridge.TAMA_IMG.curious;
    void this.refresh(repo);
  }

  close(): void {
    this.open = false;
  }

  // ── public refresh hook — safe to call repeatedly / with repo:null, same
  // contract as reflogCtrl.refresh/danglingRecoveryCtrl.refresh.
  async refresh(repo: string | null): Promise<void> {
    this.repo = repo ?? "";
    this.loading = true;
    try {
      if (!IN_TAURI) {
        // design-mode preview: no backend, seed the canned demo summary.
        this.demo = true;
        this.error = "";
        this.summary = DEMO;
        return;
      }
      this.demo = false;

      if (!this.repo) {
        this.summary = null;
        this.error = "";
        return;
      }

      try {
        const r = await commands.repoSummary(this.repo);
        if (r.status === "ok") {
          this.summary = r.data;
          this.error = "";
        } else {
          this.summary = null;
          this.error = String(r.error ?? "Could not summarize this repository.");
        }
      } catch (e) {
        this.summary = null;
        this.error = "Could not summarize this repository — " + e;
      }
    } finally {
      this.loading = false;
    }
  }

  // Called once from legacy/main.ts's openRepo() success path, right after a
  // repo finishes loading. Best-effort and self-contained (its own try/catch
  // swallows failures) so it can never block a repo from opening — same
  // reasoning already governing the track_repo_opened/watch_repo lines it
  // sits beside there. No-ops in design-mode preview: there is no real
  // per-repo "first open" concept without a backend registry to check.
  async maybeAutoShow(repo: string | null): Promise<void> {
    if (!IN_TAURI || !repo) return;
    try {
      const claim = await commands.claimRepoSummaryFirstOpen(repo);
      if (claim.status !== "ok" || !claim.data) return; // not-first, or the claim call itself failed
      await this.refresh(repo);
      // An empty/unborn repo's first open still consumes the claim (see
      // claim_repo_summary_first_open's own doc comment) but has nothing
      // meaningful to show — stay closed rather than popping an all-zeroes modal.
      if (this.summary && this.summary.totalCommits > 0) {
        this.open = true;
        this.tamaImg = bridge.TAMA_IMG.curious;
      }
    } catch (e) {
      console.error("claim_repo_summary_first_open failed", e);
    }
  }
}

export const repoSummaryCtrl = new RepoSummaryState();
