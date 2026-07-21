#!/usr/bin/env node
// Builds the isolated `profiling` Cargo profile (see src-tauri/Cargo.toml's
// own [profile.profiling] doc comment for why this is a separate profile,
// not [profile.release] itself) and records a CPU flamegraph of it with
// samply.
//
// Node, not bash (this started as scripts/profile.sh): on a Windows
// machine with WSL installed, a bare `bash` on PATH resolves to WSL's own
// C:\Windows\System32\bash.exe FIRST — a completely separate Linux
// filesystem/environment with no visibility into anything installed via
// the Windows-side `cargo install` (confirmed live: `pnpm flamegraph` kept
// reporting samply missing even though it genuinely existed at
// C:\Users\<user>\.cargo\bin\samply.exe, because the wrong bash was
// running the whole time). Node is already an unambiguous dependency —
// it's the pnpm/npm runtime itself — so there's no equivalent ambiguity to
// sidestep here.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(`Usage: node scripts/profile.mjs [samply-record-args...]

Builds src-tauri in the \`profiling\` profile (release-optimized, but with
full debug info so the flamegraph resolves real function names instead of
raw addresses) and records it with samply.

Any extra arguments are passed through to \`samply record\` itself, after
the default -a (record all processes — needed because Tauri renders
through a separate WebView2 child process on Windows, not just the main
binary). Example: pnpm flamegraph -- --rate 2000

Output: samply opens the Firefox Profiler UI (a local web view — nothing
is uploaded anywhere unless you explicitly click "Upload" in it) with a
flamegraph, stack chart, and call tree once you close the app window.`);
  process.exit(0);
}

// Prefer PATH (works everywhere once a shell's env is actually fresh), but
// don't trust that alone — see this file's own header comment on why a
// freshly-installed cargo binary's PATH update often isn't visible to
// whatever spawned this process. `cargo install` (no --root override)
// always puts it in ~/.cargo/bin on every platform, so check there too
// before giving up.
function findSamply() {
  const exeName = process.platform === "win32" ? "samply.exe" : "samply";
  const onPath = spawnSync(exeName, ["--version"], { stdio: "ignore" });
  if (!onPath.error) return exeName;

  const fallback = join(homedir(), ".cargo", "bin", exeName);
  if (existsSync(fallback)) return fallback;

  console.error("error: samply isn't on PATH and isn't at ~/.cargo/bin either — install it once with:");
  console.error("  cargo install --locked samply");
  process.exit(1);
}

const samply = findSamply();

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const srcTauri = join(scriptDir, "..", "src-tauri");

console.error("Building src-tauri (profiling profile)...");
const build = spawnSync("cargo", ["build", "--profile", "profiling"], { cwd: srcTauri, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const exeName = process.platform === "win32" ? "gitcat.exe" : "gitcat";
const bin = join(srcTauri, "target", "profiling", exeName);

console.error(`Recording with ${samply} -a ${bin} ${args.join(" ")}`);
console.error("(close the GitCat window when you're done to end the recording)");
const record = spawnSync(samply, ["record", "-a", bin, ...args], { stdio: "inherit" });
process.exit(record.status ?? 1);
