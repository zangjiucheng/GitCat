// Commit-row context menu — controller (Svelte 5 runes singleton).
//
// The canvas has never had a right-click menu on a commit row (cherry-pick/
// merge only exist as a drag gesture, and revert only as a Detail-panel
// button) — this island is that menu. It is a NEW entry point onto the SAME
// capabilities those already have, not a new capability of its own:
// cherryPick()/merge()/revert() below call the exact same
// resolver.startPick/startMerge/startRevert (or resolver.openDemo in design
// mode) that legacy/main.ts's own cherryPick(src,dst)/mergeCommit(src,dst) and
// detail.svelte.ts's revertCommit() already call — see this file's own
// methods for the identical IN_TAURI gate. startBranchHere/startTagHere ->
// confirmBranch/confirmTag call the exact same commands.createBranch/
// createTag sidebar.svelte.ts's confirmNewBranch/confirmNewTag already call,
// just with the right-clicked commit's sha as the start point/target instead
// of HEAD (confirmBranch still passes checkout:true, matching this app's
// "create + immediately switch to it" convention for every branch creation).
//
// ── two-phase popover design ─────────────────────────────────────────────
// One popover, `.view` picks which of two "pages" it shows:
//   "menu"   — the action list (Cherry-pick/Merge/Revert/Create branch
//              here…/Create tag here…/the three Copy actions).
//   "branch" | "tag" — the name-input sub-form shown after clicking "Create
//              branch/tag here…" (mirrors Sidebar.svelte's "+ New Branch…"/
//              "+ New Tag…" inline forms, just nested one level inside this
//              popover instead of inline in a list). cancelBranchForm/
//              cancelTagForm step back to "menu" (NOT a full close()) — same
//              two-step Escape/outside-click semantics CommitMenu.svelte
//              implements: Escape/outside-click from a sub-view backs out to
//              the menu, from the menu itself it closes the whole popover.
//
// ── "capture into a local before closing" discipline ─────────────────────
// close() resets EVERY field below (mirrors sidebarCtrl.closeMenu() nulling
// `.menu` outright) — so any action that needs `.repo`/`.sha` AFTER calling
// close() must read them into a local first, exactly like Sidebar.svelte's
// popover buttons capture `menu.name` before calling `sidebarCtrl.closeMenu()`.
// cherryPick()/merge()/revert() close the menu immediately (no async
// round-trip needs it open), so they capture repo/sha up front.
// confirmBranch()/confirmTag() instead mirror confirmNewBranch/confirmNewTag's
// OWN convention of keeping the form open (busy, spinnered) for the duration
// of the request and only closing on success — repo/sha/name/message are read
// into locals at the very top of each method regardless, so this reduces to
// the same discipline either way.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { resolver } from "../resolver/resolver.svelte.ts";
import { resetHeadCtrl } from "../resethead/resethead.svelte.ts";
// Reused for the "Switch to <branch>" action — see checkout() below. Only
// referenced inside a method (never at module init), so the sidebar<->commitmenu
// import cycle resolves fine by the time it's actually called.
import { sidebarCtrl } from "../sidebar/sidebar.svelte.ts";
import { IN_TAURI } from "../../ipc/env";
import { save } from "@tauri-apps/plugin-dialog";
import { copyToClipboard } from "../../legacy/clipboard.ts";

type MenuView = "menu" | "branch" | "tag";

