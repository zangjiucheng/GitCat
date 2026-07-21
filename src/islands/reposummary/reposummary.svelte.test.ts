// Tests for the Repository Summary controller.
//
// Same isolation strategy as danglingrecovery.svelte.test.ts / reflog.svelte.test.ts:
// legacy/bridge is mocked so legacy/main.ts (a whole vanilla canvas app that
// boots on import) is never evaluated. IN_TAURI is a toggleable getter since
// this file exercises both the real-Tauri and design-mode-demo paths.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  TAMA_IMG: { curious: "curious.png", confident: "confident.png" },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    repoSummary: vi.fn(),
    claimRepoSummaryFirstOpen: vi.fn(),
  },
}));

let mockInTauri = true;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

import { commands } from "../../ipc/bindings";
import type { RepoSummary } from "../../ipc/bindings";
import { repoSummaryCtrl } from "./reposummary.svelte.ts";
import { detailCtrl } from "../detail/detail.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

function summary(partial: Partial<RepoSummary> = {}): RepoSummary {
  return {
    windowDays: 365,
    totalCommits: 4,
    truncated: false,
    churn: [{ path: "a.rs", touches: 3 }],
    contributors: [{ name: "Ada", email: "ada@x.com", commits: 3 }],
    busFactor: 1,
    monthly: [{ month: "2026-07", commits: 4 }],
    problemAreas: { files: [], revertOrHotfixCommits: 0, totalCommits: 4 },
    ...partial,
  };
}

function resetCtrl() {
  repoSummaryCtrl.open = false;
  repoSummaryCtrl.loading = false;
  repoSummaryCtrl.error = "";
  repoSummaryCtrl.demo = false;
  repoSummaryCtrl.summary = null;
  repoSummaryCtrl.tamaImg = "";
  repoSummaryCtrl.repo = "";
  detailCtrl.commit = null;
  mockInTauri = true;
  vi.clearAllMocks();
}

beforeEach(() => {
  resetCtrl();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(repoSummaryCtrl).toBeDefined();
  });
});

describe("refresh — real mode (IN_TAURI)", () => {
  it("populates summary from commands.repoSummary on success", async () => {
    vi.mocked(commands.repoSummary).mockResolvedValueOnce(ok(summary()));

    await repoSummaryCtrl.refresh("repo1");

    expect(commands.repoSummary).toHaveBeenCalledWith("repo1");
    expect(repoSummaryCtrl.summary).toEqual(summary());
    expect(repoSummaryCtrl.error).toBe("");
    expect(repoSummaryCtrl.demo).toBe(false);
  });

  it("shows a clean empty summary (not an error) for a repo with no commits", async () => {
    const empty = summary({ totalCommits: 0, churn: [], contributors: [], monthly: [], busFactor: 0 });
    vi.mocked(commands.repoSummary).mockResolvedValueOnce(ok(empty));

    await repoSummaryCtrl.refresh("repo1");

    expect(repoSummaryCtrl.summary?.totalCommits).toBe(0);
    expect(repoSummaryCtrl.error).toBe("");
  });

  it("surfaces an error and clears the summary when the read fails", async () => {
    vi.mocked(commands.repoSummary).mockResolvedValueOnce(err("cannot open repository"));

    await repoSummaryCtrl.refresh("repo1");

    expect(repoSummaryCtrl.summary).toBeNull();
    expect(repoSummaryCtrl.error).toContain("cannot open repository");
  });

  it("a thrown IPC rejection surfaces an error too", async () => {
    vi.mocked(commands.repoSummary).mockRejectedValueOnce(new Error("boom"));

    await repoSummaryCtrl.refresh("repo1");

    expect(repoSummaryCtrl.summary).toBeNull();
    expect(repoSummaryCtrl.error).toContain("boom");
  });

  it("clears the summary without erroring when no repo is open", async () => {
    await repoSummaryCtrl.refresh(null);

    expect(commands.repoSummary).not.toHaveBeenCalled();
    expect(repoSummaryCtrl.summary).toBeNull();
    expect(repoSummaryCtrl.error).toBe("");
  });

  it("sets loading true while the request is in flight, false once settled", async () => {
    let resolveFn!: (v: { status: "ok"; data: RepoSummary }) => void;
    vi.mocked(commands.repoSummary).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      }),
    );
    const p = repoSummaryCtrl.refresh("repo1");
    expect(repoSummaryCtrl.loading).toBe(true);
    resolveFn(ok(summary()));
    await p;
    expect(repoSummaryCtrl.loading).toBe(false);
  });
});

describe("show / close (Tools menu / ⌘K entry point)", () => {
  it("show() opens the modal and re-fetches", async () => {
    vi.mocked(commands.repoSummary).mockResolvedValueOnce(ok(summary()));
    repoSummaryCtrl.show("repo1");
    expect(repoSummaryCtrl.open).toBe(true);
    await Promise.resolve(); // let the fire-and-forget refresh() settle
    expect(commands.repoSummary).toHaveBeenCalledWith("repo1");
  });

  it("close() closes it", () => {
    repoSummaryCtrl.open = true;
    repoSummaryCtrl.close();
    expect(repoSummaryCtrl.open).toBe(false);
  });
});

