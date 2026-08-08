// Export Patches — controller (Svelte 5 runes singleton).
//
// Tools-menu/⌘K "Export Patches…" — the RANGE-export path fronting patch.rs's
// `export_patch` for the "share a whole feature branch as one mbox file"
// case. The commit-menu's single-commit "Export as Patch…"
// (commitmenu.svelte.ts's `exportAsPatch()`) calls the SAME backend command
// with `from: null` (its own `-1 <sha>` single-commit mode) — this modal only
// covers the two-revision range case, which needs a form rather than a
// canvas gesture (there's no multi-select commit-range picker on the canvas
// — see the design doc's own reasoning for why one wasn't invented for this).
//
// A real .scrim/.modal, opened on demand, same shape as Remotes/Rerere/
// Reflog/Plumbing (see those controllers' own `show()`s) — NOT a fifth
// resolver op: nothing here can conflict (export never touches the repo, see
// patch.rs's own "no snapshot" doc note), so there is no hand-off to
// resolver.svelte.ts at all, unlike applypatch.svelte.ts's `apply_patch`.
//
// "From" defaults to the current branch's upstream (`current_upstream`,
// added earlier in this backlog) when one is configured, else blank (the
// user must type one — an empty "from" is a validation error, exactly like
// leaving "to" blank would be: this modal is range-only, there is no
// "from omitted means single-commit" shortcut here the way the backend's own
// `from: Option<String>` has for the commit-menu's call). "To" always
// defaults to "HEAD". Both are plain revision strings, validated the same
// shallow way every other revision-accepting frontend input in this codebase
// is (non-empty, no leading dash) — the backend's own `validate_rev` is the
// real guard; this only gives a faster, clearer in-form error before a round
// trip to save() even runs.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import { save } from "@tauri-apps/plugin-dialog";
import { t } from "@/i18n/i18n.svelte.ts";

// Mirrors patch.rs's own `validate_rev` shape (empty / leading-dash) — a
// clearer, immediate in-form error rather than waiting on a round trip for
// the backend to say the same thing.
function revError(label: string, s: string): string {
  const v = s.trim();
  if (!v) return t("exportpatches.err_enter_rev", { label });
  if (v.startsWith("-")) return t("exportpatches.err_leading_dash", { label });
  return "";
}

// A safe default filename fragment from a revision string — strips anything
// that isn't filename-safe (a revision can contain `/`, `~`, `^`, `:`, …).
function fileSafe(rev: string): string {
  const s = rev.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "patches";
}

class ExportPatchesState {
  open = $state(false);
  from = $state("");
  to = $state("HEAD");
  busy = $state(false);
  error = $state("");

  repo = "";

  // Entry point (Tools menu / ⌘K). Always resets the form and re-derives the
  // "from" default from the CURRENT upstream — never carries over a stale
  // value from a previous open, same "always re-fetch rather than cache"
  // discipline reflog/rerere/remotes' own `show()`s already use.
  show(repo: string | null): void {
    this.repo = repo || "";
    this.to = "HEAD";
    this.from = "";
    this.error = "";
    this.busy = false;
    this.open = true;
    if (IN_TAURI && this.repo) void this.loadUpstreamDefault(this.repo);
  }

  private async loadUpstreamDefault(repo: string): Promise<void> {
    try {
      const r = await commands.currentUpstream(repo);
      // Only fill in the default if the user hasn't already typed something
      // while this round trip was in flight, and the modal is still open for
      // the SAME repo it was requested for.
      if (r.status === "ok" && r.data && this.open && this.repo === repo && !this.from) this.from = r.data;
    } catch (e) {
      console.error("current_upstream", e);
    }
  }

  close(): void {
    if (this.busy) return;
    this.open = false;
  }

  async confirm(): Promise<void> {
    if (this.busy) return;
    const repo = this.repo;
    if (!repo) {
      bridge.tama.warn(t("exportpatches.open_repo_first"));
      return;
    }
    const from = this.from.trim();
    const to = this.to.trim();
    const fromErr = revError("From", from);
    if (fromErr) {
      this.error = fromErr;
      return;
    }
    const toErr = revError("To", to);
    if (toErr) {
      this.error = toErr;
      return;
    }
    this.error = "";
    if (!IN_TAURI) {
      this.open = false;
      bridge.tama.set("celebrate");
      bridge.tama.say(t("exportpatches.say_demo"));
      return;
    }
    let dest: string | null;
    try {
      dest = await save({
        title: t("exportpatches.dlg_export"),
        defaultPath: fileSafe(from) + ".." + fileSafe(to) + ".patch",
        filters: [{ name: "Patch files", extensions: ["patch"] }],
      });
    } catch (e) {
      this.error = t("exportpatches.err_save_dialog", { e: String(e) });
      return;
    }
    if (!dest) return; // user cancelled the dialog — leave the form as-is
    this.busy = true;
    bridge.tama.set("thinking");
    bridge.tama.say(t("exportpatches.say_exporting"));
    try {
      const res = await commands.exportPatch(repo, from, to, dest);
      if (res && res.ok) {
        this.open = false;
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || t("exportpatches.say_exported"), 3600);
      } else {
        this.error = (res && res.message) || t("exportpatches.err_export");
      }
    } catch (e) {
      this.error = t("exportpatches.err_export_e", { e: String(e) });
    } finally {
      this.busy = false;
    }
  }
}

export const exportPatchesCtrl = new ExportPatchesState();
