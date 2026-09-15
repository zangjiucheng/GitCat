// Installed BEFORE `import "./legacy/main.ts"` so the capture-phase listeners
// exist even if legacy/main.ts throws during module evaluation.
//
// WHAT THE HOIST BUYS, and what it does not. It does NOT buy dispatch priority:
// listener A is at window-capture, which beats every legacy listener whether
// legacy registered before or after, because legacy listens on `document`
// (legacy/main.ts:1948, :2169, :2182, :2190, :2197, :2206, :2406, :2543) and on
// the canvas element (:1374), never on window-capture. What it buys is CRASH
// SURVIVAL: legacy/main.ts dereferences several ids without `?` at module-eval
// time — $("#undoBtn") at :2397, $("#confirmInput") at :2522, $("#dangerGo") at
// :2525, $("#rowsSel") at :2545 — and because src/main.ts:5 is a bare
// side-effect import, any throw there takes down all 47 island mounts with it.
// This repo has a recorded history of merges silently dropping adjacent
// index.html content, which is exactly how one of those ids goes missing.
//
// IMPORTS ONLY host.ts (-> registry.ts -> compile/dispatch/chord/claim/scopes).
// NOT bindings.ts: that reaches guards.ts -> legacy/bridge -> legacy/main.ts,
// and pulling legacy in here would defeat the hoist entirely.
import { installHost } from "./host.ts";
installHost();
