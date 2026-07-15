// App Settings — controller (Svelte 5 runes singleton).
//
// Two very different kinds of "setting" live here, each following its own
// existing precedent rather than a made-up new one:
//
//   - Theme mode / cherry-pick record-origin / auto-check-updates / sound
//     effects — simple client-only preferences nothing on the Rust side
//     ever needs to read or write (theme is pure CSS/DOM; cherry-pick's
//     recordOrigin arg is read straight from here at pick-time by
//     legacy/main.ts's cherryPick() — no live per-pick checkbox anymore,
//     this IS the only control now that it was moved out of the canvas
//     toolbar; auto-check is just a frontend gate around one setTimeout in
//     main.ts; sound effects gates src/legacy/sound.ts's own playTamaSound,
//     read fresh on every play the same way). These persist
//     to localStorage under one namespaced JSON blob — the same idiom
//     setupwizard.svelte.ts's own `gitcat.setupWizardDismissed` flag already
//     established — NOT a new Rust `tool_settings.rs`-style JSON-file
//     module, which would be pure overhead for three booleans nothing in
//     Rust ever needs. Each setter applies AND persists immediately (no
//     Save button here) — these are simple preferences, not a form needing
//     validation.
//
//   - Git identity — real per-repo `.git/config`, already fully implemented
//     (identity.rs's get_git_identity/set_git_identity) with its only
//     caller being the first-run setup wizard. This section just gives it a
//     second, always-reachable home — same repo-scoped `show(repo)` /
//     explicit-Save shape as setupwizard.svelte.ts's own identity step
//     (refreshIdentity/saveIdentity below are close copies of that file's
//     validate()/saveIdentity()), scoped to whatever repo is currently open
//     instead of a wizard's own one-time repoPath.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import type { GitIdentity } from "../../ipc/bindings";

export type ThemeMode = "system" | "light" | "dark";

export interface PersistedSettings {
  themeMode: ThemeMode;
  cherryPickRecordOriginDefault: boolean;
  autoCheckUpdates: boolean;
  // Whether Tama's synthesized sound effects (see src/legacy/sound.ts) play
  // on her more significant state changes (warn/danger/celebrate/hint-ish —
  // see sound.ts's own STATE_SOUND map). Read fresh on every play, not
  // cached, so toggling this mid-session takes effect immediately with no
  // extra wiring — same idiom cherryPickRecordOriginDefault's own read
  // already established.
  soundEffectsEnabled: boolean;
}

const STORAGE_KEY = "gitcat.settings";

// Exactly today's hardcoded behavior (forced dark, unchecked record-origin,
// auto-update-check always on, sounds on) — existing users see no behavior
// change until they actually open Settings and change something.
const DEFAULTS: PersistedSettings = {
  themeMode: "dark",
  cherryPickRecordOriginDefault: false,
  autoCheckUpdates: true,
  soundEffectsEnabled: true,
};

export function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS }; // storage disabled (e.g. private mode) or corrupt JSON — fall back quietly
  }
}

export function saveSettings(partial: Partial<PersistedSettings>): PersistedSettings {
  const next = { ...loadSettings(), ...partial };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore — see loadSettings()
  }
  return next;
}

// Canned identity for design-mode (!IN_TAURI), same spirit as setupwizard's
// own DEMO_IDENTITY. local:false so the browser preview also demos the
// "using your global identity" messaging (see Settings.svelte), not just
// the plain-filled-in-fields case.
const DEMO_IDENTITY: GitIdentity = { name: "Demo User", email: "demo@example.com", configured: true, local: false };

class SettingsState {
  open = $state(false);

  // ── app-level prefs (instant-apply, no Save button) ─────────────────────
  themeMode = $state<ThemeMode>(DEFAULTS.themeMode);
  cherryPickRecordOriginDefault = $state(DEFAULTS.cherryPickRecordOriginDefault);
  autoCheckUpdates = $state(DEFAULTS.autoCheckUpdates);
  soundEffectsEnabled = $state(DEFAULTS.soundEffectsEnabled);

