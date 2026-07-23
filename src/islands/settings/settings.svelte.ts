// App Settings — controller (Svelte 5 runes singleton).
//
// Two very different kinds of "setting" live here, each following its own
// existing precedent rather than a made-up new one:
//
//   - Theme mode / cherry-pick record-origin / auto-check-updates / sound
//     effects / Tama visibility — simple client-only preferences nothing on
//     the Rust side ever needs to read or write (theme is pure CSS/DOM;
//     cherry-pick's recordOrigin arg is read straight from here at pick-time
//     by legacy/main.ts's cherryPick() — no live per-pick checkbox anymore,
//     this IS the only control now that it was moved out of the canvas
//     toolbar; auto-check is just a frontend gate around one setTimeout in
//     main.ts; sound effects gates src/legacy/sound.ts's own playTamaSound,
//     read fresh on every play the same way; Tama visibility toggles a CSS
//     class, see setTamaEnabled's own doc comment). These persist
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
import type { ConfigEntry, ConfigScope, GitIdentity, RawConfigEntry } from "../../ipc/bindings";

export type ThemeMode = "system" | "light" | "dark";

// ── Git config: curated fields ────────────────────────────────────────────
// A small, deliberately-not-exhaustive set of well-known keys with dedicated
// controls — the "Advanced" section below (any key, typed by hand) covers
// everything else. `core.autocrlf` is the flagship entry: a real,
// production-affecting bug this session (this machine's global
// core.autocrlf=true corrupting real git subprocess output, including
// GitCat's own — see git_config.rs's module doc) is what motivated this
// whole feature; being able to fix it from Settings, at whichever scope it's
// actually wrong at, is the point.
export interface CuratedConfigField {
  key: string;
  label: string;
  kind: "select" | "text";
  options?: { value: string; label: string }[];
  placeholder?: string;
}

export const CURATED_CONFIG_FIELDS: CuratedConfigField[] = [
  {
    key: "core.autocrlf",
    label: "Line endings (core.autocrlf)",
    kind: "select",
    options: [
      { value: "", label: "Not set (git default: false)" },
      { value: "false", label: "false — never convert" },
      { value: "true", label: "true — LF in the repo, CRLF in your working tree" },
      { value: "input", label: "input — CRLF → LF on commit, no conversion on checkout" },
    ],
  },
  {
    key: "pull.rebase",
    label: "Pull strategy (pull.rebase)",
    kind: "select",
    options: [
      { value: "", label: "Not set (git default: merge)" },
      { value: "false", label: "false — merge" },
      { value: "true", label: "true — rebase" },
      { value: "merges", label: "merges — rebase, preserving merge commits" },
    ],
  },
  { key: "core.editor", label: "Editor (core.editor)", kind: "text", placeholder: "e.g. code --wait" },
  { key: "init.defaultBranch", label: "Default branch name for new repos (init.defaultBranch)", kind: "text", placeholder: "e.g. main" },
];

const CURATED_CONFIG_KEYS = CURATED_CONFIG_FIELDS.map((f) => f.key);

// ── tabs ─────────────────────────────────────────────────────────────────
// The modal used to be one long scroll through 8 sections; splitting it into
// tabs groups them by what they actually act on: General (app-level prefs
// with no repo scope at all), Tama (her own visibility + sound controls),
// Git Identity (the one section with its own explicit Save button), and Git
// Config (curated fields + the Advanced raw editor — kept together since
// both read/write the exact same underlying config store via configScope).
export type SettingsTab = "general" | "tama" | "identity" | "gitconfig";

export const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "tama", label: "Tama" },
  { id: "identity", label: "Git Identity" },
  { id: "gitconfig", label: "Git Config" },
];

