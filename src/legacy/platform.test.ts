// Tests for the platform sniffer behind the reveal-in-file-manager label.
//
// Pure string work over a user-agent, so unlike its neighbours this leaf
// needs no bridge/ipc mocking — it imports nothing.
import { describe, expect, it } from "vitest";

import { currentPlatform, openDirLabelKey, revealLabelKey } from "./platform.ts";

// Real user-agent strings, as the webview reports them on each platform.
// Chromium reports macOS as "Macintosh; Intel Mac OS X" even on Apple
// silicon, so an arm64 Mac is NOT a separate case to handle here.
const UA = {
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  macIntel:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  macArm:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  linux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

describe("currentPlatform", () => {
  it("recognizes the three desktop platforms GitCat ships on", () => {
    expect(currentPlatform(UA.windows)).toBe("windows");
    expect(currentPlatform(UA.macIntel)).toBe("macos");
    expect(currentPlatform(UA.macArm)).toBe("macos");
    expect(currentPlatform(UA.linux)).toBe("linux");
  });

  // Every non-Windows, non-Mac desktop this app can run on is a Linux-ish
  // one, and the Linux label ("file manager") is the generic of the three —
  // so an unrecognized UA landing there degrades to a still-true label
  // rather than telling a Linux user about Explorer.
  it("falls back to linux for anything it does not recognize", () => {
    expect(currentPlatform("")).toBe("linux");
    expect(currentPlatform("Mozilla/5.0 (X11; FreeBSD amd64)")).toBe("linux");
    expect(currentPlatform("something else entirely")).toBe("linux");
  });

  // "Windows NT" must be matched before "Mac"/"Linux": a Windows UA contains
  // neither, but this pins the order so a future edit can't reintroduce the
  // classic bug where "X11; Linux" inside a spoofed Windows UA wins.
  it("prefers Windows when a UA mentions more than one platform", () => {
    expect(currentPlatform("Mozilla/5.0 (Windows NT 10.0) like Macintosh Linux")).toBe("windows");
  });
});

describe("revealLabelKey", () => {
  // The whole point of the platform sniff: Windows users read "File
  // Explorer", Mac users read "Finder", and neither name is right for the
  // other. Keys are returned whole (never assembled from a fragment) so a
  // grep for the key finds this line.
  it("maps each platform to its own label key", () => {
    expect(revealLabelKey("windows")).toBe("common.reveal_windows");
    expect(revealLabelKey("macos")).toBe("common.reveal_macos");
    expect(revealLabelKey("linux")).toBe("common.reveal_linux");
  });
});

describe("openDirLabelKey", () => {
  // A repo and a file want different verbs even though they name the same
  // application: a file gets REVEALED (its folder opens with the file
  // selected), a repo gets OPENED (you land inside it). Two key families,
  // not one — see the menus in Detail/Workdir vs the repo chip.
  it("maps each platform to its own label key", () => {
    expect(openDirLabelKey("windows")).toBe("common.open_dir_windows");
    expect(openDirLabelKey("macos")).toBe("common.open_dir_macos");
    expect(openDirLabelKey("linux")).toBe("common.open_dir_linux");
  });

  it("is a different key from the reveal one on every platform", () => {
    for (const p of ["windows", "macos", "linux"] as const) {
      expect(openDirLabelKey(p)).not.toBe(revealLabelKey(p));
    }
  });
});
