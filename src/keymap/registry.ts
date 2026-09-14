// The registry singleton. Plain .ts, NOT .svelte.ts: PR 1 renders nothing from
// the scope stack, and this module is imported at src/main.ts line 5 — before
// any component exists — where a rune would need $effect.root wrapping
// (lazyisland.svelte.ts:59 is the repo's only precedent) for zero benefit.
// Rename to .svelte.ts in the PR that first renders the stack (the keymap-debug
// overlay, or the generated help).

import type { Platform } from "./chord.ts";
import { compile, dumpKeymap } from "./compile.ts";
import { dispatch as pureDispatch } from "./dispatch.ts";
import type { ScopeHandle, ScopeId, ScopeSpec } from "./scopes.ts";
import type { Binding, GuardTable, Tables } from "./types.ts";
import { claim } from "./claim.ts";

const EMPTY: Tables = {
  byCode: new Map(), byKey: new Map(), always: [],
  escapeByScope: new Map(), byId: new Map(), size: 0,
};

export interface KeymapDump {
  readonly stack: readonly { id: ScopeId; rank: number; modal: boolean; owner?: string }[];
  readonly bindings: readonly { id: string; chords: readonly string[]; scope: ScopeId; mode: string }[];
  /** id -> times run() actually fired. */
  readonly fires: Readonly<Record<string, number>>;
  /** id -> times a SHADOW binding matched. The equivalence measurement: an e2e
   *  press must show 1 here AND the legacy effect before a binding may flip. */
  readonly shadow: Readonly<Record<string, number>>;
  readonly snapshot: string;
}

function detectPlatform(): Platform {
  const p = navigator.platform || "";
  const ua = navigator.userAgent || "";
  if (/Mac|iP(hone|ad|od)/.test(p) || /Mac OS X/.test(ua)) return "macos";
  if (/Win/.test(p) || /Windows/.test(ua)) return "win";
  return "linux";
}

class Keymap {
  private tables: Tables = EMPTY;
  private bindings: readonly Binding[] = [];
  private specs = new Map<ScopeId, ScopeSpec>();
  private stack: ScopeId[] = ["global"];
  private tokens: number[] = [0];
  private nextToken = 1;
  private readonly platform: Platform = detectPlatform();
  readonly fires: Record<string, number> = {};
  readonly shadow: Record<string, number> = {};

  get size(): number { return this.tables.size; }

  /** Called ONCE, from src/main.ts's module body. Throws on an illegal table —
   *  which is loud at boot and, because compile() is the same function CI runs,
   *  impossible to reach without CI having failed first. */
  register(bindings: readonly Binding[], guards: GuardTable): void {
    this.bindings = bindings;
    this.tables = compile(bindings, guards);
  }

  defineScope(spec: ScopeSpec): void {
    if (this.specs.has(spec.id)) throw new Error(`keymap: scope "${spec.id}" already defined`);
    this.specs.set(spec.id, spec);
  }

  /**
   * Push a scope. PR 1 has no callers — the API ships so PR 2 onward is purely
   * additive. Call it from the always-eager CONTROLLER, never from the view:
   * lazyisland.svelte.ts:61-65 sets `started = true` BEFORE awaiting the
   * dynamic import, so a view-side push leaves the scope absent for a whole
   * chunk fetch after `open` flips — and the Escape path would then resolve
   * against the scope underneath. lazyisland.svelte.ts:8-11 states the
   * invariant that makes controller-side registration safe.
   */
  pushScope(id: ScopeId): ScopeHandle {
    const spec = this.specs.get(id);
    if (!spec) throw new Error(`keymap: scope "${id}" was never defineScope()d`);
    const token = this.nextToken++;
    let i = this.stack.length;
    while (i > 0 && (this.specs.get(this.stack[i - 1])?.rank ?? 0) > spec.rank) i--;
    this.stack.splice(i, 0, id);
    this.tokens.splice(i, 0, token);
    let released = false;
    return {
      id, token,
      release: () => {
        if (released) return; // idempotent — a double release must not pop someone else's scope
        released = true;
        const k = this.tokens.indexOf(token);
        if (k >= 0) { this.stack.splice(k, 1); this.tokens.splice(k, 1); }
      },
    };
  }

  /** Called only by host.ts. Returns true iff the event was claimed. */
  handle(e: KeyboardEvent): boolean {
    if (this.tables.size === 0) return false;
    const r = pureDispatch(e, this.stack, this.specs, this.tables, this.platform);
    for (let i = 0; i < r.shadowed.length; i++) {
      const id = r.shadowed[i].b.id;
      this.shadow[id] = (this.shadow[id] ?? 0) + 1;
    }
    if (!r.ran) return false;
    this.fires[r.ran.b.id] = (this.fires[r.ran.b.id] ?? 0) + 1;
    if (r.preventDefault) e.preventDefault();
    if (r.claim) claim(e);
    return r.claim;
  }

  dump(): KeymapDump {
    return {
      stack: this.stack.map((id) => {
        const s = this.specs.get(id);
        return { id, rank: s?.rank ?? 0, modal: !!s?.modal, owner: s?.owner };
      }),
      bindings: this.bindings.map((b) => ({
        id: b.id, chords: b.chords, scope: b.scope, mode: b.mode ?? "live",
      })),
      fires: { ...this.fires },
      shadow: { ...this.shadow },
      snapshot: dumpKeymap(this.bindings),
    };
  }

  resetCounters(): void {
    for (const k of Object.keys(this.fires)) delete this.fires[k];
    for (const k of Object.keys(this.shadow)) delete this.shadow[k];
  }
}

export const keymap = new Keymap();

// Playwright cannot import a module, so the shadow counters need a DOM-reachable
// handle. Dev-only, same gate legacy/main.ts:2559 uses for the perf HUD.
if (import.meta.env.DEV) {
  (window as unknown as { __keymap?: unknown }).__keymap = keymap;
}
