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
//
// Starts the SAME Vite dev server tauri.conf.json's own beforeDevCommand
// starts for `tauri dev` ("pnpm dev"), and for the same reason: whether the
// compiled binary loads tauri.conf.json's devUrl (http://localhost:1420) or
// its bundled frontendDist is decided by the `custom-protocol` Cargo
// feature (see tauri's own build.rs — `dev = !custom_protocol`), NOT by the
// build profile at all. A plain `cargo build` (profiling or otherwise)
// never enables that feature, so the compiled binary ALWAYS expects
// devUrl — confirmed live: without Vite running, GitCat's own window showed
// "localhost refused to connect" trying to load http://localhost:1420 with
// nothing listening there. Skips starting a new one if something's already
// listening on that port (e.g. an existing `pnpm tauri dev` session),
// rather than failing on a port conflict.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";

const DEV_SERVER_PORT = 1420;
const DEV_SERVER_HOST = "localhost";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(`Usage: node scripts/profile.mjs [samply-record-args...]

Builds src-tauri in the \`profiling\` profile (release-optimized, but with
full debug info so the flamegraph resolves real function names instead of
raw addresses), starts the same Vite dev server \`tauri dev\` uses (the
compiled binary needs it regardless of build profile — see this file's own
header comment for why), and records the app with samply.

Any extra arguments are passed through to \`samply record\` itself.
Example: pnpm flamegraph -- --rate 2000

Note: this profiles the gitcat.exe process itself (the Rust backend) —
Tauri also renders through a separate WebView2 (Chromium) child process on
Windows that this does NOT capture (samply's -a/--all, which profiles the
whole system instead, can't be combined with launching a specific command
at all — it's one or the other). For Rust-side hot-path analysis (git2
calls, run_blocking tasks, etc.) that's the process that matters; if you
specifically need the WebView2/JS side too, run \`samply record -a\`
yourself with no command, in a separate terminal, while GitCat is already
running.

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

function isPortOpen(port, host) {
  return new Promise((resolve) => {
    const socket = connect({ port, host, timeout: 500 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port, host)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const samply = findSamply();

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(scriptDir, "..");
const srcTauri = join(repoRoot, "src-tauri");

let viteChild = null;
let startedOwnVite = false;

async function ensureDevServer() {
  if (await isPortOpen(DEV_SERVER_PORT, DEV_SERVER_HOST)) {
    console.error(`Reusing whatever's already listening on ${DEV_SERVER_HOST}:${DEV_SERVER_PORT} (looks like a dev server).`);
    return;
  }
  console.error("Starting the Vite dev server (same as `tauri dev`'s own beforeDevCommand)...");
  // Single command string, not `spawn("pnpm", ["dev"], {shell: true})` — the
  // latter triggers Node's DEP0190 warning (args passed alongside
  // shell:true aren't escaped, only concatenated) since pnpm on Windows is
  // a .cmd/.ps1 shim that spawn can't invoke directly without a shell.
  viteChild = spawn("pnpm dev", { cwd: repoRoot, stdio: "ignore", shell: true });
  startedOwnVite = true;
  const ready = await waitForPort(DEV_SERVER_PORT, DEV_SERVER_HOST, 20_000);
  if (!ready) {
    console.error(`error: Vite never started listening on ${DEV_SERVER_HOST}:${DEV_SERVER_PORT} within 20s.`);
    cleanupVite();
    process.exit(1);
  }
}

function cleanupVite() {
  if (viteChild && startedOwnVite) {
    viteChild.kill();
  }
}

process.on("exit", cleanupVite);
process.on("SIGINT", () => {
  cleanupVite();
  process.exit(130);
});

await ensureDevServer();

console.error("Building src-tauri (profiling profile)...");
const build = spawnSync("cargo", ["build", "--profile", "profiling"], { cwd: srcTauri, stdio: "inherit" });
if (build.status !== 0) {
  cleanupVite();
  process.exit(build.status ?? 1);
}

const exeName = process.platform === "win32" ? "gitcat.exe" : "gitcat";
const bin = join(srcTauri, "target", "profiling", exeName);

console.error(`Recording with ${samply} ${bin} ${args.join(" ")}`);
console.error("(close the GitCat window when you're done to end the recording)");
const record = spawnSync(samply, ["record", bin, ...args], { stdio: "inherit" });
cleanupVite();
process.exit(record.status ?? 1);
