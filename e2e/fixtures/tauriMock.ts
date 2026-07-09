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
// here would just be a second, drifting copy of that logic. `loadGraph()`
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

// Deliberately single-lane — see file header's SCOPE note.
function loadGraph(repo: TempRepo, limit: number | null) {
  const rows = log(repo);
  const chips = refsBySha(repo);
  const capped = limit ? rows.slice(0, limit) : rows;
  const n = capped.length;
  return {
    n,
    lane: capped.map(() => 0),
    color: capped.map(() => 0),
    merge: capped.map((r) => (r.parents.length > 1 ? 1 : 0)),
    gapStart: new Array(n + 1).fill(0),
    gapTop: [],
    gapBot: [],
    gapColor: [],
    rows: capped.map((r) => ({
      sha: r.sha,
      subject: r.subject,
      an: r.an,
      cm: r.cm,
      refs: chips.get(r.sha) ?? [],
      merge: r.parents.length > 1,
    })),
    ncol: 7,
    laneCount: 1,
    layoutMs: 0,
    readMs: 0,
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

function makeInvokeHandler(repo: TempRepo) {
  return async (cmd: string, args: any): Promise<unknown> => {
    switch (cmd) {
      case "get_app_info":
        return {
          name: "GitCat",
          version: "0.0.0-e2e",
          description: "",
          authors: [],
          copyright: "",
          website: "",
        };
      case "load_graph":
        return loadGraph(repo, args?.limit ?? null);
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
  await page.exposeFunction("__e2eInvoke", makeInvokeHandler(repo));
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
        // main.ts's raw `window.__TAURI__.event.listen("menu-action"/"repo-changed", ...)` —
        // no test here drives the native app menu or the file-watcher, so this
        // just registers and returns a no-op unlisten.
        listen: async (_event: string, _cb: unknown) => () => {},
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
