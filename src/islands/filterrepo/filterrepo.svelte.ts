// Filter-repo wizard (M5c) — controller (Svelte 5 runes singleton).
//
// The ONE remaining destructive/irreversible-by-normal-Undo operation in
// GitCat: `git filter-repo` rewrites every commit hash in the selected scope,
// and by its own design aggressively expires the reflog and prunes — so the
// ordinary Safety Manager model (pin a ref, `reset --hard` back to it) does
// NOT protect against it. That's why this is its OWN dedicated multi-step
// modal (mounted to document.body, like Resolver/Bisect) instead of the
// generic single-step armDanger confirm flow it replaces: scope -> preview ->
// typed confirm -> run -> result, plus a separate restore-from-backup view.
//
// Two independent typed-confirm gates, mirroring (but not reusing the code
// of) the rigor of the existing armDanger pattern:
//   - running filter-repo requires typing REWRITE_PHRASE exactly
//   - restoring a backup requires typing RESTORE_PHRASE exactly (a restore
//     discards the current, presumably-unwanted, post-rewrite state — that's
//     a second destructive action in its own right)

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import type { FilterRepoBackupInfo, FilterRepoPreview, FilterRepoResult } from "../../ipc/bindings";

export type FilterRepoStep = "scope" | "preview" | "confirm" | "result" | "restore";

/** Exact-match phrase gating the destructive filter-repo run itself. */
export const REWRITE_PHRASE = "REWRITE HISTORY";
/** Exact-match phrase gating a restore (discards the post-rewrite state). */
export const RESTORE_PHRASE = "RESTORE";

// Canned data for design-mode (!IN_TAURI) — same spirit as reflog/bisect's
// DEMO constants, so the browser preview still demos the full wizard shape.
const DEMO_PREVIEW: FilterRepoPreview = {
  available: true,
  currentBranch: "main",
  totalCommits: 128,
  touchedCommits: 17,
};
const DEMO_BACKUPS: FilterRepoBackupInfo[] = [
  {
    id: "1700000000-0-0",
    bundlePath: "/repo/.git/gitgui/filter-repo-backups/1700000000-0-0.bundle",
    ts: 1700000000,
    headBranch: "refs/heads/main",
    headSha: "a1b2c3d4e5f6",
    refCount: 6,
    description: "pre-filter-repo backup (6 refs)",
  },
];

