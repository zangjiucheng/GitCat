// The working tree's key actions. The interesting assertions are the DECLINES:
// a key that cannot act here must return false so it keeps falling outward,
// rather than being swallowed and appearing broken.
import { beforeEach, describe, expect, it, vi } from "vitest";

let repo: string | null = "/repo";
vi.mock("@/legacy/bridge", () => ({
  get CUR_REPO() {
    return repo;
  },
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  reloadGraph: vi.fn(async () => {}),
  armDanger: vi.fn(),
  requestRedraw: vi.fn(),
  highlight: (t: string) => t,
}));

const ctrl = vi.hoisted(() => ({
  busy: false,
  amend: false,
  commit: vi.fn(async () => {}),
  stageFile: vi.fn(async () => {}),
  unstageFile: vi.fn(async () => {}),
  stageAll: vi.fn(async () => {}),
  unstageAll: vi.fn(async () => {}),
  confirmDiscard: vi.fn(),
}));
vi.mock("@/islands/workdir/workdir.svelte.ts", () => ({ workdirCtrl: ctrl }));

import { focusedRow, workdirKeys } from "./workdir.ts";

/** Render one row and focus it (or one of its buttons). */
function row(opts: { path: string; staged: boolean; untracked?: boolean; focusButton?: boolean }) {
  document.body.innerHTML = `
    <div class="wd-file" tabindex="0" id="row"
         data-wd-path="${opts.path}"
         data-wd-staged="${opts.staged}"
         data-wd-untracked="${opts.untracked ?? false}">
      <button id="act">reveal</button>
    </div>`;
  document.getElementById(opts.focusButton ? "act" : "row")!.focus();
}

beforeEach(() => {
  repo = "/repo";
  document.body.innerHTML = "";
  ctrl.busy = false;
  ctrl.amend = false;
  vi.clearAllMocks();
});

describe("focusedRow", () => {
  it("reads the row under focus", () => {
    row({ path: "src/a.ts", staged: false, untracked: true });
    expect(focusedRow()).toEqual({ path: "src/a.ts", staged: false, untracked: true });
  });

  it("finds the row from one of its own action buttons", () => {
    // Those buttons deliberately stayed in the tab order — they are the only
    // keyboard route to reveal/copy — so a key pressed there must still act on
    // the row they belong to.
    row({ path: "src/a.ts", staged: true, focusButton: true });
    expect(focusedRow()?.path).toBe("src/a.ts");
  });

  it("is null when focus is nowhere near a row", () => {
    document.body.innerHTML = `<button id="x"></button>`;
    document.getElementById("x")!.focus();
    expect(focusedRow()).toBeNull();
  });
});

describe("stage / unstage", () => {
  it("stages the focused unstaged row", () => {
    row({ path: "a.ts", staged: false });
    expect(workdirKeys.stage()).toBeUndefined();
    expect(ctrl.stageFile).toHaveBeenCalledWith("/repo", "a.ts");
  });

  it("declines to stage a row that is already staged", () => {
    // Rather than issuing a no-op git call the user cannot see the result of.
    row({ path: "a.ts", staged: true });
    expect(workdirKeys.stage()).toBe(false);
    expect(ctrl.stageFile).not.toHaveBeenCalled();
  });

  it("unstages the focused staged row, and declines on an unstaged one", () => {
    row({ path: "a.ts", staged: true });
    expect(workdirKeys.unstage()).toBeUndefined();
    expect(ctrl.unstageFile).toHaveBeenCalledWith("/repo", "a.ts");

    row({ path: "b.ts", staged: false });
    expect(workdirKeys.unstage()).toBe(false);
  });

  it("declines every row action with no focused row", () => {
    document.body.innerHTML = "";
    expect(workdirKeys.stage()).toBe(false);
    expect(workdirKeys.unstage()).toBe(false);
    expect(workdirKeys.discard()).toBe(false);
  });

  it("declines while the controller is busy", () => {
    row({ path: "a.ts", staged: false });
    ctrl.busy = true;
    expect(workdirKeys.stage()).toBe(false);
    expect(workdirKeys.stageAll()).toBe(false);
    expect(ctrl.stageFile).not.toHaveBeenCalled();
  });

  it("declines with no repo open", () => {
    row({ path: "a.ts", staged: false });
    repo = null;
    expect(workdirKeys.stage()).toBe(false);
    expect(workdirKeys.stageAll()).toBe(false);
  });
});

describe("bulk", () => {
  it("stages and unstages everything without needing a focused row", () => {
    expect(workdirKeys.stageAll()).toBeUndefined();
    expect(ctrl.stageAll).toHaveBeenCalledWith("/repo");
    expect(workdirKeys.unstageAll()).toBeUndefined();
    expect(ctrl.unstageAll).toHaveBeenCalledWith("/repo");
  });
});

describe("commit", () => {
  /** Focus the commit box, or another field in the same pane. */
  function field(kind: "commit" | "stash") {
    document.body.innerHTML =
      kind === "commit"
        ? `<textarea id="f" data-wd-commit-box></textarea>`
        : `<input id="f">`;
    document.getElementById("f")!.focus();
  }

  it("fires from the commit box, which is the point of allowInTextInput", () => {
    field("commit");
    expect(workdirKeys.commit(false)).toBeUndefined();
    expect(ctrl.commit).toHaveBeenCalledWith("/repo");
  });

  it("DECLINES from any other field in the pane", () => {
    // The stash message input lives in the same pane. ⌘↵ there means "submit
    // this form" — committing staged changes instead would be the worst kind
    // of surprise, and capture-phase dispatch would also suppress the field's
    // own Enter handler on the way.
    field("stash");
    expect(workdirKeys.commit(false)).toBe(false);
    expect(workdirKeys.commit(true)).toBe(false);
    expect(ctrl.commit).not.toHaveBeenCalled();
  });

  it("commits without touching the amend toggle", () => {
    expect(workdirKeys.commit(false)).toBeUndefined();
    expect(ctrl.commit).toHaveBeenCalledWith("/repo");
    expect(ctrl.amend).toBe(false);
  });

  it("sets the amend toggle before committing, like the button does", () => {
    expect(workdirKeys.commit(true)).toBeUndefined();
    expect(ctrl.amend).toBe(true);
    expect(ctrl.commit).toHaveBeenCalledWith("/repo");
  });

  it("declines with no repo, and while busy", () => {
    repo = null;
    expect(workdirKeys.commit(false)).toBe(false);
    repo = "/repo";
    ctrl.busy = true;
    expect(workdirKeys.commit(false)).toBe(false);
    expect(ctrl.commit).not.toHaveBeenCalled();
  });
});

describe("discard", () => {
  it("routes through the same confirmation the context menu uses", () => {
    // A bare letter must never reach an irreversible git operation directly.
    row({ path: "junk.txt", staged: false, untracked: true });
    expect(workdirKeys.discard()).toBeUndefined();
    expect(ctrl.confirmDiscard).toHaveBeenCalledWith("junk.txt", true);
  });

  it("passes the tracked flag through, so the right git op is chosen", () => {
    row({ path: "a.ts", staged: false, untracked: false });
    workdirKeys.discard();
    expect(ctrl.confirmDiscard).toHaveBeenCalledWith("a.ts", false);
  });

  it("declines on a STAGED row", () => {
    // Discarding a staged row is unstage-then-discard: two undoable steps
    // presented as one irreversible key. The context menu does not offer it
    // either.
    row({ path: "a.ts", staged: true });
    expect(workdirKeys.discard()).toBe(false);
    expect(ctrl.confirmDiscard).not.toHaveBeenCalled();
  });
});
