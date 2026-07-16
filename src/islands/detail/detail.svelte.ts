// Commit detail panel — controller (Svelte 5 runes singleton).
//
// Owns the right-hand `#detail` pane: author/committer split, gpg badge,
// refs-here, snapshot coverage, diffstat, file tree, and the syntax-
// highlighted diff itself. Async-loads the real diff on selection (race-
// guarded by a private monotonic counter — same shape as the old module-level
// DETAIL_SEQ, just an instance field now) and falls back to small canned demo
// data in design mode (mirrors reflog/rerere's DEMO convention).
//
// `commitMeta` moved in wholesale (its only caller was the old legacy
// `select()`, which now delegates here) — everything ELSE it depends on
// (G/BACKEND/AUTHORS/hhex/msgOf/fakeAgo/relTime) is shared with other
// not-yet-migrated legacy code, so those stay bridged from legacy/main.ts.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import type { CommitDetail } from "../../ipc/bindings";
import { resolver } from "../resolver/resolver.svelte.ts";
import { blameCtrl } from "../blame/blame.svelte.ts";
import { fileHistoryCtrl } from "../filehistory/filehistory.svelte.ts";
import { externalToolsCtrl } from "../externaltools/externaltools.svelte.ts";
import { IN_TAURI } from "../../ipc/env";
import { copyToClipboard } from "../../legacy/clipboard.ts";

function esc(s: unknown): string {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

const GPG: Record<string, [string, string]> = {
  good: ["good", "✔ Good signature"],
  none: ["none", "○ Unsigned"],
  bad: ["bad", "✘ Bad signature"],
};

type RefChip = { n: string; t: "tag" | "remote" | "head" };
type CommitVM = {
  row: number;
  subject: string;
  sha: string;
  an: { n: string; e: string; d: string };
  cm: { n: string; e: string; d: string };
  differ: boolean;
  gpg: "good" | "none" | "bad";
  refs: RefChip[];
  add: number;
  del: number;
  merge: boolean;
};

type FileEntry = { p: string; st: string; add: number; del: number; oldPath: string | null };
type TreeFile = FileEntry & { name: string; i: number };
export type TreeDir = { dirs: Record<string, TreeDir>; files: TreeFile[] };
type DiffFile = { lang: string; lines: [string, string][]; truncated: boolean; binary: boolean };

export type DiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "line"; ln: number | ""; mk: string; cls: string; html: string }
  | { kind: "note"; text: string };

type Hero = { kind: "loaded"; n: number; ms: number } | { kind: "empty" };

// Demo data (design-mode only) — a small canned changeset, same spirit as the
// other islands' DEMO constants so the browser preview still shows a full
// detail panel without a real backend.
const DEMO_CHANGED: FileEntry[] = [
  { p: "src/auth/session.ts", st: "M", add: 22, del: 5, oldPath: null },
  { p: "src/auth/token.ts", st: "M", add: 11, del: 7, oldPath: null },
  { p: "src/ui/LoginForm.tsx", st: "A", add: 5, del: 0, oldPath: null },
];
const DEMO_DIFFS: Record<string, DiffFile> = {
  "src/auth/session.ts": {
    lang: "ts",
    truncated: false,
    binary: false,
    lines: [
      ["@@", "@@ -18,6 +18,9 @@ export function createSession(user) {"],
      [" ", "  const store = new TokenStore();"],
      ["-", "  const ttl = 900;"],
      ["+", "  const ttl = 3600; // extended, see #482"],
      ["+", "  const limiter = rateLimit({ windowMs: 60000, max: 30 });"],
      [" ", "  return sign({ user, ttl }, secret);"],
      ["+", "  // audit: Safety Manager seals a snapshot before mutation"],
    ],
  },
  "src/auth/token.ts": {
    lang: "ts",
    truncated: false,
    binary: false,
    lines: [
      ["@@", "@@ -4,3 +4,4 @@"],
      ["-", "export const refresh = (t) => rotate(t);"],
      ["+", "export const refresh = (t, opts = {}) => rotate(t, opts);"],
    ],
  },
  "src/ui/LoginForm.tsx": {
    lang: "ts",
    truncated: false,
    binary: false,
    lines: [
      ["@@", "@@ -0,0 +1,5 @@"],
      ["+", "export function LoginForm() {"],
      ["+", "  const [err, setErr] = useState(null);"],
      ["+", "  return submit(err);"],
      ["+", "}"],
    ],
  },
};

