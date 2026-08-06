// Playwright fixture that makes the Svelte frontend believe it's running
// inside the real Tauri webview, backed by a disposable on-disk git repo
// instead of the real src-tauri/git2 backend.
//
// WHY a mock instead of driving the real compiled app: Playwright drives
// Chromium/Firefox/WebKit, not Tauri's native webview — there's no
// Playwright<->Tauri bridge. Full end-to-end coverage of the actual Rust
// backend belongs to a `tauri-driver`-based suite (not implemented here);
// this harness instead runs the real Svelte UI in a real browser and swaps
// only the IPC boundary (`@tauri-apps/api/core`'s `invoke`, which — per
// node_modules/@tauri-apps/api/core.js — is just
// `window.__TAURI_INTERNALS__.invoke(cmd, args)`) for handlers that shell
// out to a real `git` binary against a TempRepo fixture.
//
// SCOPE / LIMITATION: `load_graph`'s lane/color/gap layout is a genuine DAG
// layout algorithm that lives in src-tauri/src/layout.rs — reimplementing it
// here would just be a second, drifting copy of that logic. `loadGraphBatch()`
// below instead returns a deliberately simplified single-lane rendering (real
// commits, real shas, real refs — no real multi-lane merge geometry). That's
// enough to assert on DOM text (commit list, sidebar refs, detail panel) but
// NOT on visual lane/merge-graph placement — tests that need the latter
// should go through the real app instead.
//
// Add a new command by adding a `case` in `makeInvokeHandler` below; an
// unhandled command throws immediately with the missing command's name
// rather than hanging, so a test's first failure always points at the gap.
import { test as base, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { TempRepo } from "./tempRepo";

type RefChip = { n: string; t: "head" | "branch" | "remote" | "tag" };
type CommitRow = {
  sha: string;
  parents: string[];
  subject: string;
  an: { n: string; e: string; t: number };
  cm: { n: string; e: string; t: number };
};

const FS = "\x1f"; // unit separator — won't collide with real commit text

function log(repo: TempRepo): CommitRow[] {
  const raw = repo.git(
    "log",
    "--all",
    "--date-order",
    `--format=%H${FS}%P${FS}%s${FS}%an${FS}%ae${FS}%at${FS}%cn${FS}%ce${FS}%ct`,
  );
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    const [sha, parents, subject, an, ae, at, cn, ce, ct] = line.split(FS);
    return {
      sha,
      parents: parents ? parents.split(" ") : [],
      subject,
      an: { n: an, e: ae, t: Number(at) },
      cm: { n: cn, e: ce, t: Number(ct) },
    };
  });
}

function refsBySha(repo: TempRepo): Map<string, RefChip[]> {
  const head = repo.git("symbolic-ref", "-q", "--short", "HEAD").trim() || null;
  // %(*objectname) is the dereferenced (peeled) oid — git only fills it in for
  // an ANNOTATED tag, empty for everything else — so it's the commit oid for a
  // lightweight tag/branch/remote, and %(objectname) alone would be the tag
  // OBJECT's own oid for an annotated one. Same peel the real backend does via
  // `tag_foreach … peel_to_commit`. %(objectname) (never empty) comes FIRST,
  // not %(*objectname) — repo.git() .trim()s its output, and an empty leading
  // field would otherwise donate its separator tab to that trim, shifting
  // every field on the very first line by one.
  const raw = repo.git("for-each-ref", "--format=%(objectname)%09%(*objectname)%09%(refname)");
  const map = new Map<string, RefChip[]>();
  for (const line of raw ? raw.split("\n") : []) {
    const [direct, peeled, refname] = line.split("\t");
    const sha = peeled || direct;
    let chip: RefChip | null = null;
    if (refname.startsWith("refs/heads/")) {
      const name = refname.slice("refs/heads/".length);
      chip = { n: name, t: name === head ? "head" : "branch" };
    } else if (refname.startsWith("refs/remotes/")) {
      chip = { n: refname.slice("refs/remotes/".length), t: "remote" };
    } else if (refname.startsWith("refs/tags/")) {
      chip = { n: refname.slice("refs/tags/".length), t: "tag" };
    }
    if (!chip) continue;
    const list = map.get(sha) ?? [];
    list.push(chip);
    map.set(sha, list);
  }
  return map;
}

