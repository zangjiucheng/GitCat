// Tests for commit-message draft persistence. Pure module, no runes, no
// mounting — same split as detailpanel/splitter.ts and its callers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCommitDraft, loadCommitDraft, saveCommitDraft } from "./commitdraft.ts";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("round trip", () => {
  it("stores and reads a draft per repo", () => {
    saveCommitDraft("/a", "work in progress");
    saveCommitDraft("/b", "something else");
    expect(loadCommitDraft("/a")).toBe("work in progress");
    expect(loadCommitDraft("/b")).toBe("something else");
  });

  it("returns '' for a repo with no draft", () => {
    expect(loadCommitDraft("/never-opened")).toBe("");
  });

  it("keeps the newlines a real commit message has", () => {
    const msg = "feat: subject line\n\nA body paragraph.\n\n- one\n- two\n";
    saveCommitDraft("/a", msg);
    expect(loadCommitDraft("/a")).toBe(msg);
  });
});

describe("clearing", () => {
  // An empty box means the draft is done with. Storing "" instead of removing
  // would leave one dead key per repo ever opened.
  it("an empty or whitespace-only message removes the entry entirely", () => {
    saveCommitDraft("/a", "typed then deleted");
    saveCommitDraft("/a", "   \n  ");
    expect(loadCommitDraft("/a")).toBe("");
    expect(localStorage.getItem("gitcat.commitDraft:/a")).toBeNull();
  });

  it("clearCommitDraft removes only that repo's draft", () => {
    saveCommitDraft("/a", "keep me");
    saveCommitDraft("/b", "drop me");
    clearCommitDraft("/b");
    expect(loadCommitDraft("/a")).toBe("keep me");
    expect(loadCommitDraft("/b")).toBe("");
  });
});

describe("hostile inputs", () => {
  it("ignores an empty repo path instead of writing a global draft", () => {
    saveCommitDraft("", "nowhere");
    expect(localStorage.length).toBe(0);
    expect(loadCommitDraft("")).toBe("");
  });

  it("truncates past 32 KB so one repo cannot exhaust the origin's quota", () => {
    saveCommitDraft("/a", "x".repeat(40_000));
    expect(loadCommitDraft("/a")).toHaveLength(32 * 1024);
  });

  // Reading and writing both throw in a private window with storage disabled.
  // Losing a draft there is acceptable; taking the commit panel down with it
  // is not.
  it("survives storage being disabled", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => saveCommitDraft("/a", "anything")).not.toThrow();
    expect(loadCommitDraft("/a")).toBe("");
  });
});
