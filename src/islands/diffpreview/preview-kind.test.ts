import { describe, it, expect } from "vitest";
import { previewKind, formatBytes } from "./preview-kind";

describe("previewKind", () => {
  it("recognizes image extensions (case-insensitive)", () => {
    for (const p of ["a.png", "dir/b.JPG", "c.jpeg", "d.gif", "e.webp", "f.bmp", "g.ico", "h.avif", "logo.SVG"]) {
      expect(previewKind(p)).toBe("image");
    }
  });

  it("recognizes pdf", () => {
    expect(previewKind("docs/report.pdf")).toBe("pdf");
    expect(previewKind("REPORT.PDF")).toBe("pdf");
  });

  it("returns null for non-previewable files", () => {
    for (const p of ["a.ts", "b.bin", "c.txt", "noext", "archive.zip", "font.woff2"]) {
      expect(previewKind(p)).toBeNull();
    }
  });

  it("ignores a dot in a directory name, not the file", () => {
    expect(previewKind("my.assets/readme")).toBeNull();
    expect(previewKind("my.assets/icon.png")).toBe("image");
  });

  it("treats a leading-dot dotfile with no real extension as non-previewable", () => {
    expect(previewKind(".gitignore")).toBeNull();
  });
});

describe("formatBytes", () => {
  it("formats across units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(834)).toBe("834 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(12 * 1024)).toBe("12 KB");
    expect(formatBytes(3.1 * 1024 * 1024)).toBe("3.1 MB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });

  it("guards against bad input", () => {
    expect(formatBytes(-5)).toBe("");
    expect(formatBytes(NaN)).toBe("");
  });
});
