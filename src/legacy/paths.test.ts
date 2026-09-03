// Tests for the repo-path join behind "Copy full path".
import { describe, expect, it } from "vitest";

import { joinRepoPath } from "./paths.ts";

describe("joinRepoPath", () => {
  // git always prints forward slashes, on every platform. A path pasted into
  // Explorer's address bar or a PowerShell prompt should look native, so the
  // separator comes from the REPO path — the one form we know the OS wrote.
  it("uses backslashes for a Windows repo, and converts git's own slashes", () => {
    expect(joinRepoPath("C:\\Users\\me\\proj", "src/main.rs")).toBe("C:\\Users\\me\\proj\\src\\main.rs");
    expect(joinRepoPath("C:\\Users\\me\\proj", "README.md")).toBe("C:\\Users\\me\\proj\\README.md");
  });

  it("uses forward slashes for a unix repo", () => {
    expect(joinRepoPath("/home/me/proj", "src/main.rs")).toBe("/home/me/proj/src/main.rs");
  });

  // A WSL repo is addressed from Windows as a UNC share, so it is a
  // backslash path even though everything inside the distro is not.
  it("treats a UNC/WSL repo as a backslash path", () => {
    expect(joinRepoPath("\\\\wsl.localhost\\Ubuntu\\home\\me\\proj", "src/main.rs")).toBe(
      "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\src\\main.rs",
    );
  });

  // Trailing separators turn up when a path is assembled elsewhere; a
  // doubled one is ugly in a pasted path and wrong in some shells.
  it("does not double a separator the repo path already ends with", () => {
    expect(joinRepoPath("/home/me/proj/", "a.txt")).toBe("/home/me/proj/a.txt");
    expect(joinRepoPath("C:\\proj\\", "a.txt")).toBe("C:\\proj\\a.txt");
  });

  // The menu is built from a row that always has a path, but the repo can be
  // absent for one frame while a repo is being opened/closed. Returning the
  // relative path is the least surprising thing to put on the clipboard —
  // better than "undefined/src/main.rs".
  it("falls back to the relative path when there is no repo", () => {
    expect(joinRepoPath("", "src/main.rs")).toBe("src/main.rs");
    expect(joinRepoPath(null as unknown as string, "src/main.rs")).toBe("src/main.rs");
  });
});
