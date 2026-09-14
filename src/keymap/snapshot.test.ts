// The drift gate for the table itself. One sorted line per binding, committed
// as a snapshot — so every later PR in the keyboard stack shows up in review as
// an explicit diff of what changed about which chord, in which scope, under
// which guards, rather than as a wall of new table rows nobody reads.
//
// A snapshot that "just needs updating" is the signal to look twice: the ⌘⇧F
// double-binding would have shown up here the day it landed.
import { expect, it, vi } from "vitest";

vi.mock("@/legacy/bridge", () => ({ CUR_REPO: "/repo", G: { N: 0 } }));

import { BINDINGS } from "./bindings.ts";
import { dumpKeymap } from "./compile.ts";

it("the keymap table matches its committed snapshot", () => {
  expect(dumpKeymap(BINDINGS)).toMatchSnapshot();
});
