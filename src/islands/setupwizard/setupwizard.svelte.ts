// Setup wizard — controller (Svelte 5 runes singleton).
//
// First-run onboarding: welcome -> pick a repository -> check/fix its git
// identity (repo-local only, never global) -> hand off into the real graph
// view. Purely an ADDITIVE overlay: it never touches legacy/main.ts's
// bootEmpty()/pickRepo() hero card, so dismissing the wizard (Esc or any
// "Skip" button) always falls back to that untouched, already-working path.
// Same real/demo duality as every other island (filterrepo, bisect, rerere):
// legacy/main.ts's caller (via main.ts, see there) decides start() vs.
// openDemo() based on IN_TAURI — this controller never imports ipc/env.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import type { GitIdentity } from "../../ipc/bindings";

export type SetupWizardStep = "welcome" | "pick" | "identity" | "done";

// Canned data for design-mode (!IN_TAURI), same spirit as every other
// island's DEMO_* constants, so the browser preview still demos the full flow.
const DEMO_PATH = "/home/demo/my-project";
const DEMO_IDENTITY: GitIdentity = { name: null, email: null, configured: false };

class SetupWizardState {
  open = $state(false);
  busy = $state(false); // re-entrancy lock (dialog / IPC in flight)
  demo = $state(false);
  step = $state<SetupWizardStep>("welcome");
  tamaImg = $state("");

  // ── pick step ──────────────────────────────────────────────────────────
  repoPath = $state<string | null>(null);
  pathError = $state("");

  // ── identity step ──────────────────────────────────────────────────────
  identity = $state<GitIdentity | null>(null);
  nameInput = $state("");
  emailInput = $state("");
  saveError = $state("");

  // ── done step ───────────────────────────────────────────────────────────
  finishError = $state("");

  get canSave(): boolean {
    return this.nameInput.trim().length > 0 && this.emailInput.trim().length > 0 && !this.busy;
  }

  // ── real entry — main.ts calls this at boot when IN_TAURI && no repo open ──
  start() {
    this.resetWizard();
    this.demo = false;
    this.tamaImg = bridge.TAMA_IMG.hero;
    this.open = true;
  }

  // ── design-mode demo entry — main.ts calls this when !IN_TAURI ──────────
  openDemo() {
    this.resetWizard();
    this.demo = true;
    this.tamaImg = bridge.TAMA_IMG.hero;
    this.open = true;
  }

  toPick() {
    this.pathError = "";
    this.step = "pick";
  }

  backToWelcome() {
    this.step = "welcome";
  }

  backToPick() {
    this.identity = null;
    this.step = "pick";
  }

  async pickDirectory() {
    if (this.busy) return;
    this.pathError = "";

    if (this.demo) {
      this.repoPath = DEMO_PATH;
      await this.validate();
      return;
    }

    let dir: unknown = null;
    try {
      const w = window as unknown as { __TAURI__?: any };
      const d = w.__TAURI__?.dialog;
      dir = d?.open
        ? await d.open({ directory: true, title: "Open a Git repository" })
        : await w.__TAURI__.core.invoke("plugin:dialog|open", {
            options: { directory: true, title: "Open a Git repository" },
          });
    } catch (e) {
      this.pathError = "Dialog error — " + e;
      return;
    }
    if (!dir) return; // user cancelled the native picker — stay on "pick"
    this.repoPath = typeof dir === "string" ? dir : (dir as any).path || String(dir);
    await this.validate();
  }

  private async validate() {
    if (!this.repoPath) return;
    this.busy = true;
    this.pathError = "";
    try {
      if (this.demo) {
        this.identity = { ...DEMO_IDENTITY };
      } else {
        const r = await commands.getGitIdentity(this.repoPath);
        if (r.status === "ok") {
          this.identity = r.data;
        } else {
          this.identity = null;
          this.pathError = String(r.error ?? "That doesn't look like a git repository.");
          return;
        }
      }
      if (this.identity.configured) {
        this.step = "done";
      } else {
        this.nameInput = this.identity.name ?? "";
        this.emailInput = this.identity.email ?? "";
        this.saveError = "";
        this.step = "identity";
      }
    } catch (e) {
      // getGitIdentity's binding RETHROWS when TAURI_INVOKE rejects with an
      // Error (only the non-Error path becomes a {status:"error"} Result), so
      // without this catch the failure would escape validate() -> pickDirectory()
      // as an unhandled rejection, leaving the user stranded on "pick" with no
      // message. Surface it as pathError like every other pick-step failure.
      this.identity = null;
      this.pathError = "That doesn't look like a git repository — " + e;
    } finally {
      this.busy = false;
    }
  }

  skipIdentity() {
    this.step = "done";
  }

  async saveIdentity() {
    if (!this.canSave || !this.repoPath) return;
    this.busy = true;
    this.saveError = "";
    try {
      const name = this.nameInput.trim();
      const email = this.emailInput.trim();
      if (this.demo) {
        this.identity = { name, email, configured: true };
        this.step = "done";
        return;
      }
      const res = await commands.setGitIdentity(this.repoPath, name, email);
      if (res.ok) {
        this.identity = { name, email, configured: true };
        this.step = "done";
      } else {
        this.saveError = res.message || "Could not set the repository identity.";
      }
    } catch (e) {
      this.saveError = "Could not set the repository identity — " + e;
    } finally {
      this.busy = false;
    }
  }

  // ── done -> hand off into the real graph view ───────────────────────────
  async finish() {
    if (this.busy || !this.repoPath) return;
    this.busy = true;
    this.finishError = "";
    this.tamaImg = bridge.TAMA_IMG.happy;
    if (this.demo) {
      // Never call bridge.openRepo in demo mode: there is no real Tauri
      // backend to hit, and tinvoke has no IN_TAURI guard of its own.
      bridge.tama.say("This is where your repository's graph would open. にゃ〜 (demo)", 4200);
      this.open = false;
      this.busy = false;
      return;
    }
    // openRepo never throws, but it DOES swallow load_graph failures internally
    // (only a Tama toast) and now reports success/failure. Only tear down the
    // done-step overlay when the graph actually loaded; on failure keep it up
    // with an inline error so the user can retry "Open repository".
    const ok = await bridge.openRepo(this.repoPath);
    if (ok) {
      this.open = false;
    } else {
      this.tamaImg = bridge.TAMA_IMG.hero;
      this.finishError = "Couldn't open the repository — please try again.";
    }
    this.busy = false;
  }

  // ── skippable at any step ────────────────────────────────────────────────
  skip() {
    this.resetWizard();
  }

  private resetWizard() {
    this.step = "welcome";
    this.repoPath = null;
    this.pathError = "";
    this.identity = null;
    this.nameInput = "";
    this.emailInput = "";
    this.saveError = "";
    this.finishError = "";
    this.busy = false;
    this.open = false;
  }
}

export const setupWizardCtrl = new SetupWizardState();
