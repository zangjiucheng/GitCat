import { describe, expect, it } from "vitest";
import { TAMA_SPRITE_POSES, TAMA_STATES } from "./types";

describe("Tama visual mappings", () => {
  it("maps every FSM state to a sprite fallback pose", () => {
    expect(Object.keys(TAMA_SPRITE_POSES).sort()).toEqual([...TAMA_STATES].sort());
  });
});