// Safety-Manager snapshot auto-cleanup policy — see PersistedSettings below.
export type SnapshotRetentionMode = "off" | "count" | "age" | "hybrid";

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
  // 0-1 master volume for the above, applied to sound.ts's own shared
  // GainNode fresh on every play (same "no extra wiring for a mid-session
  // change" idiom). A SEPARATE control from the enabled toggle, not a
  // replacement for it — "on but quieter" and "off" are different states a
  // user reaches for independently (see Settings.svelte's own slider).
  soundEffectsVolume: number;
  // Whether the main graph's canvas draws EVERY ref chip on a commit that
  // has more than one (e.g. two tags pushed to the same sha), or just the
  // first one — legacy/main.ts's original, still-default behavior. Off by
  // default: a commit with several tags growing a correspondingly wider chip
  // row is a real layout change existing users haven't opted into, unlike
  // the other toggles here which don't affect the graph's own rendering.
  showAllCommitTags: boolean;
  // Periodically `git fetch --all --prune` while a repo is open, so
  // ahead/behind counts and incoming remote changes stay current without a
  // manual Pull. Off by default — unlike autoCheckUpdates (checking GitHub
  // for a GitCat release, the same lightweight thing every launch), this
  // touches the user's OWN git remotes/credentials on a recurring timer;
  // that's meaningfully more surprising to have silently on by default than
  // an app-update check, so it's opt-in.
  autoFetchEnabled: boolean;
  // Whole minutes between auto-fetch attempts while enabled — see
  // AUTO_FETCH_INTERVAL_OPTIONS below for the exact choices offered.
  autoFetchIntervalMinutes: number;
  // Safety-Manager snapshot retention. Every history-changing op pins a backup
  // ref under refs/gitgui/backup/*; with no cleanup they accumulate forever.
  // The mode picks the auto-prune policy, run on repo-open:
  //   "off"    — keep everything (default: opt-in cleanup, no existing user
  //              silently loses snapshots on update).
  //   "count"  — keep the newest `snapshotRetentionCount`.
  //   "age"    — keep those newer than `snapshotRetentionDays` days.
  //   "hybrid" — keep a snapshot if it's among the newest count OR newer than
  //              the age cutoff (the safe union; a busy day is never truncated).
  // The single most-recent snapshot is never pruned regardless (backend floor),
  // so "undo my last action" always survives cleanup.
  snapshotRetentionMode: SnapshotRetentionMode;
  snapshotRetentionCount: number;
  snapshotRetentionDays: number;
  // "Serious work" mode: hides Tama's decorative portraits everywhere she
  // appears (the nook's animated sprite, the Detail empty-state hero image,
  // every modal header's small portrait, the undo "cheer" popover's image —
  // see index.html's own `.tama-off` rule) and swaps the Detail hero card's
  // playful greeting for plain, functional text. Deliberately does NOT hide
  // the nook's `.toast-line`/`.telemetry` text — that's the app's only
  // inline status/error-message surface (there's no separate toast system),
  // so turning Tama off must never silently remove messages like "Open a
  // repository first" along with the character. On by default: this is a
  // personality trait of the app, not a bug users need to opt out of a
  // regression for.
  tamaEnabled: boolean;
}

const STORAGE_KEY = "gitcat.settings";

// Auto-fetch interval choices shown in Settings — a plain array (not
// free-typed) since a background timer firing at an arbitrary user-typed
// value (e.g. "0" or a negative number) needs validating anyway; a fixed
// list sidesteps that entirely. 15 min default: frequent enough to feel
// "current" without fetching so often it'd be indistinguishable from every
// other git client's own background chatter.
export const AUTO_FETCH_INTERVAL_OPTIONS = [5, 10, 15, 30, 60] as const;

// Exactly today's hardcoded behavior (forced dark, unchecked record-origin,
// auto-update-check always on, sounds on at full volume) — existing users
// see no behavior change until they actually open Settings and change
// something. soundEffectsVolume specifically defaults to 1 (not some
// "nicer-sounding" lower number) for that exact reason: every tone in
// sound.ts had no master-gain multiplier at all before this setting
// existed, so anything below 1 here would quietly make every sound quieter
// than it used to be for users who never touch this slider.
const DEFAULTS: PersistedSettings = {
  themeMode: "dark",
  cherryPickRecordOriginDefault: false,
  autoCheckUpdates: true,
  soundEffectsEnabled: true,
  soundEffectsVolume: 1,
  showAllCommitTags: false,
  autoFetchEnabled: false,
  autoFetchIntervalMinutes: 15,
  snapshotRetentionMode: "off",
  snapshotRetentionCount: 25,
  snapshotRetentionDays: 14,
  tamaEnabled: true,
};

