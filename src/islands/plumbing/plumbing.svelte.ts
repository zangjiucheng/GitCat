// Plumbing playground (M5b) — controller (Svelte 5 runes singleton).
//
// Unlike reflog/rerere, this island is PURE ON-DEMAND: there is nothing to
// proactively load when the drawer tab opens (no repo-wide state to poll), so
// there is deliberately NO `refresh(repo)` method here and the drawer-tab-open
// hook the synthesis step wires for reflog/rerere should NOT be wired for this
// pane. `inspect(repo, rev)` is the whole surface: it resolves `rev` (a sha,
// short sha, branch, tag, or any ordinary git rev expression) against the
// backend's `plumbing_inspect` command and stores whatever it got back (or an
// error) for the view to render.
//
// Read-only, no mutation, so there is nothing here to guard with a busy lock
// beyond the ordinary "don't race two inspects" `busy` flag.

import { commands } from "../../ipc/bindings";
import type { PlumbingObject } from "../../ipc/bindings";
import { IN_TAURI } from "../../ipc/env";

// A single fabricated commit — good enough to demo the result-panel shape in
// the browser design-mode prototype (no backend, no repo).
const DEMO_OBJECT: PlumbingObject = {
  kind: "commit",
  sha: "a1b2c3d4e5f60718293a4b5c6d7e8f901234567",
  shortSha: "a1b2c3d",
  author: { name: "Ada Lovelace", email: "ada@example.com", time: 1735689600 },
  committer: { name: "Ada Lovelace", email: "ada@example.com", time: 1735693200 },
  parents: ["9f8e7d6c5b4a30291817263544536271809abcd"],
  tree: "0f1e2d3c4b5a69788716253443627180fedcba1",
  message: "Wire login form to API\n\nAdds the fetch call and a friendly error toast on 4xx/5xx.",
};

class PlumbingState {
  rev = $state("");
  busy = $state(false);
  demo = $state(false);
  result = $state<PlumbingObject | null>(null);
  error = $state("");

  // ── the whole surface: resolve `rev` and store the result (or error) ─────
  async inspect(repo: string | null, rev: string): Promise<void> {
    const r = (rev ?? "").trim();
    this.rev = r;
    if (!r) {
      this.result = null;
      this.error = "Enter a rev, sha, or ref to inspect.";
      return;
    }

    if (!IN_TAURI) {
      // Browser design-mode: no backend to call — show a canned example so
      // the result-panel shape still demos.
      this.demo = true;
      this.busy = false;
      this.error = "";
      this.result = { ...DEMO_OBJECT };
      return;
    }

    this.demo = false;
    if (!repo) {
      this.result = null;
      this.error = "Open a repository first.";
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      const res = await commands.plumbingInspect(repo, r);
      if (res.status === "ok") {
        this.result = res.data;
        this.error = "";
      } else {
        this.result = null;
        this.error = String(res.error);
      }
    } catch (e) {
      this.result = null;
      this.error = String(e);
    } finally {
      this.busy = false;
    }
  }

  clear() {
    this.result = null;
    this.error = "";
  }
}

export const plumbing = new PlumbingState();