// Deliberately single-lane — see file header's SCOPE note. Shaped as ONE
// complete "graph-batch" payload (see bindings.ts's GraphBatch doc comment):
// `load_graph` itself only hands back `{ generation }`, the real data arrives
// over the "graph-batch" event, which legacy/main.ts listens for directly on
// `window.__TAURI__.event.listen` (not through the invoke-shimmed
// "plugin:event|listen" path) — so this fixture repo's whole history is
// delivered as a single done:true batch rather than returned from the
// invoke call the way the rest of this file's handlers work.
function loadGraphBatch(repo: TempRepo, generation: number) {
  const rows = log(repo);
  const chips = refsBySha(repo);
  const n = rows.length;
  return {
    generation,
    rows: rows.map((r) => ({
      // CommitMeta.sha is only the 7-char short prefix — the full oid rides
      // alongside in `oids`, parallel by index (see GraphBatch's own doc
      // comment). goToOid joins on THAT, not this, so a test asserting the
      // full-oid join has to go through this shape, not a shortcut.
      sha: r.sha.slice(0, 7),
      subject: r.subject,
      an: r.an,
      cm: r.cm,
      refs: chips.get(r.sha) ?? [],
      merge: r.parents.length > 1,
      ancestor: false,
    })),
    oids: rows.map((r) => r.sha),
    lane: rows.map(() => 0),
    color: rows.map(() => 0),
    merge: rows.map((r) => (r.parents.length > 1 ? 1 : 0)),
    gapCounts: rows.map(() => 0),
    gapTop: [],
    gapBot: [],
    gapColor: [],
    ncol: 7,
    laneCount: 1,
    totalSoFar: n,
    done: true,
    elapsedMs: 0,
    error: null,
    truncated: false,
  };
}

function listRefs(repo: TempRepo) {
  const head = (repo.git("symbolic-ref", "-q", "--short", "HEAD").trim() || null) as string | null;
  const localsRaw = repo.git("for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads/");
  const locals = (localsRaw ? localsRaw.split("\n") : []).map((line) => {
    const [name, sha] = line.split("\t");
    return { name, sha, ahead: null, behind: null };
  });
  const remotesRaw = repo.git("for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/remotes/");
  const remotes = (remotesRaw ? remotesRaw.split("\n").filter(Boolean) : []).map((line) => {
    const [name, sha] = line.split("\t");
    return { name, sha };
  });
  // Peel annotated tags to their commit, same as refsBySha above — a tag's
  // sha is load-bearing now that clicking it jumps by oid (goToOid joins on
  // the commit oid, never the tag object's own oid).
  const tagsRaw = repo.git("for-each-ref", "--format=%(refname:short)%09%(*objectname)%09%(objectname)", "refs/tags/");
  const tags = (tagsRaw ? tagsRaw.split("\n").filter(Boolean) : []).map((line) => {
    const [name, peeled, direct] = line.split("\t");
    return { name, sha: peeled || direct };
  });
  return { head, locals, remotes, tags };
}

function workdirStatus(repo: TempRepo) {
  const porcelain = repo.git("status", "--porcelain=v1");
  const staged: any[] = [];
  const unstaged: any[] = [];
  for (const line of porcelain ? porcelain.split("\n") : []) {
    const x = line[0], y = line[1], path = line.slice(3);
    if (x !== " " && x !== "?") staged.push({ path, status: x });
    if (y !== " ") unstaged.push({ path, status: y === "?" ? "?" : y });
  }
  const head = repo.git("symbolic-ref", "-q", "--short", "HEAD").trim() || null;
  return { staged, unstaged, conflicted: 0, branch: head, hasStash: false };
}

function commitDetail(repo: TempRepo, sha: string) {
  const subject = repo.git("log", "-1", "--format=%s", sha);
  const body = repo.git("log", "-1", "--format=%b", sha);
  const numstat = repo.git("show", "--format=", "--numstat", sha);
  const fileTree = (numstat ? numstat.split("\n").filter(Boolean) : []).map((line) => {
    const [add, del, path] = line.split("\t");
    return {
      path,
      oldPath: null,
      status: "modified",
      additions: add === "-" ? 0 : Number(add),
      deletions: del === "-" ? 0 : Number(del),
      binary: add === "-",
      truncated: false,
      lang: "",
      hunks: [],
    };
  });
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject,
    body,
    message: body ? `${subject}\n\n${body}` : subject,
    additions: fileTree.reduce((a, f) => a + f.additions, 0),
    deletions: fileTree.reduce((a, f) => a + f.deletions, 0),
    filesChanged: fileTree.length,
    truncated: false,
    fileTree,
  };
}

