import { afterEach, describe, expect, it, vi } from "vitest";
import { TamaSpriteActor } from "./sprite-actor";

const images = {
  curious: "/curious.webp",
  sleep: "/sleep.webp",
  thinking: "/thinking.webp",
  shocked: "/shocked.webp",
  alarm: "/alarm.webp",
  happy: "/happy.webp",
  confident: "/confident.webp",
  hero: "/hero.webp",
};

afterEach(() => vi.useRealTimers());

describe("TamaSpriteActor", () => {
  it("commits only the newest pose during rapid state changes", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    const sprite = document.createElement("img");
    const actor = new TamaSpriteActor({ host, sprite, images, reducedMotion: false });

    actor.setState("thinking");
    actor.setState("danger");
    vi.runAllTimers();

    expect(sprite.dataset.pose).toBe("alarm");
    expect(sprite.src).toMatch(/\/alarm\.webp$/);
  });

  it("switches immediately when reduced motion is requested", () => {
    const host = document.createElement("div");
    const sprite = document.createElement("img");
    const actor = new TamaSpriteActor({ host, sprite, images, reducedMotion: true });

    actor.setState("celebrate");

    expect(sprite.dataset.pose).toBe("happy");
    expect(sprite.src).toMatch(/\/happy\.webp$/);
    expect(sprite.classList.contains("swap")).toBe(false);
  });
});