// Both loadSettings() (below) and setSoundEffectsVolume() need the same 0-1
// clamp — a single private helper instead of two hand-rolled copies of the
// same math, so a future fix only has one call site to find.
function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const merged = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    // Defensive clamp at the READ boundary, not just in the setter below: a
    // hand-edited (or otherwise corrupted) localStorage blob could carry a
    // non-numeric or out-of-range soundEffectsVolume straight through to
    // sound.ts's own AudioParam assignment, which THROWS on a non-finite
    // value (assigning NaN to a real GainNode's .value is a spec violation,
    // not a silent no-op) — every consumer of loadSettings() should be able
    // to trust this field is always a valid finite 0-1 number, not just the
    // one call site (the volume slider) that happens to go through the setter.
    merged.soundEffectsVolume = Number.isFinite(merged.soundEffectsVolume) ? clamp01(merged.soundEffectsVolume) : DEFAULTS.soundEffectsVolume;
    return merged;
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

// Prune Safety-Manager snapshots per the user's configured retention policy.
// Called from legacy/main.ts's openRepo (once per repo-open), the same
// "read settings fresh, IN_TAURI-gated, fire-and-forget" model main.ts's
// auto-fetch loop uses — so flipping the policy in Settings takes effect on the
// next repo-open with no extra wiring. Deliberately silent and best-effort:
// cleaning stale backup refs is background upkeep, never worth a toast or
// blocking the open, and a failure just retries next time. A no-op (one
// localStorage read) when the mode is "off".
export async function pruneSnapshotsPerPolicy(repo: string): Promise<void> {
  if (!IN_TAURI || !repo) return;
  const s = loadSettings();
  if (s.snapshotRetentionMode === "off") return;
  try {
    await commands.pruneSnapshots(repo, s.snapshotRetentionMode, s.snapshotRetentionCount, s.snapshotRetentionDays);
  } catch (e) {
    console.error("snapshot prune failed", e);
  }
}

// Canned identity for design-mode (!IN_TAURI), same spirit as setupwizard's
// own DEMO_IDENTITY. local:false so the browser preview also demos the
// "using your global identity" messaging (see Settings.svelte), not just
// the plain-filled-in-fields case.
const DEMO_IDENTITY: GitIdentity = { name: "Demo User", email: "demo@example.com", configured: true, local: false };

class SettingsState {
  open = $state(false);
  activeTab = $state<SettingsTab>("general");

  setActiveTab(tab: SettingsTab): void {
    this.activeTab = tab;
  }

  // ── app-level prefs (instant-apply, no Save button) ─────────────────────
  themeMode = $state<ThemeMode>(DEFAULTS.themeMode);
  cherryPickRecordOriginDefault = $state(DEFAULTS.cherryPickRecordOriginDefault);
  autoCheckUpdates = $state(DEFAULTS.autoCheckUpdates);
  soundEffectsEnabled = $state(DEFAULTS.soundEffectsEnabled);
  soundEffectsVolume = $state(DEFAULTS.soundEffectsVolume);
  showAllCommitTags = $state(DEFAULTS.showAllCommitTags);
  autoFetchEnabled = $state(DEFAULTS.autoFetchEnabled);
  autoFetchIntervalMinutes = $state(DEFAULTS.autoFetchIntervalMinutes);
  snapshotRetentionMode = $state<SnapshotRetentionMode>(DEFAULTS.snapshotRetentionMode);
  snapshotRetentionCount = $state(DEFAULTS.snapshotRetentionCount);
  snapshotRetentionDays = $state(DEFAULTS.snapshotRetentionDays);
  tamaEnabled = $state(DEFAULTS.tamaEnabled);

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