// The repositories dashboard is the only way into a repo now: the topbar chip,
// the empty hero and the sidebar all funnel through it (see legacy/main.ts's
// `.repo-pick` handler), and its "+ Add repository…" picker opens whatever it
// adds. So driving a real open means standing in for its persisted
// tracked_repos.json too — one list per test, in memory, no file involved.
function dashboardRepoStatus(repo: TempRepo) {
  const branch = repo.git("symbolic-ref", "-q", "--short", "HEAD").trim() || null;
  const porcelain = repo.git("status", "--porcelain=v1");
  return {
    branch,
    detached: branch === null,
    ahead: null,
    behind: null,
    dirty: porcelain.length > 0,
    conflicted: 0,
    headSha: repo.git("rev-parse", "HEAD"),
    lastSubject: repo.git("log", "-1", "--format=%s"),
    lastCommitTime: Number(repo.git("log", "-1", "--format=%ct")),
  };
}

function makeInvokeHandler(repo: TempRepo, page: Page) {
  // Starts EMPTY on purpose: a test that means to open a repo has to go through
  // the picker like a user does, rather than finding its repo pre-tracked.
  const tracked: { path: string; lastOpenedAt: number | null }[] = [];
  const trackedList = () => tracked.map((t) => ({ ...t }));

  return async (cmd: string, args: any): Promise<unknown> => {
    switch (cmd) {
      // @tauri-apps/plugin-dialog's open() — the islands' folder picker. Goes
      // over invoke, unlike legacy/main.ts's raw window.__TAURI__.dialog.open
      // (stubbed separately in installTauriMock below); both have to answer.
      case "plugin:dialog|open":
        return repo.dir;
      case "list_tracked_repos":
        return trackedList();
      case "add_tracked_repo":
        if (!tracked.some((t) => t.path === args.path)) tracked.push({ path: args.path, lastOpenedAt: null });
        return trackedList();
      case "track_repo_opened": {
        const row = tracked.find((t) => t.path === args.path);
        // Seconds, matching the Rust side's unix-seconds field.
        if (row) row.lastOpenedAt = Math.floor(Date.now() / 1000);
        return trackedList();
      }
      case "dashboard_repo_status":
        return dashboardRepoStatus(repo);
      // The rest of what openRepo() fans out to. Each is a real command whose
      // FAILURE this harness would otherwise be asserting against by accident:
      // every one of these callers catches and console.errors, so a missing
      // handler doesn't fail a test, it just quietly leaves the UI in a state no
      // real repo produces. Answering "nothing to report" keeps the open path
      // honest without reimplementing any of them.
      case "conflict_status":
        return { inProgress: false, op: "", files: [] };
      case "get_visible_branches":
        return { local: null, remote: null, auto: false }; // no filter — show every branch
      case "submodule_superproject_chain":
        return []; // not a submodule, so no ancestors
      case "bisect_status":
        return {
          ok: true, inProgress: false, current: null, badRef: null, goodRefs: [],
          remainingRevs: 0, estSteps: 0, firstBad: null, log: [], message: "", backupRef: null,
        };
      // false = "already claimed", which suppresses the one-time Repository
      // Summary modal. It would otherwise cover the UI on the first open of
      // every fixture repo, since each one IS a first open.
      case "claim_repo_summary_first_open":
        return false;
      case "run_hooks":
        return []; // no plugins installed in a fixture repo
      case "branch_merge_status":
        return { defaultBranch: "main", merged: [] };
      case "get_app_info":
        return {
          name: "GitCat",
          version: "0.0.0-e2e",
          description: "",
          authors: [],
          copyright: "",
          website: "",
        };
      // Real return value is just `{ generation }` — the actual rows arrive
      // over "graph-batch" (see loadGraphBatch's own doc comment), so this
      // fires that event on the page directly instead of answering it here.
      case "load_graph": {
        const batch = loadGraphBatch(repo, args.requestId);
        // Deliver the batch AFTER this invoke resolves, not before: the real
        // backend never fires "graph-batch" synchronously from inside its own
        // load_graph response. Firing it here (pre-return) let onGraphBatch —
        // including its whole `done` branch — run while startGraphStream's
        // `await tinvoke("load_graph", …)` was still pending, i.e. before
        // openRepo assigns CUR_REPO and before loadGraph(0). setTimeout(…,0)
        // queues the dispatch as a macrotask so this invoke's own promise
        // settles first, reproducing the real "empty canvas, then batches
        // arrive" ordering.
        setTimeout(() => {
          void page
            .evaluate((payload) => {
              (window as any).__e2eListeners?.["graph-batch"]?.forEach((cb: any) => cb({ payload }));
            }, batch)
            .catch(() => {});
        }, 0);
        return { generation: args.requestId };
      }
      case "list_refs":
        return listRefs(repo);
      case "list_snapshots":
        return [];
      case "submodule_status":
        return [];
      case "workdir_status":
        return workdirStatus(repo);
      case "commit_detail":
        return commitDetail(repo, args.sha);
      case "watch_repo":
      case "unwatch_repo":
        return null;
      // Fired unconditionally on every `done:true` batch (see onGraphBatch in
      // legacy/main.ts): recomputeAncestorsAsync's positional dimming recompute.
      // `n` MUST equal the number of loaded rows — a mismatch makes the caller
      // re-enter the whole load via `reloadGraph(true)` (see AncestorFlags's own
      // doc comment in src/ipc/bindings.ts).
      case "head_ancestor_flags": {
        const rows = log(repo);
        return { n: rows.length, flags: rows.map(() => false) };
      }
      // Also fired unconditionally on every `done:true` batch:
      // snapshotGraphBaseline's fast-refresh baseline (see FastRefresh in
      // src/ipc/bindings.ts). refChips reuses refsBySha's already-peeled shas
      // (see A6) so this stays byte-for-byte consistent with loadGraphBatch's
      // own refs.
      case "graph_fast_refresh": {
        const headOid = repo.git("rev-parse", "HEAD").trim() || null;
        const { locals, remotes } = listRefs(repo);
        const seedTips = [...locals, ...remotes].map((b) => b.sha);
        const chips = refsBySha(repo);
        return {
          headOid,
          seedTips,
          refSig: JSON.stringify([headOid, seedTips.slice().sort()]),
          refChips: [...chips.entries()],
        };
      }
      // @tauri-apps/api/event's listen/unlisten/emit — no test here drives a
      // live backend->frontend event, so these are inert stubs.
      case "plugin:event|listen":
        return Math.floor(Math.random() * 1e9);
      case "plugin:event|unlisten":
      case "plugin:event|emit":
      case "plugin:event|emit_to":
        return null;
      default:
        throw new Error(
          `e2e Tauri mock: no handler for invoke("${cmd}", ${JSON.stringify(args)}). ` +
            `Add a case in e2e/fixtures/tauriMock.ts's makeInvokeHandler.`,
        );
    }
  };
}

