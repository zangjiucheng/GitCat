import { TamaSpriteActor } from "./sprite-actor";
import type { TamaActor, TamaGesture, TamaPose, TamaState } from "./types";

type PresentationOptions = {
  host: HTMLElement;
  modelMount: HTMLElement;
  sprite: HTMLImageElement;
  images: Record<TamaPose, string>;
  reducedMotion: boolean;
  actorFactory?: (onUnavailable: () => void) => Promise<TamaActor | null>;
};

export class TamaPresentation implements TamaActor {
  private readonly host: HTMLElement;
  private readonly fallback: TamaSpriteActor;
  private readonly actorFactory: (onUnavailable: () => void) => Promise<TamaActor | null>;
  private enhanced: TamaActor | null = null;
  private state: TamaState = "idle";
  private paused = false;
  private destroyed = false;

  constructor(options: PresentationOptions) {
    this.host = options.host;
    this.fallback = new TamaSpriteActor(options);
    this.actorFactory =
      options.actorFactory ??
      (async (onUnavailable) => {
        if (options.reducedMotion) return null;
        const { createTama3DActor } = await import("./three-actor");
        return createTama3DActor({ mount: options.modelMount, onUnavailable });
      });
  }

  async load(): Promise<boolean> {
    await this.fallback.load();
    try {
      const enhanced = await this.actorFactory(() => this.useFallback());
      if (!enhanced || this.destroyed) {
        enhanced?.destroy();
        return false;
      }
      if (!(await enhanced.load()) || this.destroyed) {
        enhanced.destroy();
        return false;
      }
      this.enhanced = enhanced;
      enhanced.setState(this.state);
      enhanced.setPaused(this.paused);
      this.fallback.clearPointer();
      this.host.classList.add("model-active");
      return true;
    } catch (error) {
      console.debug("Tama 3D unavailable; keeping the sprite fallback.", error);
      this.useFallback();
      return false;
    }
  }

  setState(state: TamaState): void {
    this.state = state;
    // Keep the hidden sprite current so a runtime failure can reveal the
    // correct pose immediately, without a stale-frame flash.
    this.fallback.setState(state);
    this.enhanced?.setState(state);
  }

  playGesture(gesture: TamaGesture): void {
    if (this.enhanced) this.enhanced.playGesture(gesture);
    else this.fallback.playGesture(gesture);
  }

  setPointer(clientX: number, clientY: number): void {
    if (this.enhanced) this.enhanced.setPointer(clientX, clientY);
    else this.fallback.setPointer(clientX, clientY);
  }

  clearPointer(): void {
    this.enhanced?.clearPointer();
    this.fallback.clearPointer();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.enhanced?.setPaused(paused);
    this.fallback.setPaused(paused);
  }

  destroy(): void {
    this.destroyed = true;
    this.host.classList.remove("model-active");
    this.enhanced?.destroy();
    this.enhanced = null;
    this.fallback.destroy();
  }

  private useFallback(): void {
    this.host.classList.remove("model-active");
    this.enhanced?.destroy();
    this.enhanced = null;
    this.fallback.setState(this.state);
  }
}

export function createTamaPresentation(options: PresentationOptions): TamaPresentation {
  return new TamaPresentation(options);
}