  // ── git config section (repo-scoped, instant-apply per field) ───────────
  // Unlike Git Identity's paired name+email (one atomic form, one Save
  // button), git config is a bag of independent settings — closer in shape
  // to the app-level prefs above (instant-apply on change/blur, no batched
  // Save) than to Identity's form. `configEntries` holds BOTH local and
  // global for every curated key at once (see git_config.rs's ConfigEntry),
  // so flipping `configScope` between "local"/"global" is a pure re-render —
  // no re-fetch needed, only the Advanced list (which is scope-specific on
  // the backend) re-fetches on a scope change.
  configScope = $state<ConfigScope>("local");
  configEntries = $state<Record<string, ConfigEntry>>({});
  configLoading = $state(false);
  configError = $state("");
  savingConfigKey = $state<string | null>(null);
  configFieldErrors = $state<Record<string, string>>({});

  advancedOpen = $state(false);
  advancedEntries = $state<RawConfigEntry[]>([]);
  advancedLoading = $state(false);
  advancedError = $state("");
  newAdvancedKey = $state("");
  newAdvancedValue = $state("");
  advancedFilter = $state("");

  // Client-side only — advancedEntries is already fully loaded for the
  // current scope (see refreshAdvanced below), so there's no reason to
  // round-trip to Rust just to narrow a list already sitting in memory.
  get filteredAdvancedEntries(): RawConfigEntry[] {
    const q = this.advancedFilter.trim().toLowerCase();
    if (!q) return this.advancedEntries;
    return this.advancedEntries.filter((e) => e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q));
  }

  // Copies a listed row into the add/update form below — addAdvancedEntry()
  // already doubles as "add" AND "update" (see its own doc comment), this
  // just removes the "must remember to retype the exact key" gotcha. No IPC
  // call here — nothing is written until the existing Set button is pressed.
  editAdvancedEntry(entry: RawConfigEntry): void {
    this.newAdvancedKey = entry.key;
    this.newAdvancedValue = entry.value;
  }

  // What a curated field's control should show right now: this scope's own
  // raw value if it has one, else "" (both select and text controls use ""
  // as their "not set at this scope" state).
  configFieldValue(key: string): string {
    const e = this.configEntries[key];
    if (!e) return "";
    return (this.configScope === "local" ? e.local : e.global) ?? "";
  }

  // A short caption for when what's actually IN EFFECT differs from what
  // this scope's own control is showing — e.g. editing Global while a Local
  // override shadows it, or editing a blank field while the OTHER scope
  // supplies the real effective value. `null` when there's nothing worth
  // flagging (the editing scope's own value already IS the effective one,
  // or nothing is set anywhere).
  effectiveConfigHint(key: string): string | null {
    const e = this.configEntries[key];
    if (!e || e.effective === null) return null;
    const editing = this.configScope === "local" ? e.local : e.global;
    if (editing === e.effective) return null;
    const source = e.local !== null ? "this repository" : "global";
    return `Currently in effect: ${e.effective} (from ${source})`;
  }

  setConfigScope(scope: ConfigScope): void {
    this.configScope = scope;
    if (this.advancedOpen) void this.refreshAdvanced();
  }

  async refreshConfig(): Promise<void> {
    if (!this.repo) {
      this.configEntries = {};
      return;
    }
    this.configError = "";
    if (!IN_TAURI) {
      // Demo state with a couple of plausible-looking values so the section
      // isn't just a wall of blanks in browser preview — same spirit as
      // DEMO_IDENTITY above, not meant to be realistic beyond "not empty".
      this.configEntries = {
        "core.autocrlf": { key: "core.autocrlf", local: null, global: "true", effective: "true" },
        "pull.rebase": { key: "pull.rebase", local: null, global: null, effective: null },
        "core.editor": { key: "core.editor", local: null, global: null, effective: null },
        "init.defaultBranch": { key: "init.defaultBranch", local: null, global: "main", effective: "main" },
      };
      return;
    }
    this.configLoading = true;
    try {
      const res = await commands.getGitConfigValues(this.repo, CURATED_CONFIG_KEYS);
      if (res.status === "ok") {
        const map: Record<string, ConfigEntry> = {};
        for (const e of res.data) map[e.key] = e;
        this.configEntries = map;
      } else {
        this.configError = String(res.error ?? "Could not read this repository's git configuration.");
      }
    } catch (e) {
      this.configError = "Could not read this repository's git configuration — " + e;
    } finally {
      this.configLoading = false;
    }
  }

  // Re-reads just ONE key after a successful write — cheaper than reloading
  // every curated field, and keeps `configEntries[key]`'s local/global pair
  // (not just the scope just written) in sync in case the effective value
  // moved for a reason other than this write (there isn't one today, but
  // there's no reason to assume only the written scope could have changed).
  private async refreshConfigKey(key: string): Promise<void> {
    if (!this.repo) return;
    try {
      const res = await commands.getGitConfigValues(this.repo, [key]);
      if (res.status === "ok" && res.data[0]) {
        this.configEntries = { ...this.configEntries, [key]: res.data[0] };
      }
    } catch {
      // Best-effort refresh only — the write itself already succeeded
      // (callers only reach this after res.ok), so a failed re-read just
      // means the UI shows a stale value until the section next reopens,
      // not worth surfacing as a fresh error on top of a successful write.
    }
  }

  // `value: null` unsets the key at the current scope. Skips a no-op write
  // when the control's value didn't actually change from what's already at
  // this scope — avoids a pointless round trip firing on every blur.
  async setConfigField(key: string, value: string | null): Promise<void> {
    if (!this.repo) return;
    const current = this.configEntries[key] ? (this.configScope === "local" ? this.configEntries[key].local : this.configEntries[key].global) : null;
    if ((current ?? null) === (value ?? null)) return;
    if (!IN_TAURI) {
      bridge.tama.say(`This is where ${key} would save (demo).`);
      return;
    }
    this.savingConfigKey = key;
    this.configFieldErrors = { ...this.configFieldErrors, [key]: "" };
    try {
      const res = await commands.setGitConfigValue(this.repo, key, value, this.configScope);
      if (res.ok) {
        await this.refreshConfigKey(key);
      } else {
        this.configFieldErrors = { ...this.configFieldErrors, [key]: res.message };
      }
    } catch (e) {
      this.configFieldErrors = { ...this.configFieldErrors, [key]: "Could not save — " + e };
    } finally {
      this.savingConfigKey = null;
    }
  }

  async openAdvanced(): Promise<void> {
    this.advancedOpen = true;
    this.advancedFilter = "";
    await this.refreshAdvanced();
  }

  closeAdvanced(): void {
    this.advancedOpen = false;
  }

  async refreshAdvanced(): Promise<void> {
    if (!this.repo) return;
    this.advancedError = "";
    if (!IN_TAURI) {
      this.advancedEntries = [];
      return;
    }
    this.advancedLoading = true;
    try {
      const res = await commands.listGitConfigEntries(this.repo, this.configScope);
      if (res.status === "ok") {
        this.advancedEntries = res.data;
      } else {
        this.advancedError = String(res.error ?? "Could not list this repository's git configuration.");
      }
    } catch (e) {
      this.advancedError = "Could not list this repository's git configuration — " + e;
    } finally {
      this.advancedLoading = false;
    }
  }

  async removeAdvancedEntry(key: string): Promise<void> {
    if (!this.repo) return;
    this.savingConfigKey = key;
    try {
      const res = await commands.setGitConfigValue(this.repo, key, null, this.configScope);
      if (res.ok) {
        await this.refreshAdvanced();
      } else {
        this.advancedError = res.message;
      }
    } catch (e) {
      this.advancedError = "Could not remove — " + e;
    } finally {
      this.savingConfigKey = null;
    }
  }

  // Doubles as "add" AND "update": typing an EXISTING single-valued key's
  // name just overwrites it (plain `git config key value`, no `--add`) —
  // there's no separate inline-edit control for a listed row, this is it.
  async addAdvancedEntry(): Promise<void> {
    if (!this.repo) return;
    const key = this.newAdvancedKey.trim();
    if (!key) return;
    const value = this.newAdvancedValue.trim();
    this.savingConfigKey = key;
    this.advancedError = "";
    try {
      const res = await commands.setGitConfigValue(this.repo, key, value, this.configScope);
      if (res.ok) {
        this.newAdvancedKey = "";
        this.newAdvancedValue = "";
        await this.refreshAdvanced();
      } else {
        this.advancedError = res.message;
      }
    } catch (e) {
      this.advancedError = "Could not save — " + e;
    } finally {
      this.savingConfigKey = null;
    }
  }

  // Entry point (Tools menu / ⌘K). Always re-seeds app-level fields from
  // localStorage and re-fetches identity — same "never trust stale state
  // across a reopen" discipline as every other on-demand modal.
  show(repo: string | null): void {
    this.activeTab = "general";
    const s = loadSettings();
    this.themeMode = s.themeMode;
    this.cherryPickRecordOriginDefault = s.cherryPickRecordOriginDefault;
    this.autoCheckUpdates = s.autoCheckUpdates;
    this.soundEffectsEnabled = s.soundEffectsEnabled;
    this.soundEffectsVolume = s.soundEffectsVolume;
    this.showAllCommitTags = s.showAllCommitTags;
    this.autoFetchEnabled = s.autoFetchEnabled;
    this.autoFetchIntervalMinutes = s.autoFetchIntervalMinutes;
    this.snapshotRetentionMode = s.snapshotRetentionMode;
    this.snapshotRetentionCount = s.snapshotRetentionCount;
    this.snapshotRetentionDays = s.snapshotRetentionDays;
    this.tamaEnabled = s.tamaEnabled;
    this.repo = repo ?? "";
    this.identityError = "";
    this.configError = "";
    this.advancedOpen = false; // collapsed by default on every reopen — not a state worth persisting across sessions
    this.open = true;
    if (this.repo) {
      void this.refreshIdentity();
      void this.refreshConfig();
    } else {
      this.identity = null;
      this.configEntries = {};
    }
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

  // Clamped defensively even though the slider's own min/max already keeps
  // the UI itself in range — loadSettings() applies the SAME clamp01() on
  // every read too, so this isn't the only thing standing between a bad
  // value and sound.ts's own AudioParam assignment, just the write-side half.
  setSoundEffectsVolume(v: number): void {
    this.soundEffectsVolume = clamp01(v);
    saveSettings({ soundEffectsVolume: this.soundEffectsVolume });
  }

  setShowAllCommitTags(v: boolean): void {
    this.showAllCommitTags = v;
    saveSettings({ showAllCommitTags: v });
    bridge.setGraphShowAllTags(v); // applies to the canvas immediately — see legacy/main.ts
  }

  // The background timer itself lives in main.ts (mirrors the existing
  // dashboard-status poll there) and reads these two via loadSettings() on
  // its own tick — no bridge call needed here, just persist like every
  // other instant-apply preference.
  setAutoFetchEnabled(v: boolean): void {
    this.autoFetchEnabled = v;
    saveSettings({ autoFetchEnabled: v });
  }

  setAutoFetchIntervalMinutes(v: number): void {
    this.autoFetchIntervalMinutes = v;
    saveSettings({ autoFetchIntervalMinutes: v });
  }

  setSnapshotRetentionMode(v: SnapshotRetentionMode): void {
    this.snapshotRetentionMode = v;
    saveSettings({ snapshotRetentionMode: v });
  }

  // Count/days are clamped to a whole number >= 1 here (not just via the
  // input's `min`): a hand-edited localStorage blob, or a blur on an emptied
  // field (which yields 0/NaN), could otherwise persist a value the backend
  // would read as "keep nothing". Anything non-finite falls to 1, same floor
  // as 0/negative — the safety floor still spares the newest either way.
  setSnapshotRetentionCount(v: number): void {
    const n = Number.isFinite(v) ? Math.max(1, Math.floor(v)) : 1;
    this.snapshotRetentionCount = n;
    saveSettings({ snapshotRetentionCount: n });
  }

  setSnapshotRetentionDays(v: number): void {
    const n = Number.isFinite(v) ? Math.max(1, Math.floor(v)) : 1;
    this.snapshotRetentionDays = n;
    saveSettings({ snapshotRetentionDays: n });
  }

  setTamaEnabled(v: boolean): void {
    this.tamaEnabled = v;
    saveSettings({ tamaEnabled: v });
    bridge.setTamaEnabled(v); // applies the .tama-off class immediately — see legacy/main.ts
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
