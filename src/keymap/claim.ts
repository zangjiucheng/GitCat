// The claim mark. A WeakSet of KeyboardEvents the registry has taken
// responsibility for. host.ts's second listener turns a claim into a
// stopImmediatePropagation() at document-capture, which is upstream of the
// canvas target phase, of all 8 legacy document-bubble handlers, of
// src/main.ts:545/:565, and of all 36 island <svelte:window> handlers.
//
// In PR 1 NOTHING calls claim(): every binding is mode:"shadow". That is what
// makes this PR provably inert rather than argued-inert.
//
// Zero imports on purpose — see chord.ts's header for the three reasons.
const CLAIMED = new WeakSet<KeyboardEvent>();
export function claim(e: KeyboardEvent): void { CLAIMED.add(e); }
export function isClaimed(e: Event): boolean { return CLAIMED.has(e as KeyboardEvent); }