class DetailState {
  commit = $state<CommitVM | null>(null);
  hero = $state<Hero | null>(null);
  bodyText = $state("");
  copied = $state(false);
  diffstat = $state<{ add: number; del: number; files: number; truncated: boolean } | null>(null);
  treeLoading = $state(false);
  diffLoading = $state(false);
  selectedFile = $state<string | null>(null);
  diffHeader = $state("");
  diffRows = $state<DiffRow[]>([]);
  // Which file-tree row's Blame/History click is mid-`plumbingInspect`
  // (deleted-file rows only — see blameFile()/historyFile()'s own doc
  // comment) — lets the row swap those two buttons for a spinner instead of
  // showing nothing while that extra round trip is in flight.
  resolvingDeletedFileFor = $state<string | null>(null);

  private curChanged: FileEntry[] = [];
  private curDiffs: Record<string, DiffFile> = {};
  private detailSeq = 0;
  // What deselect() (clicking empty canvas space) should restore — the
  // "loaded" hero's n/ms if a graph is open, or null when there's no repo
  // open at all (deselect then falls back to the empty-state hero).
  private lastHero: { n: number; ms: number } | null = null;

  private commitMeta(r: number): CommitVM | null {
    const BACKEND: any = bridge.BACKEND,
      G: any = bridge.G;
    if (BACKEND) {
      const m = BACKEND.rows[r];
      if (!m) return null;
      const differ = m.an.n !== m.cm.n || m.an.e !== m.cm.e || m.an.t !== m.cm.t;
      const refs: RefChip[] = m.refs.map((x: any) => ({
        n: x.n,
        t: x.t === "tag" ? "tag" : x.t === "remote" ? "remote" : "head",
      }));
      return {
        row: r,
        subject: m.subject,
        sha: m.sha,
        an: { n: m.an.n, e: m.an.e, d: bridge.relTime(m.an.t) },
        cm: { n: m.cm.n, e: m.cm.e, d: bridge.relTime(m.cm.t) },
        differ,
        gpg: "none",
        refs,
        add: 0,
        del: 0,
        merge: !!(G && G.isMerge[r]),
      };
    }
    const a = bridge.AUTHORS[(Math.imul(r, 2654435761) >>> 5) % bridge.AUTHORS.length];
    const rebased = (r % 7 === 0 && r > 0) || G.isMerge[r];
    const cm = rebased
      ? { n: "GitCat (rebase)", e: "noreply@gitcat.dev", d: bridge.fakeAgo(Math.max(0, r - 2)) + " ago" }
      : { n: a.n, e: a.e, d: bridge.fakeAgo(r) + " ago" };
    const gpg: "good" | "none" | "bad" = r % 11 === 0 ? "none" : (bridge.hhex(r).charCodeAt(1) & 7) === 0 ? "bad" : "good";
    const refs: RefChip[] = [];
    if (r === 0) refs.push({ n: "HEAD", t: "head" }, { n: "main", t: "head" });
    const gr = G.refs[r];
    if (gr && r !== 0) refs.push({ n: gr.label, t: gr.kind === "tag" ? "tag" : gr.kind === "head" ? "head" : "remote" });
    const add = 8 + ((r * 13) % 40),
      del = (r * 7) % 20;
    return {
      row: r,
      subject: bridge.msgOf(r),
      sha: bridge.hhex(r),
      an: { n: a.n, e: a.e, d: bridge.fakeAgo(r) + " ago" },
      cm,
      differ: rebased,
      gpg,
      refs,
      add,
      del,
      merge: !!G.isMerge[r],
    };
  }