/** Wires the mock Tauri bridge into `page` and returns once the app can see IN_TAURI === true. */
async function installTauriMock(page: Page, repo: TempRepo): Promise<void> {
  await page.exposeFunction("__e2eInvoke", makeInvokeHandler(repo, page));
  await page.addInitScript((repoDir: string) => {
    // Skip the first-run setup wizard (src/islands/setupwizard) — it auto-opens
    // over the hero card whenever IN_TAURI is true and no repo is open yet,
    // which would otherwise block every `.repo-pick` click behind its scrim.
    localStorage.setItem("gitcat.setupWizardDismissed", "1");
    const w = window as any;
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args: unknown) => w.__e2eInvoke(cmd, args),
      // Minimal Channel support: nothing in this harness streams over a
      // channel yet (see file header's SCOPE note), so these just need to
      // not throw.
      transformCallback: (_cb?: unknown, _once?: boolean) => Math.floor(Math.random() * 1e9),
      unregisterCallback: (_id: number) => {},
      convertFileSrc: (path: string) => path,
    };
    w.__TAURI__ = {
      core: { invoke: w.__TAURI_INTERNALS__.invoke },
      event: {
        // main.ts's raw `window.__TAURI__.event.listen("menu-action"/"repo-changed"/
        // "graph-batch", ...)`. Most of those never fire in this harness (no native
        // app menu, no file-watcher) — but "graph-batch" DOES: the load_graph case
        // above dispatches it straight into `__e2eListeners`, so this has to actually
        // record the callback rather than being a pure no-op.
        listen: async (event: string, cb: unknown) => {
          const listeners = (w.__e2eListeners ??= {});
          (listeners[event] ??= []).push(cb);
          return () => {
            const arr = listeners[event];
            const i = arr ? arr.indexOf(cb) : -1;
            if (i >= 0) arr.splice(i, 1);
          };
        },
      },
      dialog: {
        // Stands in for the native "Open a Git repository" folder picker.
        open: async (_opts: unknown) => repoDir,
      },
    };
  }, repo.dir);
}

type Fixtures = {
  repo: TempRepo;
};

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  repo: async ({}, use, testInfo) => {
    const repo = TempRepo.init(testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "repo");
    try {
      await use(repo);
    } finally {
      repo.dispose();
    }
  },
  page: async ({ page, repo }, use) => {
    await installTauriMock(page, repo);
    await use(page);
  },
});

export { expect };
