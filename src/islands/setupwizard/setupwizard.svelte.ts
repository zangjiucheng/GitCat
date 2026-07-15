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
//
// The pick step's drop zone accepts a dragged-and-dropped folder as well as
// the native picker dialog (armDropZone()/disarmDropZone(), reactively
// toggled by the view based on step/open — see SetupWizard.svelte).
//
// main.ts only auto-calls start() once per install, not once per launch:
// it's a FIRST-RUN flow, not a "no repo currently open" nag — a user who's
// already been through it (skip or finish) knows where the "Open a
// repository…" hero button / topbar repo-picker are. hasBeenDismissed()
// persists that (localStorage, app-wide — not per-repo, since deciding
// whether to interrupt at boot happens before any repo is even chosen).
// openDemo() (design-mode preview) deliberately ignores this, so iterating
// on the wizard's own UI doesn't require clearing storage every reload.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import type { GitIdentity } from "../../ipc/bindings";

export type SetupWizardStep = "welcome" | "pick" | "identity" | "done";

// Canned data for design-mode (!IN_TAURI), same spirit as every other
// island's DEMO_* constants, so the browser preview still demos the full flow.
const DEMO_PATH = "/home/demo/my-project";
const DEMO_IDENTITY: GitIdentity = { name: null, email: null, configured: false, local: false };

const DISMISSED_KEY = "gitcat.setupWizardDismissed";

class SetupWizardState {
  open = $state(false);
  busy = $state(false); // re-entrancy lock (dialog / IPC in flight)
  demo = $state(false);
  step = $state<SetupWizardStep>("welcome");
  tamaImg = $state("");

  // ── pick step ──────────────────────────────────────────────────────────
  repoPath = $state<string | null>(null);
  pathError = $state("");
  dragOver = $state(false); // true while a native OS drag is hovering the window
  private dragUnlisten: (() => void) | null = null;

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

  hasBeenDismissed(): boolean {
    try {
      return localStorage.getItem(DISMISSED_KEY) === "1";
    } catch {
      return false; // storage disabled (e.g. private mode) — worst case it keeps reappearing
    }
  }

  private markDismissed() {
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // ignore — see hasBeenDismissed()
    }
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
    if (this.busy) return; // don't jump steps under an in-flight validate/save/open
    this.step = "welcome";
  }

  backToPick() {
    if (this.busy) return; // don't jump steps under an in-flight validate/save/open
    this.identity = null;
    this.step = "pick";
  }

  async pickDirectory() {
    if (this.busy) return;
    this.pathError = "";
    // `busy` now covers the NATIVE DIALOG itself, not just the validate() call
    // after it resolves — previously the drop-zone's busy state and the
    // Skip/Back buttons' disabled bindings did nothing while the OS folder
    // picker was on screen, so a user could click Back mid-dialog and then
    // get forced back to "pick" anyway once the dialog resolved.
    this.busy = true;
    try {
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
    } finally {
      this.busy = false;
    }
  }

  // ── drag-and-drop onto the pick-step drop zone ──────────────────────────
  // Tauri intercepts native OS drag-and-drop at the webview level (it never
  // reaches the DOM as browser dragover/drop events), so this listens via
  // window.__TAURI__.webview's onDragDropEvent instead. The wizard is a
  // full-window modal with nothing else droppable underneath, so — unlike a
  // real multi-target page — there's no need to hit-test the drop position
  // against the drop-zone's DOM rect; any drop while armed is for us.
  async armDropZone() {
    if (this.demo || this.dragUnlisten) return; // no real webview in design-mode preview
    try {
      const w = window as unknown as { __TAURI__?: any };
      const wv = w.__TAURI__?.webview;
      if (!wv?.getCurrentWebview) return;
      this.dragUnlisten = await wv.getCurrentWebview().onDragDropEvent((e: any) => {
        const p = e.payload;
        if (p.type === "drop") {
          this.dragOver = false;
          if (p.paths?.[0]) this.acceptDroppedPath(p.paths[0]);
        } else if (p.type === "enter" || p.type === "over") {
          this.dragOver = true;
        } else {
          this.dragOver = false;
        }
      });
    } catch {
      // no drag-drop API available (older webview, or design-mode) — the
      // click-to-browse path still works, so this is a silent no-op.
    }
  }

  disarmDropZone() {
    this.dragOver = false;
    if (this.dragUnlisten) {
      this.dragUnlisten();
      this.dragUnlisten = null;
    }
  }

  async acceptDroppedPath(path: string) {
    if (this.busy) return;
    this.pathError = "";
    this.repoPath = path;
    this.busy = true;
    try {
      await this.validate();
    } finally {
      this.busy = false;
    }
  }

  // Re-entrancy is the CALLER's job (pickDirectory/acceptDroppedPath both wrap
  // their whole operation — dialog included — in busy=true/finally busy=false)
  // so this stays a plain helper with no lock of its own; it would otherwise
  // conflict with a caller that (correctly) sets busy before calling in.
  private async validate() {
    if (!this.repoPath) return;
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
    }
  }

  skipIdentity() {
    if (this.busy) return; // don't jump to done under an in-flight saveIdentity
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
        this.identity = { name, email, configured: true, local: true };
        this.step = "done";
        return;
      }
      const res = await commands.setGitIdentity(this.repoPath, name, email);
      if (res.ok) {
        this.identity = { name, email, configured: true, local: true };
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
    // "thinking" while the graph actually loads — was set to the SAME "happy"
    // image finish() ends on for success, so there was no visual difference
    // between "still opening" and "done" for however long load_graph took.
    this.tamaImg = bridge.TAMA_IMG.thinking;
    if (this.demo) {
      // Never call bridge.openRepo in demo mode: there is no real Tauri
      // backend to hit, and tinvoke has no IN_TAURI guard of its own.
      bridge.tama.say("This is where your repository's graph would open. にゃ〜 (demo)", 4200);
      this.open = false;
      this.busy = false;
      this.markDismissed();
      return;
    }
    // openRepo never throws, but it DOES swallow load_graph failures internally
    // (only a Tama toast) and now reports success/failure. Only tear down the
    // done-step overlay when the graph actually loaded; on failure keep it up
    // with an inline error so the user can retry "Open repository".
    const ok = await bridge.openRepo(this.repoPath);
    if (ok) {
      this.open = false;
      this.markDismissed();
    } else {
      this.tamaImg = bridge.TAMA_IMG.hero;
      this.finishError = "Couldn't open the repository — please try again.";
    }
    this.busy = false;
  }

  // ── skippable at any step ────────────────────────────────────────────────
  skip() {
    // Honor the re-entrancy lock like the Escape handler: dismissing mid-flight
    // would let a resolving validate()/openRepo() reopen or jump the wizard
    // after the user already chose to leave.
    if (this.busy) return;
    this.resetWizard();
    this.markDismissed();
    // Skipping always leaves the app with no repo open yet (finish() is the
    // only path that opens one) — point at both ways back in, since the
    // empty-state hero card's own button is easy to miss right after a modal
    // closes.
    bridge.tama.say("No rush — open a repository anytime via the folder icon or the repo name ▾ up top. にゃ〜", 4200);
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
