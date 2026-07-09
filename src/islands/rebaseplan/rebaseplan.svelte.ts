// Interactive-rebase planner — controller (Svelte 5 runes singleton).
//
// Pre-flight surface for `rebase_interactive_start`: list the plannable
// (non-merge) commits between `onto` and HEAD via `rebase_interactive_plan`
// (read-only, no snapshot — see git_rebase.rs), let the user reorder rows and
// assign a per-row action (pick/squash/fixup/drop/edit), then send the whole
// plan back as one `TodoItem[]` to `rebase_interactive_start`.
//
// Shape precedent: closer to the Resolver's single-view "list + per-row
// action, then one commit action" shape than SetupWizard's multi-step wizard
// — there is no sequential-concern structure here, just one continuous
// editing surface (see this app's design notes for the full rationale).
// Reordering/assigning actions is PURE client-side array manipulation (no
// backend round trip) until `start()` — the whole point of a pre-flight plan
// — mirroring the Resolver's own "local state until you commit to an action"
// feel.
//
// `busy` spans the WHOLE native round trip for both `openFor()` (the
// rebase_interactive_plan read) and `start()` (the rebase_interactive_start
// write), matching SetupWizard's `pickDirectory()` discipline (busy wraps the
// entire native-call-plus-validate span, not just an inner slice) and this
// codebase's general loading-indicator sweep (commit 5d0ab24).
//
// Conflict/editing handoff: `start()`'s non-"clean"/"empty" outcomes do NOT
// duplicate the three-way-diff/editing-banner UI here — they call
// `resolver.openFromResult(...)`, the same shared entry point the plain
// branch-menu "Rebase current branch onto here" action funnels into via
// `resolver.startRebase()`. There is exactly ONE conflict/editing-resolution
// UI regardless of which of the two rebase entry points produced the result.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { resolver } from "../resolver/resolver.svelte.ts";
import { IN_TAURI } from "../../ipc/env";
import type { PlanCommit, RebaseResult, TodoItem } from "../../ipc/bindings";

export type PlanAction = "pick" | "squash" | "fixup" | "drop" | "edit";
export type PlanRow = PlanCommit & { action: PlanAction };

// Demo data (design-mode only) — a small canned three-commit plan, same
// spirit as every other island's DEMO constants, so the browser preview still
// shows a populated planner without a real backend.
const DEMO_PLAN: PlanCommit[] = [
  { sha: "1111111111111111111111111111111111111111", shortSha: "1111111", subject: "Add login form skeleton" },
  { sha: "2222222222222222222222222222222222222222", shortSha: "2222222", subject: "Wire submit handler to API" },
  { sha: "3333333333333333333333333333333333333333", shortSha: "3333333", subject: "Fix typo in error copy" },
];

class RebasePlanState {
  open = $state(false);
  busy = $state(false);
  demo = $state(false);
  onto = $state(""); // the target ref name, for the header/label
  rows = $state<PlanRow[]>([]);

  // Not private — mirrors resolver.svelte.ts's own `repo`/`sha` fields (plain,
  // directly settable by tests that want to exercise start()/setAction()/
  // reorder() without first driving a full openFor() round trip).
  repo = "";

  get canStart(): boolean {
    return this.rows.length > 0 && !this.busy;
  }

  // Opens the planner for `repo` rebasing its current branch onto `onto` —
  // the branch-menu's "Interactive rebase onto here…" entry point (see
  // sidebar.svelte.ts's `interactiveRebaseOnto`).
  async openFor(repo: string, onto: string) {
    if (this.busy) return;
    if (!IN_TAURI) {
      this.demo = true;
      this.repo = repo || "";
      this.onto = onto;
      this.rows = DEMO_PLAN.map((c) => ({ ...c, action: "pick" as PlanAction }));
      this.open = true;
      return;
    }
    if (!repo) {
      bridge.tama.warn("Open a repository first.");
      return;
    }
    this.demo = false;
    this.repo = repo;
    this.onto = onto;
    this.busy = true;
    try {
      const r = await commands.rebaseInteractivePlan(repo, onto);
      if (r.status === "ok") {
        if (!r.data.length) {
          bridge.tama.set("hint");
          bridge.tama.say("Already up to date with " + onto + " — nothing to plan.", 4200);
          return;
        }
        this.rows = r.data.map((c) => ({ ...c, action: "pick" as PlanAction }));
        this.open = true;
      } else {
        bridge.tama.warn(r.error || "Could not list commits to plan.");
      }
    } catch (e) {
      bridge.tama.warn("Could not list commits to plan — " + e);
    } finally {
      this.busy = false;
    }
  }

  close() {
    this.open = false;
    this.rows = [];
  }

  // Plain array splice — no backend round trip (see module doc). Both indices
  // are bounds-checked so a stray drag event (e.g. dropped outside any row)
  // is silently ignored rather than corrupting `rows`.
  reorder(fromIndex: number, toIndex: number) {
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= this.rows.length ||
      toIndex >= this.rows.length
    )
      return;
    const next = this.rows.slice();
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    this.rows = next;
  }

  // Client-side mirror of the backend's own reject-first-squash/fixup rule
  // (git_rebase.rs's `rebase_interactive_start`) — belt-and-suspenders, same
  // "validate both client- and server-side" pattern as e.g. armDanger's
  // typed-confirm plus the backend command's own checks.
  setAction(sha: string, action: PlanAction) {
    const idx = this.rows.findIndex((r) => r.sha === sha);
    if (idx < 0) return;
    if (idx === 0 && (action === "squash" || action === "fixup")) return;
    this.rows = this.rows.map((r, i) => (i === idx ? { ...r, action } : r));
  }

  private todoItems(): TodoItem[] {
    return this.rows.map((r) => ({ sha: r.sha, action: r.action }));
  }

  async start() {
    if (this.busy) return;
    if (!this.rows.length) return;
    if (this.demo) {
      this.close();
      bridge.tama.set("celebrate");
      bridge.tama.say("Interactive rebase applied (demo).", 3200);
      bridge.cheer('Interactive rebase complete. <span class="jp">よし!</span>');
      return;
    }
    const repo = this.repo;
    const onto = this.onto;
    const todo = this.todoItems();
    this.busy = true;
    bridge.tama.event("mutation.caution", { count: this.rows.length });
    try {
      const res = await commands.rebaseInteractiveStart(repo, onto, todo);
      await this.applyOutcome(res);
    } catch (e) {
      bridge.tama.warn("Interactive rebase failed — " + e);
    } finally {
      this.busy = false;
    }
  }

  private async applyOutcome(res: RebaseResult) {
    switch (res.state) {
      case "clean":
        this.close();
        await bridge.reloadGraph(true);
        bridge.tama.event("snapshot.surfaced");
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Interactive rebase complete.", 4200);
        bridge.cheer('Interactive rebase complete. <span class="jp">よし!</span>');
        break;
      case "empty":
        this.close();
        await bridge.reloadGraph(true);
        bridge.tama.set("hint");
        bridge.tama.say(res.message || "Already up to date — nothing to rebase.", 4200);
        break;
      case "conflict":
      case "editing":
        // Hand off to the SAME shared conflict/editing UI the plain
        // branch-menu rebase uses — see this module's doc comment.
        this.close();
        await resolver.openFromResult(this.repo, res, this.onto, "rebase");
        break;
      default: // "error"
        bridge.tama.warn(res.message || "Interactive rebase could not start.");
        break;
    }
  }
}

export const rebasePlanCtrl = new RebasePlanState();
