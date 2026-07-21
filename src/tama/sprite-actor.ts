import { TAMA_SPRITE_POSES, type TamaActor, type TamaGesture, type TamaPose, type TamaState } from "./types";

type SpriteActorOptions = {
  host: HTMLElement;
  sprite: HTMLImageElement;
  images: Record<TamaPose, string>;
  reducedMotion: boolean;
};

export class TamaSpriteActor implements TamaActor {
  private readonly host: HTMLElement;
  private readonly sprite: HTMLImageElement;
  private readonly images: Record<TamaPose, string>;
  private readonly reducedMotion: boolean;
  private swapToken = 0;
  private swapOutTimer: ReturnType<typeof setTimeout> | undefined;
  private swapInTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: SpriteActorOptions) {
    this.host = options.host;
    this.sprite = options.sprite;
    this.images = options.images;
    this.reducedMotion = options.reducedMotion;
  }

  async load(): Promise<boolean> {
    return true;
  }

  setState(state: TamaState): void {
    const pose = TAMA_SPRITE_POSES[state];
    if (this.sprite.dataset.pose === pose) return;

    this.sprite.dataset.pose = pose;
    const token = ++this.swapToken;
    clearTimeout(this.swapOutTimer);
    clearTimeout(this.swapInTimer);

    if (this.reducedMotion) {
      this.sprite.src = this.images[pose];
      this.sprite.classList.remove("swap", "swap-in");
      return;
    }

    this.sprite.classList.remove("swap-in");
    this.sprite.classList.add("swap");
    this.swapOutTimer = setTimeout(() => {
      if (token !== this.swapToken) return;
      this.sprite.src = this.images[pose];
      this.sprite.classList.remove("swap");
      void this.sprite.offsetWidth;
      this.sprite.classList.add("swap-in");
      this.swapInTimer = setTimeout(() => {
        if (token === this.swapToken) this.sprite.classList.remove("swap-in");
      }, 240);
    }, 110);
  }

  playGesture(gesture: TamaGesture): void {
    if (this.reducedMotion) return;
    const className = gesture === "nod" ? "nod" : "glance";
    const target = gesture === "nod" ? this.sprite : this.host;
    target.classList.remove(className);
    void target.offsetWidth;
    target.classList.add(className);
  }

  setPointer(clientX: number, clientY: number): void {
    if (this.reducedMotion) return;
    const rect = this.sprite.getBoundingClientRect();
    if (!rect.width) return;
    const centerX = rect.left + rect.width * 0.5;
    const centerY = rect.top + rect.height * 0.4;
    const dx = clientX - centerX;
    const dy = clientY - centerY;
    const distance = Math.hypot(dx, dy) || 1;
    const magnitude = Math.min(1, distance / 220);
    const x = ((dx / distance) * magnitude * 2.2).toFixed(2);
    const y = ((dy / distance) * magnitude * 1.6).toFixed(2);
    const rotation = ((dx / distance) * magnitude * 1.6).toFixed(2);
    this.host.style.transform = `translate(${x}px,${y}px) rotate(${rotation}deg)`;
  }

  setPaused(_paused: boolean): void {
    // CSS on .nook.is-interacting pauses the fallback animations.
  }

  clearPointer(): void {
    this.host.style.transform = "";
  }

  destroy(): void {
    this.swapToken++;
    clearTimeout(this.swapOutTimer);
    clearTimeout(this.swapInTimer);
    this.sprite.classList.remove("swap", "swap-in", "nod");
    this.host.classList.remove("glance");
    this.clearPointer();
  }
}
