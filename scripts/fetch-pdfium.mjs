#!/usr/bin/env node
// Fetch the PDFium native library for the CURRENT platform into
// src-tauri/resources/pdfium/ — used by the backend PDF rasterizer that powers
// the image/PDF diff preview (issue #37; pdf.js can't run in the WKWebView).
//
// Pinned to one bblanchon/pdfium-binaries release for reproducibility.
// Idempotent (skips if the lib is already present) and NON-FATAL: if the
// download fails (offline, etc.) it warns and exits 0, so `pnpm install` and
// the build still succeed — PDF previews just show an error until the lib is
// fetched. Runs from `postinstall`; can also be run by hand:
//   node scripts/fetch-pdfium.mjs
//
// The binaries are deliberately NOT committed (see .gitignore) — they're ~7 MB
// each and platform-specific. CI fetches them the same way on each runner.

import { existsSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PDFIUM_TAG = "chromium/8009"; // pdfium build 8009 (v153)
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(root, "src-tauri", "resources", "pdfium");

const LIBNAME = { darwin: "libpdfium.dylib", win32: "pdfium.dll", linux: "libpdfium.so" }[process.platform];
if (!LIBNAME) {
  console.warn(`[pdfium] unsupported platform ${process.platform}; skipping`);
  process.exit(0);
}

const dest = join(destDir, LIBNAME);
if (existsSync(dest)) {
  console.log(`[pdfium] already present: ${dest}`);
  process.exit(0);
}

const osKey = { darwin: "mac", win32: "win", linux: "linux" }[process.platform];
const archKey = { arm64: "arm64", x64: "x64" }[process.arch] ?? "x64";
const asset = `pdfium-${osKey}-${archKey}.tgz`;
const url = `https://github.com/bblanchon/pdfium-binaries/releases/download/${PDFIUM_TAG}/${asset}`;

try {
  mkdirSync(destDir, { recursive: true });
  const tmp = join(tmpdir(), `pdfium-fetch-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  const tgz = join(tmp, asset);

  console.log(`[pdfium] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));

  execFileSync("tar", ["-xzf", tgz, "-C", tmp]);
  // The lib lives in lib/ (macOS, Linux) or bin/ (Windows) inside the archive.
  const src = [join(tmp, "lib", LIBNAME), join(tmp, "bin", LIBNAME)].find(existsSync);
  if (!src) throw new Error(`${LIBNAME} not found inside ${asset}`);
  copyFileSync(src, dest);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`[pdfium] installed ${dest}`);
} catch (e) {
  console.warn(
    `[pdfium] fetch failed (${e.message}). PDF previews will be unavailable ` +
      `until you run: node scripts/fetch-pdfium.mjs`,
  );
  // Fatal on CI (the bundled resource is required to build there); non-fatal
  // for a local `pnpm install`, which must never break just because the
  // network is down.
  process.exit(process.env.CI ? 1 : 0);
}