function parseScope(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

class FilterRepoState {
  open = $state(false);
  busy = $state(false); // re-entrancy lock
  demo = $state(false);
  step = $state<FilterRepoStep>("scope");
  tamaImg = $state("");

  // ── scope step ─────────────────────────────────────────────────────────
  pathsText = $state("");
  // Default true: the common case is "purge this one secret file, keep
  // everything else" (--invert-paths). Unchecking targets the opposite,
  // much more destructive case: keep ONLY the listed paths.
  invert = $state(true);

  // ── preview step ───────────────────────────────────────────────────────
  preview = $state<FilterRepoPreview | null>(null);
  previewError = $state("");

  // ── confirm + result step ─────────────────────────────────────────────
  confirmText = $state("");
  result = $state<FilterRepoResult | null>(null);

  // ── restore view ───────────────────────────────────────────────────────
  backups = $state<FilterRepoBackupInfo[]>([]);
  backupsError = $state("");
  // Separate from `restoreBusy` (which guards the destructive restore ITSELF):
  // without this, the empty-backups message rendered while the list was still
  // being fetched (backups=[] from resetWizard()) was indistinguishable from a
  // confirmed-empty backup dir — see FilterRepo.svelte's "restore" step.
  backupsLoading = $state(false);
  selectedBackupId = $state<string | null>(null);
  restoreConfirmText = $state("");
  restoreResult = $state<FilterRepoResult | null>(null);
  restoreBusy = $state(false);

  repo = "";

  // ── derived ────────────────────────────────────────────────────────────
  get pathList(): string[] {
    return parseScope(this.pathsText);
  }
  get canPreview(): boolean {
    return this.pathList.length > 0 && !this.busy;
  }
  get canProceedToConfirm(): boolean {
    return !!this.preview && this.preview.available;
  }
  get canRun(): boolean {
    return this.canProceedToConfirm && this.confirmText.trim() === REWRITE_PHRASE && !this.busy;
  }
  get selectedBackup(): FilterRepoBackupInfo | null {
    return this.backups.find((b) => b.id === this.selectedBackupId) ?? null;
  }
  get canRestore(): boolean {
    return !!this.selectedBackupId && this.restoreConfirmText.trim() === RESTORE_PHRASE && !this.restoreBusy;
  }

  // ── real entry (from the toolbar button, repoints #filterRepoBtn) ────────
  // The IN_TAURI decision belongs to the caller (mirrors resolver.startPick /
  // bisectCtrl.start — legacy/main.ts picks start(repo) vs. openDemo()), not
  // this controller, so it never needs to read ipc/env itself.
  start(repo: string) {
    if (this.busy) return;
    if (!repo) {
      bridge.tama.warn("Open a repository first.");
      return;
    }
    this.resetWizard();
    this.demo = false;
    this.repo = repo;
    this.tamaImg = bridge.TAMA_IMG.alarm;
    this.step = "scope";
    this.open = true;
    bridge.tama.event("mutation.destructive", { label: "git filter-repo" });
  }

  // ── design-mode demo (browser) ─────────────────────────────────────────
  openDemo() {
    this.resetWizard();
    this.demo = true;
    this.tamaImg = bridge.TAMA_IMG.alarm;
    this.step = "scope";
    this.open = true;
  }

  // ── scope -> preview ───────────────────────────────────────────────────
  async runPreview() {
    if (this.busy) return;
    if (this.pathList.length === 0) {
      this.previewError = "Select at least one path to filter.";
      return;
    }
    this.previewError = "";

    if (this.demo) {
      this.preview = { ...DEMO_PREVIEW };
      this.step = "preview";
      return;
    }

    this.busy = true;
    try {
      const r = await commands.filterRepoPreview(this.repo, this.pathList, this.invert);
      if (r.status === "ok") {
        this.preview = r.data;
        this.previewError = "";
        this.step = "preview";
      } else {
        this.preview = null;
        this.previewError = String(r.error ?? "Could not preview the filter-repo scope.");
      }
    } catch (e) {
      this.preview = null;
      this.previewError = "Could not preview the filter-repo scope — " + e;
    } finally {
      this.busy = false;
    }
  }

  backToScope() {
    // Defense-in-depth: the scope step's own Next button already disables via
    // canPreview's `!busy`, so this only matters if a future caller wires Back
    // up somewhere reachable mid-request.
    if (this.busy) return;
    this.step = "scope";
  }

  proceedToConfirm() {
    if (!this.canProceedToConfirm) return;
    this.confirmText = "";
    this.step = "confirm";
  }

  backToPreview() {
    // The confirm step's Back button stays clickable for the ENTIRE duration
    // of runFilterRepo() (step doesn't change to "result" until it resolves),
    // so without this guard a user could navigate away mid-rewrite and then
    // get yanked back to "result" out of nowhere once the awaited call
    // finally settles. See FilterRepo.svelte, which also disables the button.
    if (this.busy) return;
    this.step = "preview";
  }

  // ── confirm -> run ─────────────────────────────────────────────────────
  async runFilterRepo() {
    if (this.busy) return;
    if (!this.canRun) return;

    if (this.demo) {
      this.busy = true;
      this.tamaImg = bridge.TAMA_IMG.thinking;
      this.result = {
        ok: true,
        message: `History rewritten (${DEMO_PREVIEW.totalCommits} → ${
          DEMO_PREVIEW.totalCommits - DEMO_PREVIEW.touchedCommits
        } commits). A verified backup was saved — use Restore if anything looks wrong. (demo)`,
        backupBundle: "/repo/.git/gitgui/filter-repo-backups/demo.bundle",
        commitsBefore: DEMO_PREVIEW.totalCommits,
        commitsAfter: DEMO_PREVIEW.totalCommits - DEMO_PREVIEW.touchedCommits,
      };
      this.step = "result";
      this.tamaImg = bridge.TAMA_IMG.happy;
      bridge.tama.set("celebrate");
      bridge.tama.say(this.result.message, 4200);
      await bridge.reloadGraph(true);
      this.busy = false;
      return;
    }

    this.busy = true;
    this.tamaImg = bridge.TAMA_IMG.thinking;
    try {
      const res = await commands.filterRepoRun(this.repo, this.pathList, this.invert);
      this.result = res;
      this.step = "result";
      if (res.ok) {
        await bridge.reloadGraph(true); // HEAD/history changed
        this.tamaImg = bridge.TAMA_IMG.happy;
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "History rewritten.", 4200);
        bridge.cheer('History rewritten. <span class="jp">よし!</span>');
      } else {
        this.tamaImg = bridge.TAMA_IMG.shocked;
        bridge.tama.warn(res.message || "filter-repo failed — see the result below.");
      }
    } catch (e) {
      this.result = {
        ok: false,
        message: "filter-repo failed — " + e,
        backupBundle: null,
        commitsBefore: null,
        commitsAfter: null,
      };
      this.step = "result";
      this.tamaImg = bridge.TAMA_IMG.shocked;
      bridge.tama.warn(this.result.message);
    } finally {
      this.busy = false;
    }
  }

  // ── restore view ───────────────────────────────────────────────────────
  // Reachable two ways: (a) as a secondary entry point — legacy/main.ts calls
  // this directly with a repo path when the wizard isn't already open
  // (IN_TAURI-gated the same way as `start`, vs. `openRestoreDemo`); (b) from
  // a button inside an already-open wizard (scope/result step), where the
  // Svelte view calls this with no args and it just keeps the wizard's
  // current demo/repo state.
  async openRestore(repo?: string) {
    if (repo !== undefined) {
      this.demo = false;
      this.repo = repo;
    }
    this.tamaImg = bridge.TAMA_IMG.alarm;
    this.selectedBackupId = null;
    this.restoreConfirmText = "";
    this.restoreResult = null;
    this.step = "restore";
    this.open = true;
    await this.refreshBackups();
  }

  // Demo-mode counterpart to `openRestore` — see module header on the
  // real-vs-demo split.
  async openRestoreDemo() {
    this.demo = true;
    this.tamaImg = bridge.TAMA_IMG.alarm;
    this.selectedBackupId = null;
    this.restoreConfirmText = "";
    this.restoreResult = null;
    this.step = "restore";
    this.open = true;
    await this.refreshBackups();
  }

  async refreshBackups() {
    if (this.demo) {
      this.backups = DEMO_BACKUPS.map((b) => ({ ...b }));
      this.backupsError = "";
      return;
    }
    if (!this.repo) {
      this.backups = [];
      this.backupsError = "";
      return;
    }
    this.backupsLoading = true;
    try {
      const r = await commands.filterRepoListBackups(this.repo);
      if (r.status === "ok") {
        this.backups = r.data;
        this.backupsError = "";
      } else {
        this.backups = [];
        this.backupsError = String(r.error ?? "Could not list backups.");
      }
    } catch (e) {
      this.backups = [];
      this.backupsError = "Could not list backups — " + e;
    } finally {
      this.backupsLoading = false;
    }
  }

  selectBackup(id: string) {
    if (this.restoreBusy) return;
    if (this.selectedBackupId === id) return;
    this.selectedBackupId = id;
    this.restoreConfirmText = "";
    this.restoreResult = null;
  }

  async runRestore() {
    if (this.restoreBusy) return;
    if (!this.canRestore || !this.selectedBackupId) return;

    if (this.demo) {
      this.restoreBusy = true;
      this.tamaImg = bridge.TAMA_IMG.thinking;
      this.restoreResult = {
        ok: true,
        message: `Restored ${DEMO_BACKUPS[0].refCount}/${DEMO_BACKUPS[0].refCount} ref(s) from backup ${this.selectedBackupId}. (demo)`,
        backupBundle: DEMO_BACKUPS[0].bundlePath,
        commitsBefore: null,
        commitsAfter: DEMO_PREVIEW.totalCommits,
      };
      this.tamaImg = bridge.TAMA_IMG.confident;
      bridge.tama.set("celebrate");
      bridge.tama.say(this.restoreResult.message, 4200);
      await bridge.reloadGraph(true);
      this.restoreBusy = false;
      return;
    }

    this.restoreBusy = true;
    this.tamaImg = bridge.TAMA_IMG.thinking;
    try {
      const res = await commands.filterRepoRestore(this.repo, this.selectedBackupId);
      this.restoreResult = res;
      if (res.ok) {
        await bridge.reloadGraph(true); // HEAD/history changed back
        this.tamaImg = bridge.TAMA_IMG.confident;
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Restored.", 4200);
        bridge.cheer("Backup restored.");
      } else {
        this.tamaImg = bridge.TAMA_IMG.shocked;
        bridge.tama.warn(res.message || "Restore failed — try again.");
      }
    } catch (e) {
      this.restoreResult = {
        ok: false,
        message: "Restore failed — " + e,
        backupBundle: null,
        commitsBefore: null,
        commitsAfter: null,
      };
      this.tamaImg = bridge.TAMA_IMG.shocked;
      bridge.tama.warn(this.restoreResult.message);
    } finally {
      this.restoreBusy = false;
    }
  }

  // ── modal lifecycle ────────────────────────────────────────────────────
  private resetWizard() {
    this.step = "scope";
    this.pathsText = "";
    this.invert = true;
    this.preview = null;
    this.previewError = "";
    this.confirmText = "";
    this.result = null;
    this.backups = [];
    this.backupsError = "";
    this.backupsLoading = false;
    this.selectedBackupId = null;
    this.restoreConfirmText = "";
    this.restoreResult = null;
    this.busy = false;
    this.restoreBusy = false;
  }

  close() {
    this.open = false;
    this.resetWizard();
  }
}

export const filterRepoCtrl = new FilterRepoState();
