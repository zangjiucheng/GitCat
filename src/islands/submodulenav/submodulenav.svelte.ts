// Submodule NAVIGATOR — the slim strip under the topbar (+ its full-tree
// popover) for moving between a superproject and its submodules WITHOUT the old
// parent-only "← Back" button. It's purely a switch-between-repos surface; every
// submodule MUTATION (init/update/sync/add/remove) still lives in the sidebar's
// Submodules section.
//
// Navigation is dead simple now: every jump is just "open that repo".
// legacy/main.ts's openRepo() re-derives NAV_STACK from git's own superproject
// chain (submodule_superproject_chain) and refreshes THIS controller on EVERY
// open — folder picker, dashboard, deep-link, or an in-app sibling/tree/back
// jump alike. So this controller never tracks a chain by hand: it reads
// bridge.NAV_STACK (git's answer: ancestors, root..immediate-parent) and
// bridge.CUR_REPO (both live bindings) to render the breadcrumb + sibling tabs,
// and calls bridge.navigateToRepo(absolutePath) (== openRepo) to move.
import * as bridge from "../../legacy/bridge";
import { commands } from "../../ipc/bindings";
import { IN_TAURI } from "../../ipc/env";
import { submoduleCanOpen } from "../sidebar/sidebar.svelte.ts";
import type { SubmoduleInfo } from "../../ipc/bindings";

function basename(p: string): string {
  return p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;
}
// Tolerant path equality for the "which tab is the current repo" highlight only.
// CUR_REPO (whatever the OS picker / a git-CLI-derived NAV_STACK entry produced)
// and a submodule's git2-built absolutePath can name the SAME dir in slightly
// different spellings — back- vs forward-slashes, a trailing slash, a lower-case
// Windows drive. Normalise those away. A missed match only means the current
// tab isn't dimmed (still harmless/clickable), never a wrong jump.
function samePath(a: string, b: string): boolean {
  const norm = (p: string) =>
    p
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .replace(/^([a-z]):/i, (_m, d) => d.toUpperCase() + ":");
  return norm(a) === norm(b);
}

// Translate a vertical mouse-wheel tick into a horizontal scroll amount (px to
// add to the strip's scrollLeft) for the overflowing submodule nav strip.
// Returns 0 — i.e. "leave the wheel alone" — when the strip doesn't overflow,
// or when the gesture is horizontal-dominant (a trackpad already scrolls a
// horizontal container natively via deltaX; only a plain vertical mouse wheel
// needs the translation). `deltaMode === 1` is line-based scrolling (typical of
// a real mouse wheel); approximate a line as 16px. Pure + testable; the .svelte
// component wires it to the real element and calls preventDefault when nonzero.
export function horizontalWheelDelta(e: {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  scrollWidth: number;
  clientWidth: number;
}): number {
  if (e.scrollWidth <= e.clientWidth) return 0; // nothing to scroll
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return 0; // horizontal-dominant → native
  return e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
}

// One clickable step in the "root › vendor/lib-a › nested" path.
export interface RepoCrumb {
  name: string;
  absolutePath: string;
  current: boolean;
}
// One sibling tab at the current level (or, at the top, the superproject's own
// submodules to dive into).
export interface SiblingTab {
  name: string;
  absolutePath: string;
  status: string;
  canOpen: boolean;
  current: boolean;
}
// A node in the full-tree popover.
export interface TreeNode {
  name: string;
  absolutePath: string;
  status: string; // "" for the synthetic superproject root
  canOpen: boolean;
  current: boolean;
  isRoot: boolean;
  children: TreeNode[];
}

const TREE_MAX_DEPTH = 8; // matches the backend's own recursion guard; also caps a pathological tree

// A tiny stand-in so the browser design-mode preview (IN_TAURI === false) shows
// a representative strip instead of an empty bar.
const DEMO_SIBLINGS: SiblingTab[] = [
  { name: "vendor/lib-a", absolutePath: "/demo/gitcat/vendor/lib-a", status: "clean", canOpen: true, current: false },
  { name: "vendor/lib-b", absolutePath: "/demo/gitcat/vendor/lib-b", status: "dirty", canOpen: true, current: false },
  { name: "third_party/tool", absolutePath: "/demo/gitcat/third_party/tool", status: "out-of-date", canOpen: true, current: false },
];

class SubmoduleNavState {
  path = $state<RepoCrumb[]>([]);
  siblings = $state<SiblingTab[]>([]);
  busy = $state(false);
  busyTarget = $state<string | null>(null);
  // Tree popover.
  treeOpen = $state(false);
  treeLoading = $state(false);
  tree = $state<TreeNode | null>(null);

  // The strip earns its row only when there's something to navigate: you're
  // inside a submodule (path has >1 crumb) OR the current repo has submodules to
  // dive into (siblings non-empty). A plain repo with no submodules → no strip.
  get visible(): boolean {
    return this.path.length > 1 || this.siblings.length > 0;
  }

  private stack(): string[] {
    return (bridge.NAV_STACK as unknown as string[]) || [];
  }
  private cur(): string {
    return (bridge.CUR_REPO as unknown as string) || "";
  }