// <short-sha>-<slug-of-subject>.patch — the save() dialog's suggested default
// filename for exportAsPatch() below. Lowercased, non-alphanumeric runs
// collapsed to a single hyphen, leading/trailing hyphens trimmed, capped at
// 40 chars (a long subject shouldn't produce an unwieldy filename) — falls
// back to "patch" for a subject with no alphanumeric characters at all so the
// filename is never just "<sha>-.patch".
function slugify(subject: string): string {
  const s = (subject || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s || "patch";
}

class CommitMenuState {
  open = $state(false);
  view = $state<MenuView>("menu");
  // Fixed viewport position (clientX/clientY of the right-click) — CommitMenu.svelte
  // renders at exactly this point, same idea as sidebarCtrl.menu's x/y.
  x = $state(0);
  y = $state(0);

  // The right-clicked commit. Captured once by openAt(); close() blanks all of
  // these back out (see the module doc's "capture into a local" note above).
  repo = $state("");
  sha = $state("");
  shortSha = $state(""); // derived from `sha` by openAt() — never passed in separately
  subject = $state("");
  isMerge = $state(false);
  // Local branches sitting ON the right-clicked row (passed by openAt) — rendered
  // as "Switch to <branch>" checkout actions. Empty for a row with no local
  // branch, or the current branch (which arrives as kind "head", filtered out).
  branches = $state<string[]>([]);

  // "branch"/"tag" sub-view input fields.
  branchName = $state("");
  tagName = $state("");
  tagMessage = $state("");

  // Re-entrancy guard for the real (IN_TAURI) IPC round-trip of EVERY
  // mutating action here (cherryPick/merge/revert/confirmBranch/confirmTag)
  // — mirrors resolver.busy/sidebarCtrl.busy. CommitMenu.svelte also reads
  // this to block outside-click-to-close while a request is in flight, same
  // as Sidebar.svelte's onWindowPointerdown does for the New Branch/New Tag
  // forms.
  busy = $state(false);
  // Status text shown next to the spinner while `busy` is true for
  // cherryPick/merge/revert specifically (confirmBranch/confirmTag show
  // their own "Creating…" via Tama instead — see those methods). Loading-
  // indicator audit fix: these three used to call close() BEFORE awaiting
  // the real operation, so the popover vanished instantly with zero visual
  // feedback for the whole round-trip — the only cue was Tama's easy-to-miss
  // corner animation (see commit 5d0ab24's own framing of that exact gap for
  // every OTHER surface in the app). Now they stay open, busy, spinnered —
  // same as confirmBranch/confirmTag already correctly do — and close only
  // once the operation actually resolves.
  pendingLabel = $state("");

  // Opens the menu for one right-clicked commit — the canvas's contextmenu
  // handler (legacy/main.ts) is the only real caller. `sha` is always resolved
  // there the SAME way cherryPick()/mergeCommit() resolve theirs
  // (BACKEND.rows[row].sha, falling back to hhex(row) in design mode), so
  // openAt itself does no BACKEND/G lookups of its own. `subject` similarly
  // comes straight from the caller's own msgOf(row) — never re-derived here.
  //
  // Guarded on `busy`: while a PREVIOUS commit's create-branch/create-tag
  // request is still in flight (busy===true), right-clicking a different row
  // must NOT retarget this popover — doing so would blow away `repo`/`sha`
  // and reset `busy` back to false out from under the still-running request,
  // letting a second mutating action fire before the first has resolved
  // (the exact thing `busy` exists to prevent). This mirrors
  // CommitMenu.svelte's own onWindowPointerdown/onWindowKeydown, which
  // already refuse to close()/cancel*Form() while busy, and confirmBranch/
  // confirmTag's own `if (this.busy) return;` re-entrancy guards — same
  // "busy means silently ignore this interaction" discipline as a disabled
  // button, just applied here to the one remaining entry point that used to
  // skip it. The in-flight request itself isn't misdirected either way (it
  // already captured repo/sha into locals before this call), but a second
  // right-click could otherwise arm a second concurrent request.
  openAt(repo: string, sha: string, subject: string, isMerge: boolean, x: number, y: number, branches: string[] = []) {
    if (this.busy) return;
    this.repo = repo || "";
    this.sha = sha || "";
    this.shortSha = this.sha.slice(0, 7);
    this.subject = subject || "";
    this.isMerge = !!isMerge;
    this.branches = branches || [];
    this.x = x;
    this.y = y;
    this.view = "menu";
    this.branchName = "";
    this.tagName = "";
    this.tagMessage = "";
    this.busy = false;
    this.pendingLabel = "";
    this.open = true;
  }

  close() {
    this.open = false;
    this.view = "menu";
    this.repo = "";
    this.sha = "";
    this.shortSha = "";
    this.subject = "";
    this.isMerge = false;
    this.branches = [];
    this.branchName = "";
    this.tagName = "";
    this.tagMessage = "";
    this.busy = false;
    this.pendingLabel = "";
  }

  // Switch to a local branch sitting on the right-clicked row. Reuses the
  // sidebar's full checkout flow (reload, dirty-tree resolution chooser, error
  // toasts, demo mode) rather than reimplementing it. Capture the popover
  // position before close() blanks it so the sidebar's own dirty-checkout menu,
  // if it opens, anchors near where the user clicked.
  checkout(name: string) {
    if (this.busy) return;
    const pos = { x: this.x, y: this.y };
    this.close();
    void sidebarCtrl.checkout(name, pos);
  }

  // ── mutating actions (menu view) ────────────────────────────────────────

  // Cherry-pick the right-clicked commit onto HEAD. Guarded on isMerge — same
  // "can't cherry-pick a merge" rule the drag gesture enforces via legalPick
  // in legacy/main.ts (G.isMerge[src] => reject) — a merge commit's
  // Cherry-pick entry is disabled in the view rather than hidden (see
  // CommitMenu.svelte), so reaching here at all would mean the view's own
  // guard was bypassed; this is the belt-and-braces backstop, same shape as
  // detailCtrl.revertCommit()'s `if (!c || c.merge) return;`.
  async cherryPick() {
    if (this.isMerge || this.busy) return;
    const repo = this.repo, sha = this.sha;
    if (!IN_TAURI) {
      this.close();
      resolver.openDemo(sha); // ---- design-mode demo ----
      return;
    }
    this.busy = true;
    this.pendingLabel = "Cherry-picking…";
    try {
      await resolver.startPick(repo, sha, false); // ---- real pick onto HEAD (Svelte island) ----
    } finally {
      this.close(); // done (clean/conflict-opened-Resolver/error-toasted) — nothing left for this popover to show
    }
  }

  // Merge the right-clicked commit/branch tip into HEAD. Deliberately NO
  // isMerge guard — merging a merge commit's tip is legal (mirrors
  // legacyMerge's own legalMerge, and git_merge.rs's documented reasoning).
  async merge() {
    if (this.busy) return;
    const repo = this.repo, sha = this.sha;
    if (!IN_TAURI) {
      this.close();
      resolver.openDemo(sha, "merge"); // ---- design-mode demo ----
      return;
    }
    this.busy = true;
    this.pendingLabel = "Merging…";
    try {
      await resolver.startMerge(repo, sha); // ---- real merge into HEAD (Svelte island) ----
    } finally {
      this.close();
    }
  }

  // Revert the right-clicked commit onto HEAD. Guarded on isMerge for the
  // SAME reason as detailCtrl's revertDisabled/revertCommit: revert_start
  // doesn't support `-m`/`--mainline`, so a merge commit would otherwise take
  // a real safety snapshot before failing on git's raw stderr.
  async revert() {
    if (this.isMerge || this.busy) return;
    const repo = this.repo, sha = this.sha;
    if (!IN_TAURI) {
      this.close();
      resolver.openDemo(sha, "revert"); // ---- design-mode demo ----
      return;
    }
    this.busy = true;
    this.pendingLabel = "Reverting…";
    try {
      await resolver.startRevert(repo, sha); // ---- real revert onto HEAD (Svelte island) ----
    } finally {
      this.close();
    }
  }

  // Export the right-clicked commit as a single mbox `.patch` file (backend:
  // patch.rs's `export_patch` with `from: null`, its own `-1 <sha>`
  // single-commit mode). Guarded on isMerge for the SAME reason the backend
  // itself refuses a merge commit there (see export_patch's own doc comment's
  // "footgun" note: `git format-patch -1 <merge-sha>` silently exports the
  // FIRST PARENT's commit instead of erroring) — this is a fast frontend
  // backstop that avoids a round trip just to get the backend's refusal
  // message; the tooltip on the disabled button explains the same thing.
  // Unlike cherryPick/merge/revert, this closes the menu IMMEDIATELY (no
  // spinner/pendingLabel kept-open state): the native save() dialog is its
  // own blocking modal already, and export never mutates the repo (pure
  // read + external file write), so there is nothing for the popover to stay
  // open and show. Mirrors the copy actions' "capture into locals, close
  // right away" shape, just with an async tail after the close.
  async exportAsPatch() {
    if (this.isMerge || this.busy) return;
    const repo = this.repo,
      sha = this.sha,
      shortSha = this.shortSha,
      subject = this.subject;
    this.close();
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say("Exported " + shortSha + " as a patch (demo).");
      return;
    }
    let dest: string | null;
    try {
      dest = await save({
        title: "Export Patch",
        defaultPath: shortSha + "-" + slugify(subject) + ".patch",
        filters: [{ name: "Patch files", extensions: ["patch"] }],
      });
    } catch (e) {
      bridge.tama.warn("Could not open the save dialog — " + e);
      console.error(e);
      return;
    }
    if (!dest) return; // user cancelled the dialog
    bridge.tama.set("thinking");
    bridge.tama.say("Exporting " + shortSha + "…");
    try {
      const res = await commands.exportPatch(repo, null, sha, dest);
      if (res && res.ok) {
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Exported " + shortSha + ".", 3600);
      } else {
        bridge.tama.warn((res && res.message) || "Could not export " + shortSha + ".");
      }
    } catch (e) {
      bridge.tama.warn("Export failed — " + e);
      console.error(e);
    }
  }

  // Reset HEAD (current branch) to the right-clicked commit. Deliberately NO
  // isMerge guard — `git reset` to a merge commit is perfectly legal. This is
  // the one destructive action here that MOVES your branch rather than adding a
  // commit, so unlike cherryPick/merge/revert it hands off to resetHeadCtrl's
  // own typed-confirm danger scrim (mode picker + snapshot warning) rather than
  // running immediately: close this popover first, then arm that. Captures
  // repo/sha/shortSha/subject into locals before close() blanks them (same
  // "capture into a local before closing" discipline as exportAsPatch/copy*).
  resetHere() {
    if (this.busy) return;
    const repo = this.repo, sha = this.sha, shortSha = this.shortSha, subject = this.subject;
    this.close();
    resetHeadCtrl.resetToKnownCommit(repo, sha, shortSha, subject);
  }

  // ── copy actions (menu view) — clipboard-only, no IN_TAURI gate needed:
  // navigator.clipboard works identically in the plain-browser design-mode
  // shell and inside the Tauri webview. Each closes the menu afterward, same
  // as every other menu-item click (standard context-menu UX — there's no
  // "stay open, show a copied ✓ toast" affordance here the way
  // sidebarCtrl.copySnapshotSha's inline sha chip has, since the whole
  // popover is about to go away anyway). ────────────────────────────────────
  copyShortSha() {
    if (this.busy) return;
    copyToClipboard(this.shortSha);
    this.close();
  }

  copyFullSha() {
    if (this.busy) return;
    copyToClipboard(this.sha);
    this.close();
  }

  copyMessage() {
    if (this.busy) return;
    copyToClipboard(this.subject);
    this.close();
  }

  // ── "Create branch here…" sub-view ──────────────────────────────────────

  startBranchHere() {
    if (this.busy) return;
    this.branchName = "";
    this.view = "branch";
  }

  // Steps back to the menu view (NOT a full close()) — same "outside-
  // click/Escape back out of the sub-form" affordance Sidebar.svelte's own
  // New Branch/New Tag forms have, just one level nested here (see the module
  // doc's "two-phase popover design" note).
  cancelBranchForm() {
    this.view = "menu";
    this.branchName = "";
  }

  // Mirrors sidebar.svelte.ts's confirmNewBranch exactly (blank-name guard,
  // demo-mode message, keep-the-form-open-while-busy, reloadGraph+cheer on
  // success) with ONE difference: `from` is always the right-clicked commit's
  // sha (never null/HEAD) and is passed unconditionally — this branch is
  // being created AT that historical commit, not at HEAD. `checkout` is still
  // always `true`, matching confirmNewBranch's own "create + immediately
  // switch to it" convention even though the checkout target here is a
  // historical commit rather than HEAD.
  async confirmBranch() {
    const name = this.branchName.trim();
    if (!name) {
      this.cancelBranchForm();
      return;
    }
    if (this.busy) return;
    const repo = this.repo, sha = this.sha, shortSha = this.shortSha;
    if (!IN_TAURI) {
      this.close();
      bridge.tama.set("hint");
      bridge.tama.say("Created " + name + " at " + shortSha + " (demo).");
      return;
    }
    this.busy = true;
    bridge.tama.set("thinking");
    bridge.tama.say("Creating " + name + "…");
    try {
      const res = await commands.createBranch(repo, name, sha, true);
      if (res && res.ok) {
        this.close();
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Branch " + name + " created.", 3200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't create " + name + ".");
      }
    } catch (e) {
      bridge.tama.warn("Create failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
    }
  }

  // ── "Create tag here…" sub-view ─────────────────────────────────────────

  startTagHere() {
    if (this.busy) return;
    this.tagName = "";
    this.tagMessage = "";
    this.view = "tag";
  }

  cancelTagForm() {
    this.view = "menu";
    this.tagName = "";
    this.tagMessage = "";
  }

  // Mirrors confirmNewTag exactly, same "target is always the right-clicked
  // sha, never null/HEAD" difference confirmBranch has above.
  async confirmTag() {
    const name = this.tagName.trim();
    if (!name) {
      this.cancelTagForm();
      return;
    }
    if (this.busy) return;
    const repo = this.repo, sha = this.sha, shortSha = this.shortSha;
    const message = this.tagMessage.trim() || null; // "" -> lightweight tag
    if (!IN_TAURI) {
      this.close();
      bridge.tama.set("hint");
      bridge.tama.say("Created tag " + name + " at " + shortSha + " (demo).");
      return;
    }
    this.busy = true;
    bridge.tama.set("thinking");
    bridge.tama.say("Creating tag " + name + "…");
    try {
      const res = await commands.createTag(repo, name, sha, message);
      if (res && res.ok) {
        this.close();
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Tag " + name + " created.", 3200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't create tag " + name + ".");
      }
    } catch (e) {
      bridge.tama.warn("Create failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
    }
  }
}

export const commitMenuCtrl = new CommitMenuState();
