import { describe, expect, it, vi } from "vitest";
import { TamaPresentation } from "./actor";
import type { TamaActor } from "./types";

function imageMap(): any {
  return {
    curious: "curious.webp",
    sleep: "sleep.webp",
    thinking: "thinking.webp",
    shocked: "shocked.webp",
    alarm: "alarm.webp",
    happy: "happy.webp",
    confident: "confident.webp",
    hero: "hero.webp",
  };
}

function fakeEnhancedActor(loadResult = true): TamaActor {
  return {
    load: vi.fn().mockResolvedValue(loadResult),
    setState: vi.fn(),
    playGesture: vi.fn(),
    setPointer: vi.fn(),
    clearPointer: vi.fn(),
    setPaused: vi.fn(),
    destroy: vi.fn(),
  };
}

function setup(actorFactory: any) {
  const host = document.createElement("div");
  const mount = document.createElement("div");
  const sprite = document.createElement("img");
  host.append(mount, sprite);
  return {
    host,
    sprite,
    presentation: new TamaPresentation({ host, modelMount: mount, sprite, images: imageMap(), reducedMotion: false, actorFactory }),
  };
}

describe("TamaPresentation", () => {
  it("keeps the sprite fallback when 3D is absent", async () => {
    const { host, sprite, presentation } = setup(vi.fn().mockResolvedValue(null));
    presentation.setState("danger");

    expect(await presentation.load()).toBe(false);
    expect(host.classList.contains("model-active")).toBe(false);
    expect(sprite.dataset.pose).toBe("alarm");
  });

  it("hands the current state to 3D only after it loads", async () => {
    const enhanced = fakeEnhancedActor();
    const { host, presentation } = setup(vi.fn().mockResolvedValue(enhanced));
    presentation.setState("thinking");

    expect(await presentation.load()).toBe(true);
    expect(host.classList.contains("model-active")).toBe(true);
    expect(enhanced.setState).toHaveBeenCalledWith("thinking");
  });

  it("returns to the up-to-date sprite when the renderer becomes unavailable", async () => {
    const enhanced = fakeEnhancedActor();
    let unavailable = () => {};
    const factory = vi.fn(async (callback: () => void) => {
      unavailable = callback;
      return enhanced;
    });
    const { host, sprite, presentation } = setup(factory);
    await presentation.load();
    presentation.setState("celebrate");

    unavailable();

    expect(host.classList.contains("model-active")).toBe(false);
    expect(sprite.dataset.pose).toBe("happy");
    expect(enhanced.destroy).toHaveBeenCalled();
  });
});