  // Rebuild the breadcrumb + sibling tabs for wherever the app currently is.
  // openRepo() calls this after it has set NAV_STACK (from git's superproject
  // chain), so it always reflects the real location — never on a timer.
  //
  // `repo` is nullable because this can be called before any repo is open —
  // priming the strip at mount is a legitimate reason to call it with nothing.
  // There is nothing to navigate then, so it resets to the empty strip, the same
  // state `reset()` leaves it in when a repo is closed.
  async refresh(repo: string | null): Promise<void> {
    if (!IN_TAURI) {
      // Design-mode preview: a superproject sitting on three demo submodules.
      this.path = [{ name: "gitcat", absolutePath: "/demo/gitcat", current: true }];
      this.siblings = DEMO_SIBLINGS;
      return;
    }
    // Below the design-mode branch on purpose: there is never a repo in design
    // mode, so guarding first would empty the browser preview.
    if (!repo) {
      this.reset();
      return;
    }
    const stack = this.stack().slice();
    // Breadcrumb: each ancestor, then the current repo (the last, marked current).
    const crumbs: RepoCrumb[] = stack.map((abs) => ({ name: basename(abs), absolutePath: abs, current: false }));
    crumbs.push({ name: basename(repo), absolutePath: repo, current: true });
    this.path = crumbs;

    // Sibling tabs: one level of the current level's parent (root..parent's last,
    // or the repo itself at the top, whose submodules are dive-in targets).
    const listFrom = stack.length ? stack[stack.length - 1] : repo;
    try {
      const res = await commands.submoduleStatus(listFrom);
      const subs: SubmoduleInfo[] = res.status === "ok" ? res.data : [];
      this.siblings = subs.map((s) => ({
        name: s.path,
        absolutePath: s.absolutePath,
        status: s.status,
        canOpen: submoduleCanOpen(s.status),
        current: samePath(s.absolutePath, repo),
      }));
    } catch (e) {
      console.error("submodulenav.refresh", e);
      this.siblings = [];
    }
  }

  // Jump anywhere = open that repo; openRepo re-derives NAV_STACK and refreshes
  // this controller. `key` scopes the row spinner (and guards double-clicks);
  // jumping to the already-open repo is a no-op.
  async jumpTo(absolutePath: string, key: string): Promise<void> {
    if (this.busy) return;
    if (samePath(absolutePath, this.cur())) return; // already here
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say("Switched to " + basename(absolutePath) + " (demo).");
      return;
    }
    this.busy = true;
    this.busyTarget = key;
    try {
      await bridge.navigateToRepo(absolutePath);
    } catch (e) {
      console.error("submodulenav.jumpTo", e);
      bridge.tama.warn("Couldn't switch to " + basename(absolutePath));
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  jumpToCrumb(i: number): Promise<void> {
    const c = this.path[i];
    if (!c || c.current) return Promise.resolve();
    return this.jumpTo(c.absolutePath, "crumb:" + i);
  }

  jumpToSibling(s: SiblingTab): Promise<void> {
    if (s.current || !s.canOpen) return Promise.resolve();
    return this.jumpTo(s.absolutePath, "sib:" + s.absolutePath);
  }

  jumpToNode(n: TreeNode): Promise<void> {
    if (n.current) return Promise.resolve();
    if (!n.isRoot && !n.canOpen) return Promise.resolve();
    this.closeTree();
    return this.jumpTo(n.absolutePath, "node:" + n.absolutePath);
  }

  // Full-tree popover: built eagerly on open by walking submodule_status from the
  // root superproject (NAV_STACK[0] ?? CUR_REPO). Cheap for the small trees this
  // is for; a visited-set + depth cap keep a cyclic/absurd tree bounded, and only
  // openable nodes are descended into.
  async toggleTree(): Promise<void> {
    if (this.treeOpen) {
      this.closeTree();
      return;
    }
    this.treeOpen = true;
    if (!IN_TAURI) {
      const root = "/demo/gitcat";
      this.tree = {
        name: "gitcat", absolutePath: root, status: "", canOpen: true, current: true, isRoot: true,
        children: DEMO_SIBLINGS.map((s) => ({
          name: s.name, absolutePath: s.absolutePath, status: s.status,
          canOpen: s.canOpen, current: false, isRoot: false, children: [],
        })),
      };
      return;
    }
    this.treeLoading = true;
    try {
      const stack = this.stack();
      const root = stack.length ? stack[0] : this.cur();
      const cur = this.cur();
      const children = await this.walk(root, new Set([root]), 0, cur);
      this.tree = {
        name: basename(root), absolutePath: root, status: "",
        canOpen: true, current: samePath(root, cur), isRoot: true, children,
      };
    } catch (e) {
      console.error("submodulenav.toggleTree", e);
      this.tree = null;
    } finally {
      this.treeLoading = false;
    }
  }

  closeTree(): void {
    this.treeOpen = false;
  }

  // No repo open (cold boot / Close Repository): empty everything so the strip's
  // grid row collapses. Mirrors sidebarCtrl.reset()'s role in bootEmpty().
  reset(): void {
    this.path = [];
    this.siblings = [];
    this.busy = false;
    this.busyTarget = null;
    this.treeOpen = false;
    this.tree = null;
  }

  private async walk(absPath: string, visited: Set<string>, depth: number, cur: string): Promise<TreeNode[]> {
    if (depth >= TREE_MAX_DEPTH) return [];
    let subs: SubmoduleInfo[] = [];
    try {
      const res = await commands.submoduleStatus(absPath);
      subs = res.status === "ok" ? res.data : [];
    } catch (e) {
      console.error("submodulenav.walk", absPath, e);
      return [];
    }
    const out: TreeNode[] = [];
    for (const s of subs) {
      const canOpen = submoduleCanOpen(s.status);
      let children: TreeNode[] = [];
      // Descend only into openable, not-yet-visited nodes — a cycle guard AND
      // the natural stop for uninitialised/removed/unreadable rows.
      if (canOpen && !visited.has(s.absolutePath)) {
        visited.add(s.absolutePath);
        children = await this.walk(s.absolutePath, visited, depth + 1, cur);
      }
      out.push({
        name: s.path, absolutePath: s.absolutePath, status: s.status,
        canOpen, current: samePath(s.absolutePath, cur), isRoot: false, children,
      });
    }
    return out;
  }
}

export const submoduleNavCtrl = new SubmoduleNavState();
