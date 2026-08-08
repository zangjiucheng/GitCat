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
// SCOPE / LIMITATION: the real `load_graph` returns almost immediately (null);
// history arrives as `"graph-batch"` events (see legacy/main.ts's
// startGraphStream/onGraphBatch). This mock mirrors that protocol: the Node
// handler builds one simplified batch, and the page-side invoke wrapper emits
// it on `"graph-batch"` after `load_graph` resolves. Lane/color/gap layout is a
// genuine DAG algorithm in src-tauri/src/layout.rs — reimplementing it here
// would just be a second, drifting copy. The batch below is deliberately
// single-lane (real commits, real shas, real refs — no real multi-lane merge
// geometry). That's enough to assert on DOM text (detail hero, sidebar refs)
// but NOT on visual lane/merge-graph placement — tests that need the latter
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
  const raw = repo.git("for-each-ref", "--format=%(objectname)%09%(refname)");
  const map = new Map<string, RefChip[]>();
  for (const line of raw ? raw.split("\n") : []) {
    const [sha, refname] = line.split("\t");
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

// One final GraphBatch for the whole fixture history — deliberately
// single-lane (see file header's SCOPE note). Shape matches model.rs's
// GraphBatch (camelCase), not the old one-shot GraphData `load_graph` used
// to return.
function graphBatch(repo: TempRepo, requestId: number) {
  const rows = log(repo);
  const chips = refsBySha(repo);
  const n = rows.length;
  return {
    generation: requestId,
    rows: rows.map((r) => ({
      sha: r.sha.slice(0, 7),
      subject: r.subject,
      an: r.an,
      cm: r.cm,
      refs: chips.get(r.sha) ?? [],
      merge: r.parents.length > 1,
      // Fixture walks are tiny; treating every row as a HEAD ancestor is
      // enough for the detail-hero / canvas path the e2e suite asserts on.
      ancestor: true,
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
  const tagsRaw = repo.git("for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/tags/");
  const tags = (tagsRaw ? tagsRaw.split("\n").filter(Boolean) : []).map((line) => {
    const [name, sha] = line.split("\t");
    return { name, sha };
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

function makeInvokeHandler(repo: TempRepo) {
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
      // Returns a GraphBatch payload for the page-side invoke wrapper, which
      // emits it on `"graph-batch"` and resolves `load_graph` itself as null
      // (matching commands::load_graph — data never comes back on the invoke).
      case "load_graph":
        return graphBatch(repo, args.requestId);
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
      // @tauri-apps/api/event's listen/unlisten/emit via invoke — unused by the
      // graph stream (that goes through window.__TAURI__.event.listen below).
      // No test here drives these, so they stay inert stubs.
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
  await page.exposeFunction("__e2eInvoke", makeInvokeHandler(repo));
  await page.addInitScript((repoDir: string) => {
    // Skip the first-run setup wizard (src/islands/setupwizard) — it auto-opens
    // over the hero card whenever IN_TAURI is true and no repo is open yet,
    // which would otherwise block every `.repo-pick` click behind its scrim.
    localStorage.setItem("gitcat.setupWizardDismissed", "1");
    const w = window as any;
    // Real listener registry — openRepo()'s graph path registers
    // `listen("graph-batch", …)` and grows BACKEND only from those events.
    // A no-op listen left the canvas empty while sidebar IPC still passed.
    const listeners = new Map<string, Set<(event: { event: string; payload: unknown }) => void>>();
    const emit = (event: string, payload: unknown) => {
      for (const cb of listeners.get(event) ?? []) cb({ event, payload });
    };
    const invoke = async (cmd: string, args: unknown) => {
      if (cmd === "load_graph") {
        // Node builds the batch; we emit it and resolve null so the frontend
        // exercises the same startGraphStream → onGraphBatch path as production.
        const batch = await w.__e2eInvoke(cmd, args);
        queueMicrotask(() => emit("graph-batch", batch));
        return null;
      }
      return w.__e2eInvoke(cmd, args);
    };
    w.__TAURI_INTERNALS__ = {
      invoke,
      // Minimal Channel support: nothing in this harness streams over a
      // channel yet (see file header's SCOPE note), so these just need to
      // not throw.
      transformCallback: (_cb?: unknown, _once?: boolean) => Math.floor(Math.random() * 1e9),
      unregisterCallback: (_id: number) => {},
      convertFileSrc: (path: string) => path,
    };
    w.__TAURI__ = {
      core: { invoke },
      event: {
        // legacy/main.ts listens for "graph-batch" (and menu-action /
        // repo-changed). Graph batches are emitted from invoke("load_graph")
        // above; the other events stay unused by this harness.
        listen: async (event: string, cb: (event: { event: string; payload: unknown }) => void) => {
          let set = listeners.get(event);
          if (!set) {
            set = new Set();
            listeners.set(event, set);
          }
          set.add(cb);
          return () => {
            set!.delete(cb);
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
