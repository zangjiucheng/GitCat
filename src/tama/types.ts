export const TAMA_STATES = [
  "idle",
  "sleep",
  "hint",
  "thinking",
  "warn",
  "danger",
  "celebrate",
  "rescue",
  "confused",
  "curious",
  "syncing",
  "greeting",
] as const;

export type TamaState = (typeof TAMA_STATES)[number];

export const TAMA_POSES = ["curious", "sleep", "thinking", "shocked", "alarm", "happy", "confident", "hero"] as const;
export type TamaPose = (typeof TAMA_POSES)[number];

export type TamaGesture = "nod" | "glance";

export interface TamaActor {
  load(): Promise<boolean>;
  setState(state: TamaState): void;
  playGesture(gesture: TamaGesture): void;
  setPointer(clientX: number, clientY: number): void;
  clearPointer(): void;
  setPaused(paused: boolean): void;
  destroy(): void;
}

export const TAMA_SPRITE_POSES: Record<TamaState, TamaPose> = {
  idle: "curious",
  sleep: "sleep",
  hint: "curious",
  thinking: "thinking",
  warn: "shocked",
  danger: "alarm",
  celebrate: "happy",
  rescue: "confident",
  confused: "shocked",
  curious: "curious",
  syncing: "thinking",
  greeting: "hero",
};