describe("demo mode", () => {
  beforeEach(() => {
    mockInTauri = false;
  });

  it("refresh seeds a canned demo summary without any IPC call", async () => {
    await repoSummaryCtrl.refresh("whatever");

    expect(repoSummaryCtrl.demo).toBe(true);
    expect(repoSummaryCtrl.summary).not.toBeNull();
    expect(repoSummaryCtrl.summary!.totalCommits).toBeGreaterThan(0);
    expect(commands.repoSummary).not.toHaveBeenCalled();
  });

  it("maybeAutoShow is a no-op in demo mode", async () => {
    await repoSummaryCtrl.maybeAutoShow("whatever");

    expect(commands.claimRepoSummaryFirstOpen).not.toHaveBeenCalled();
    expect(repoSummaryCtrl.open).toBe(false);
  });
});

describe("maybeAutoShow — real mode (IN_TAURI)", () => {
  it("opens the modal when this is the first open and the repo has commits", async () => {
    vi.mocked(commands.claimRepoSummaryFirstOpen).mockResolvedValueOnce(ok(true));
    vi.mocked(commands.repoSummary).mockResolvedValueOnce(ok(summary()));

    await repoSummaryCtrl.maybeAutoShow("repo1");

    expect(commands.claimRepoSummaryFirstOpen).toHaveBeenCalledWith("repo1");
    expect(commands.repoSummary).toHaveBeenCalledWith("repo1");
    expect(repoSummaryCtrl.open).toBe(true);
  });

  it("does not call repoSummary or open when this is not the first open", async () => {
    vi.mocked(commands.claimRepoSummaryFirstOpen).mockResolvedValueOnce(ok(false));

    await repoSummaryCtrl.maybeAutoShow("repo1");

    expect(commands.repoSummary).not.toHaveBeenCalled();
    expect(repoSummaryCtrl.open).toBe(false);
  });

  it("populates the summary but does not open for an empty/unborn repo's first open", async () => {
    vi.mocked(commands.claimRepoSummaryFirstOpen).mockResolvedValueOnce(ok(true));
    vi.mocked(commands.repoSummary).mockResolvedValueOnce(ok(summary({ totalCommits: 0 })));

    await repoSummaryCtrl.maybeAutoShow("repo1");

    expect(repoSummaryCtrl.summary?.totalCommits).toBe(0);
    expect(repoSummaryCtrl.open).toBe(false);
  });

  it("does not open when the claim call itself errors", async () => {
    vi.mocked(commands.claimRepoSummaryFirstOpen).mockResolvedValueOnce(err("boom"));

    await repoSummaryCtrl.maybeAutoShow("repo1");

    expect(commands.repoSummary).not.toHaveBeenCalled();
    expect(repoSummaryCtrl.open).toBe(false);
  });

  it("a thrown claim rejection is caught and never opens the modal", async () => {
    vi.mocked(commands.claimRepoSummaryFirstOpen).mockRejectedValueOnce(new Error("boom"));

    await expect(repoSummaryCtrl.maybeAutoShow("repo1")).resolves.toBeUndefined();

    expect(repoSummaryCtrl.open).toBe(false);
  });

  it("is a no-op with no repo open", async () => {
    await repoSummaryCtrl.maybeAutoShow(null);

    expect(commands.claimRepoSummaryFirstOpen).not.toHaveBeenCalled();
    expect(repoSummaryCtrl.open).toBe(false);
  });

  // Regression: refresh() below is a real git-log walk that can take long
  // enough for the user to click into a commit's Detail view before it
  // resolves — the modal must not steal them back out of it once it does
  // ("加载统计又会回到统计界面").
  it("does not force-open when the user has since selected a commit in Detail", async () => {
    vi.mocked(commands.claimRepoSummaryFirstOpen).mockResolvedValueOnce(ok(true));
    vi.mocked(commands.repoSummary).mockResolvedValueOnce(ok(summary()));
    detailCtrl.commit = { row: 0, subject: "picked mid-load", sha: "abc123" } as any;

    await repoSummaryCtrl.maybeAutoShow("repo1");

    expect(commands.repoSummary).toHaveBeenCalledWith("repo1"); // data still loads...
    expect(repoSummaryCtrl.summary?.totalCommits).toBeGreaterThan(0); // ...and stays available...
    expect(repoSummaryCtrl.open).toBe(false); // ...it just doesn't pop over Detail.
  });

  it("still opens normally once Detail is empty again (no commit selected)", async () => {
    vi.mocked(commands.claimRepoSummaryFirstOpen).mockResolvedValueOnce(ok(true));
    vi.mocked(commands.repoSummary).mockResolvedValueOnce(ok(summary()));
    detailCtrl.commit = null;

    await repoSummaryCtrl.maybeAutoShow("repo1");

    expect(repoSummaryCtrl.open).toBe(true);
  });
});