  get coverage(): { ago: string } | null {
    const c = this.commit,
      G: any = bridge.G;
    if (!c || !G) return null;
    const snaps: number[] = G.snapRows || [];
    let cov = -1;
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i] <= c.row) {
        cov = snaps[i];
        break;
      }
    }
    return cov >= 0 ? { ago: G.snapTs[cov] } : null;
  }

  get gpgBadge(): [string, string] {
    return this.commit ? GPG[this.commit.gpg] : GPG.none;
  }

  // Whether the "Revert commit" button should be disabled: the existing
  // `resolver.busy` re-entrancy guard, OR the selected commit being a merge.
  // `git revert` (like `git cherry-pick`) refuses a merge commit with a
  // jargon-y "commit X is a merge but no -m option was given" unless `-m`/
  // `--mainline` is given, which revert_start deliberately doesn't support
  // (see git_revert.rs's module doc — same deliberate scope limit as
  // cherry-pick). Cherry-pick's own equivalent limitation is enforced earlier,
  // at the drag gesture (`legalPick` in legacy/main.ts: `G.isMerge[src] =>
  // "can't cherry-pick a merge"`), so the user never even attempts it and no
  // safety snapshot is wasted. Revert has a real button instead of a drag
  // gesture, so the button itself is where that same guard belongs.
  get revertDisabled(): boolean {
    return resolver.busy || !!this.commit?.merge;
  }

  get tree(): TreeDir {
    const root: TreeDir = { dirs: {}, files: [] };
    this.curChanged.forEach((f, i) => {
      const parts = String(f.p).split("/");
      let n = root;
      parts.forEach((seg, j) => {
        if (j === parts.length - 1) {
          n.files.push({ ...f, name: seg, i });
        } else {
          n.dirs[seg] = n.dirs[seg] || { dirs: {}, files: [] };
          n = n.dirs[seg];
        }
      });
    });
    return root;
  }

  select(row: number) {
    const c = this.commitMeta(row);
    this.commit = c;
    this.hero = null;
    this.copied = false;
    if (!c) return;
    const live = !!bridge.BACKEND;
    if (live) {
      this.bodyText = "loading…";
      this.treeLoading = true;
      this.diffLoading = true;
      this.curChanged = [];
      this.curDiffs = {};
      this.diffstat = null;
      this.selectedFile = null;
      this.diffHeader = "";
      this.diffRows = [];
      this.loadCommitDetail(row);
    } else {
      this.bodyText = c.merge
        ? "Merge commit — reconciles two lines of history."
        : "Part of the feature/login work. Signed-off and covered by an auto-snapshot.";
      this.curChanged = DEMO_CHANGED;
      this.curDiffs = DEMO_DIFFS;
      this.diffstat = { add: c.add, del: c.del, files: DEMO_CHANGED.length, truncated: false };
      this.treeLoading = false;
      this.diffLoading = false;
      this.selectFile();
    }
  }

  private async loadCommitDetail(row: number) {
    const BACKEND: any = bridge.BACKEND;
    const m = BACKEND && BACKEND.rows[row];
    if (!m) return;
    const myReq = ++this.detailSeq;
    try {
      const r = await commands.commitDetail(bridge.CUR_REPO as unknown as string, m.sha);
      if (myReq !== this.detailSeq) return; // a newer selection superseded this one
      if (r.status !== "ok") throw new Error(r.error);
      const d: CommitDetail = r.data;
      const files = Array.isArray(d.fileTree) ? d.fileTree : [];
      this.curChanged = files.map((f) => ({ p: f.path, st: f.status, add: f.additions | 0, del: f.deletions | 0, oldPath: f.oldPath ?? null }));
      this.curDiffs = {};
      files.forEach((f) => {
        const lines: [string, string][] = [];
        (f.hunks || []).forEach((h) => {
          lines.push(["@@", h.header]);
          (h.lines || []).forEach((l) => lines.push([l.kind, l.text]));
        });
        this.curDiffs[f.path] = { lang: f.lang || "generic", lines, truncated: !!f.truncated, binary: !!f.binary };
      });
      this.bodyText = d.body && d.body.trim() ? d.body : "(no message body)";
      this.diffstat = {
        add: d.additions | 0,
        del: d.deletions | 0,
        files: d.filesChanged != null ? d.filesChanged : this.curChanged.length,
        truncated: !!d.truncated,
      };
      this.treeLoading = false;
      this.diffLoading = false;
      this.selectFile();
    } catch (e) {
      if (myReq !== this.detailSeq) return;
      this.diffstat = null;
      this.bodyText = /loading/.test(this.bodyText) ? "" : this.bodyText;
      this.treeLoading = false;
      this.diffLoading = false;
      this.diffHeader = "";
      this.diffRows = [{ kind: "note", text: "diff unavailable — " + String(e) }];
      console.error("commit_detail failed", e);
    }
  }

  // Render the diff for `path`, or the default (first) file when omitted —
  // mirrors the legacy renderDiff(path)'s explicit-vs-fallback distinction.
  //
  // All the per-file diffs for this commit are already prefetched (curDiffs),
  // so this never awaits anything — but the syntax-highlighting loop below
  // (bridge.highlight() per line, up to MAX_LINES_PER_FILE=2000) is real,
  // synchronous work that used to run inline with zero opportunity for the
  // browser to paint anything first: clicking a large changed file just
  // froze with no visible change until the whole loop finished. diffLoading
  // is now set FIRST (the view already renders a spinner for it — see
  // Detail.svelte's `.diffview` block, shared with the commit-level loader),
  // and the actual highlighting is deferred one macrotask via setTimeout so
  // that flag change gets a real paint before the expensive loop starts.
  selectFile(path?: string) {
    const explicit = path != null;
    const keys = Object.keys(this.curDiffs || {});
    const resolved = path || (this.curChanged[0] && this.curChanged[0].p) || keys[0];
    this.selectedFile = resolved ?? null;
    this.diffHeader = resolved || "";
    this.diffLoading = true;
    setTimeout(() => this.renderSelectedFileDiff(resolved, explicit), 0);
  }

  private renderSelectedFileDiff(resolved: string | undefined, explicit: boolean): void {
    try {
      let d = resolved ? this.curDiffs[resolved] : undefined;
      if (!d && !explicit) d = this.curDiffs[Object.keys(this.curDiffs || {})[0]];
      if (!d) {
        this.diffRows = [{ kind: "note", text: "no textual diff" }];
        return;
      }
      if (d.binary) {
        this.diffRows = [{ kind: "note", text: "binary file — not shown" }];
        return;
      }
      let n1 = 0,
        n2 = 0;
      const rows: DiffRow[] = [];
      d.lines.forEach(([mk, txt]) => {
        if (mk === "@@") {
          rows.push({ kind: "hunk", text: txt });
          return;
        }
        const cls = mk === "+" ? "add" : mk === "-" ? "del" : "";
        const ln = mk === "+" ? n2++ : mk === "-" ? n1++ : (n1++, n2++);
        rows.push({ kind: "line", ln, mk: mk === "+" || mk === "-" ? mk : "", cls, html: bridge.highlight(txt, d.lang) });
      });
      if (d.truncated) rows.push({ kind: "note", text: "… diff truncated (file capped)" });
      this.diffRows = rows;
    } finally {
      this.diffLoading = false;
    }
  }

  // "Blame" button in the file tree row — resolves the right (commit, file)
  // pair per the row's own status (see the design's "deleted/renamed-away
  // files" note): the tree only ever shows ONE row per changed file, at its
  // path IN THIS COMMIT — for A/M/T and for R/C (the row's `f.p` is the
  // rename's NEW path, which does exist in this commit's own tree) that's
  // simply `(commit.sha, f.p)`. A `D` (deleted) row has nothing at `f.p` in
  // THIS commit's tree — only its PARENT's tree still has it — so it needs
  // the first-parent sha instead ("blame the file as it last existed"),
  // resolved via the same `<sha>^` revspec `plumbing_inspect` already
  // supports (ordinary git rev syntax for "first parent"), rather than
  // adding new backend plumbing just for this one case.
  async blameFile(f: { p: string; st: string; oldPath: string | null }) {
    const c = this.commit;
    if (!c) return;
    const repo = bridge.CUR_REPO as unknown as string;
    if (f.st !== "D") {
      blameCtrl.openFor(repo, c.sha, f.p, f.oldPath);
      return;
    }
    if (!IN_TAURI) {
      // design-mode preview: no real parent to resolve — best-effort, same
      // (commit, file) pair as any other status, just for the canned demo.
      blameCtrl.openFor(repo, c.sha, f.p, f.oldPath);
      return;
    }
    this.resolvingDeletedFileFor = f.p;
    try {
      const r = await commands.plumbingInspect(repo, c.sha + "^");
      if (r.status === "ok" && r.data.kind === "commit") {
        blameCtrl.openFor(repo, r.data.sha, f.p, f.oldPath);
      } else {
        bridge.tama.warn("Couldn't resolve the parent commit to blame a deleted file.");
      }
    } catch (e) {
      bridge.tama.warn("Couldn't resolve the parent commit — " + e);
    } finally {
      this.resolvingDeletedFileFor = null;
    }
  }

  // "History" button in the file tree row — sibling of blameFile() above,
  // resolving the identical (commit, file) pair via the identical
  // deleted-file `<sha>^` special case (see blameFile's own comment for the
  // full "which commit's tree do we resolve this path against" reasoning;
  // not repeated here since it's exactly the same need).
  async historyFile(f: { p: string; st: string; oldPath: string | null }) {
    const c = this.commit;
    if (!c) return;
    const repo = bridge.CUR_REPO as unknown as string;
    if (f.st !== "D") {
      fileHistoryCtrl.openFor(repo, c.sha, f.p, f.oldPath);
      return;
    }
    if (!IN_TAURI) {
      // design-mode preview: no real parent to resolve — best-effort, same
      // (commit, file) pair as any other status, just for the canned demo.
      fileHistoryCtrl.openFor(repo, c.sha, f.p, f.oldPath);
      return;
    }
    this.resolvingDeletedFileFor = f.p;
    try {
      const r = await commands.plumbingInspect(repo, c.sha + "^");
      if (r.status === "ok" && r.data.kind === "commit") {
        fileHistoryCtrl.openFor(repo, r.data.sha, f.p, f.oldPath);
      } else {
        bridge.tama.warn("Couldn't resolve the parent commit to show history for a deleted file.");
      }
    } catch (e) {
      bridge.tama.warn("Couldn't resolve the parent commit — " + e);
    } finally {
      this.resolvingDeletedFileFor = null;
    }
  }

  // "Open in external diff" button in the file tree row — sibling of
  // blameFile()/historyFile() above, but does NOT need either's deleted-file
  // `<sha>^` special case: a two-revision `fromRev..toRev` diff already
  // reproduces this commit's own diff for EVERY file status (A/M/D/R/T/C), so
  // `c.sha + "^"`/`c.sha` is always the right pair regardless of `f.st` (see
  // tool_settings.rs's own module doc for the empirical confirmation).
  openExternalDiff(f: { p: string }) {
    const c = this.commit;
    if (!c) return;
    const repo = bridge.CUR_REPO as unknown as string;
    void externalToolsCtrl.openDiff(repo, f.p, false, c.sha + "^", c.sha);
  }

  copySha() {
    if (!this.commit) return;
    copyToClipboard(this.commit.sha);
    this.copied = true;
    setTimeout(() => {
      this.copied = false;
    }, 900);
  }

  // "Revert commit" button — the entry point for git revert. There is no
  // per-commit-row context menu anywhere in this app: cherry-pick/merge use
  // the canvas drag gesture (whose drop target is actually ignored — both
  // always apply onto HEAD) and rebase uses the sidebar's branch menu.
  // Revert has no meaningful "target" either — it always applies onto HEAD
  // given only the source commit to revert — so a drag gesture would be
  // misleading (there's nothing to drop it "onto" that means anything).
  // This reuses the existing select-a-commit -> detail-panel -> act flow
  // instead of inventing a context-menu system just for one action. Mirrors
  // sidebarCtrl.rebaseOnto's IN_TAURI branch (and legacy/main.ts's
  // cherryPick()/mergeCommit()): design mode opens the resolver's demo,
  // real mode calls the resolver's real start* entry point. Guarded on
  // `this.commit` so it's a no-op for the hero/empty state; Detail.svelte
  // only renders the button inside the branch that requires a real selected
  // commit (mutually exclusive with the hero AND the workdir pinned row via
  // the same `{#if workdirCtrl.selected}{:else if detailCtrl.hero}{:else if
  // detailCtrl.commit}` chain that already governs the whole panel). Also
  // guarded on `c.merge` (belt-and-braces alongside Detail.svelte's
  // `disabled={detailCtrl.revertDisabled}`, see that getter's doc comment):
  // revert_start doesn't support `-m`/`--mainline`, so a merge commit would
  // otherwise take a real safety snapshot before failing on git's raw stderr.
  async revertCommit() {
    const c = this.commit;
    if (!c || c.merge) return;
    if (!IN_TAURI) {
      resolver.openDemo(c.sha, "revert"); // ---- design-mode demo ----
      return;
    }
    await resolver.startRevert(bridge.CUR_REPO as unknown as string, c.sha); // ---- real revert onto HEAD (Svelte island) ----
  }

  showHero(n: number, ms: number) {
    this.lastHero = { n, ms };
    this.commit = null;
    this.hero = { kind: "loaded", n, ms };
  }

  showEmpty() {
    this.lastHero = null;
    this.commit = null;
    this.hero = { kind: "empty" };
  }

  // Clicking empty canvas space (no commit under the pointer) while a commit
  // is selected — previously a no-op, so the detail panel got stuck showing
  // the last-selected commit forever with no way back to Tama's hero card
  // short of selecting another commit. Restores whichever hero showHero()/
  // showEmpty() last set, same as if nothing had ever been selected.
  deselect() {
    this.commit = null;
    this.hero = this.lastHero ? { kind: "loaded", ...this.lastHero } : { kind: "empty" };
  }
}

export const detailCtrl = new DetailState();
export { esc };