  // ── git identity section (repo-scoped, explicit Save) ───────────────────
  // Unlike remotes.svelte.ts's own plain (non-$state) `repo` field — which
  // this was originally modeled on — this ONE needs `$state`: Remotes never
  // renders `.repo` in its template (only uses it internally for IPC calls),
  // so its non-reactivity is invisible there. Settings.svelte DOES render
  // `{#if !settingsCtrl.repo}` directly — without `$state` that block's
  // fine-grained reactive effect only ever evaluates once, at this
  // always-mounted component's FIRST-EVER render (repo === "" at boot,
  // before any show() call), and never again — permanently freezing the
  // Git Identity section on "no repository open" even after a real repo
  // opens and show() reassigns this field.
  repo = $state("");
  identity = $state<GitIdentity | null>(null);
  nameInput = $state("");
  emailInput = $state("");
  identityLoading = $state(false);
  identitySaving = $state(false);
  identityError = $state("");

  get canSaveIdentity(): boolean {
    return this.nameInput.trim().length > 0 && this.emailInput.trim().length > 0 && !this.identitySaving;
  }

  // Entry point (Tools menu / ⌘K). Always re-seeds app-level fields from
  // localStorage and re-fetches identity — same "never trust stale state
  // across a reopen" discipline as every other on-demand modal.
  show(repo: string | null): void {
    const s = loadSettings();
    this.themeMode = s.themeMode;
    this.cherryPickRecordOriginDefault = s.cherryPickRecordOriginDefault;
    this.autoCheckUpdates = s.autoCheckUpdates;
    this.soundEffectsEnabled = s.soundEffectsEnabled;
    this.repo = repo ?? "";
    this.identityError = "";
    this.open = true;
    if (this.repo) void this.refreshIdentity();
    else this.identity = null;
  }

  close(): void {
    if (this.identitySaving) return; // mid-save — same guard as every other modal's Close
    this.open = false;
  }

  setThemeMode(mode: ThemeMode): void {
    this.themeMode = mode;
    bridge.applyThemeMode(mode); // applies to the DOM AND persists — see legacy/main.ts
  }

  setCherryPickRecordOriginDefault(v: boolean): void {
    this.cherryPickRecordOriginDefault = v;
    saveSettings({ cherryPickRecordOriginDefault: v });
  }

  setAutoCheckUpdates(v: boolean): void {
    this.autoCheckUpdates = v;
    saveSettings({ autoCheckUpdates: v });
  }

  setSoundEffectsEnabled(v: boolean): void {
    this.soundEffectsEnabled = v;
    saveSettings({ soundEffectsEnabled: v });
  }

  async refreshIdentity(): Promise<void> {
    if (!this.repo) {
      this.identity = null;
      return;
    }
    this.identityError = "";
    if (!IN_TAURI) {
      this.identity = { ...DEMO_IDENTITY };
      this.nameInput = DEMO_IDENTITY.name ?? "";
      this.emailInput = DEMO_IDENTITY.email ?? "";
      return;
    }
    this.identityLoading = true;
    try {
      const r = await commands.getGitIdentity(this.repo);
      if (r.status === "ok") {
        this.identity = r.data;
        this.nameInput = r.data.name ?? "";
        this.emailInput = r.data.email ?? "";
      } else {
        this.identity = null;
        this.identityError = String(r.error ?? "Could not read this repository's git identity.");
      }
    } catch (e) {
      // getGitIdentity's binding rethrows on a real Error rejection (only a
      // non-Error rejection becomes a {status:"error"} Result) — same nuance
      // setupwizard.svelte.ts's own validate() already guards against.
      this.identity = null;
      this.identityError = "Could not read this repository's git identity — " + e;
    } finally {
      this.identityLoading = false;
    }
  }

  async saveIdentity(): Promise<void> {
    if (!this.canSaveIdentity || !this.repo) return;
    this.identitySaving = true;
    this.identityError = "";
    try {
      const name = this.nameInput.trim();
      const email = this.emailInput.trim();
      if (!IN_TAURI) {
        this.identity = { name, email, configured: true, local: true };
        bridge.tama.say("This is where this repository's git identity would save (demo).");
        return;
      }
      const res = await commands.setGitIdentity(this.repo, name, email);
      if (res.ok) {
        this.identity = { name, email, configured: true, local: true };
        bridge.tama.say("Git identity updated.");
      } else {
        this.identityError = res.message || "Could not update this repository's git identity.";
      }
    } catch (e) {
      this.identityError = "Could not update this repository's git identity — " + e;
    } finally {
      this.identitySaving = false;
    }
  }
}

export const settingsCtrl = new SettingsState();
