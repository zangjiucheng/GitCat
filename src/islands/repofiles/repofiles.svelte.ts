// .gitignore / .mailmap in-app editors (backlog #14, the FINAL backlog item)
// — controller (Svelte 5 runes singleton).
//
// Deliberately simple compared to the rest of this backlog: ONE island with
// an internal file toggle (".gitignore" / ".mailmap") rather than two
// near-duplicate islands — both are "load this repo-root text file verbatim,
// let the user edit it, save it back" in the exact same shape (see
// repo_files.rs's own module doc for why the backend is a tight two-command,
// allow-listed pair rather than a generic path API).
//
// Load discipline mirrors every other on-demand modal's `refresh()` in this
// codebase (danglingrecovery.svelte.ts/reflog.svelte.ts): NEVER trust stale
// content — `show()` and every tab switch re-fetch from the backend rather
// than caching what was last typed into the other tab. That means switching
// tabs discards any unsaved edits in the tab being left, same as this
// codebase's "never trust stale state" rule (see workdir.svelte.ts's own
// header doc) — an unsaved-edit warning would be more machinery than this
// deliberately small feature calls for.
//
// Mutation shape mirrors workdirCtrl.commit()/stageFile() exactly: a
// busy/disabled flag around the write call, a Tama toast relaying the
// backend's own message either way. The ONE asymmetry the design calls for:
// saving .gitignore triggers `workdirCtrl.refreshStatus()` afterward (an
// ignore-rule change can change what shows as untracked), saving .mailmap
// does not (it only affects author-name display/blame attribution, never
// workdir status) — see workdirCtrl.refreshStatus's own doc comment for the
// same "re-fetch, never patch in place" discipline this reuses verbatim
// rather than duplicating.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import { workdirCtrl } from "../workdir/workdir.svelte.ts";

export type RepoFileName = ".gitignore" | ".mailmap";

// Canned demo content (design-mode only) — same spirit as danglingrecovery's
// own DEMO constant, so the browser preview shows something plausible
// without a real backend.
const DEMO_CONTENT: Record<RepoFileName, string> = {
  ".gitignore": "node_modules/\ntarget/\ndist/\n.DS_Store\n*.log\n",
  ".mailmap": "Jane Doe <jane@example.com> <jane@old-address.example.com>\n",
};

class RepoFilesState {
  open = $state(false);
  file = $state<RepoFileName>(".gitignore");
  content = $state("");
  loading = $state(false); // load() in flight
  error = $state(""); // load failure — shown instead of the textarea
  busy = $state(false); // save() in flight
  demo = $state(false);

  private repo = "";
  private loadSeq = 0; // guards against a slower stale load clobbering a faster newer one

  // Entry point (Tools menu / ⌘K). Always opens on the .gitignore tab and
  // re-fetches — see module doc's "never trust stale content".
  show(repo: string | null): void {
    this.open = true;
    this.file = ".gitignore";
    void this.load(repo, ".gitignore");
  }

  close(): void {
    if (this.busy) return; // mid-save — same guard as every other modal's Escape/Close
    this.open = false;
  }

  // Tab switch: re-fetch the OTHER file fresh rather than caching what was
  // last loaded for it — see module doc.
  selectFile(file: RepoFileName): void {
    if (this.busy || this.file === file) return;
    this.file = file;
    void this.load(this.repo, file);
  }

  async load(repo: string | null, file: RepoFileName): Promise<void> {
    this.repo = repo ?? "";
    this.file = file; // single source of truth for which tab is active, regardless of caller
    const myReq = ++this.loadSeq;
    this.loading = true;
    try {
      if (!IN_TAURI) {
        this.demo = true;
        this.error = "";
        this.content = DEMO_CONTENT[file];
        return;
      }
      this.demo = false;

      if (!this.repo) {
        this.content = "";
        this.error = "Open a repository first.";
        return;
      }

      try {
        const r = await commands.readRepoFile(this.repo, file);
        if (myReq !== this.loadSeq) return; // a newer load superseded this one
        if (r.status === "ok") {
          this.content = r.data;
          this.error = "";
        } else {
          this.content = "";
          this.error = String(r.error ?? "Could not read " + file + ".");
        }
      } catch (e) {
        if (myReq !== this.loadSeq) return;
        this.content = "";
        this.error = "Could not read " + file + " — " + e;
      }
    } finally {
      if (myReq === this.loadSeq) this.loading = false;
    }
  }

  async save(): Promise<void> {
    if (this.busy) return;
    const file = this.file;
    const content = this.content;

    if (this.demo) {
      // Design-mode preview: fake the mutation locally, no IPC call — mirrors
      // danglingRecoveryCtrl.confirmRecover's own demo-mode convention.
      bridge.tama.set("celebrate");
      bridge.tama.say("Saved " + file + " (demo).", 3200);
      return;
    }

    if (!this.repo) {
      bridge.tama.warn("Open a repository first.");
      return;
    }

    this.busy = true;
    bridge.tama.set("thinking");
    bridge.tama.say("Saving " + file + "…");
    try {
      const res = await commands.writeRepoFile(this.repo, file, content);
      if (res.ok) {
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Saved " + file + ".", 3200);
        // Only .gitignore can change what the workdir reports as untracked —
        // .mailmap affects author-name display/blame attribution only, never
        // workdir status — see module doc.
        if (file === ".gitignore") {
          await workdirCtrl.refreshStatus(this.repo);
        }
      } else {
        bridge.tama.warn(res.message || "Could not save " + file + ".");
      }
    } catch (e) {
      bridge.tama.warn("Save failed — " + e);
    } finally {
      this.busy = false;
    }
  }
}

export const repoFilesCtrl = new RepoFilesState();
