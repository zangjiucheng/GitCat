// Platform detection, split out of registry.ts so the help overlay can format a
// chord without importing the registry singleton (and with it the whole
// dispatcher) into a view.
import type { Platform } from "./chord.ts";

export function platform(): Platform {
  const p = navigator.platform || "";
  const ua = navigator.userAgent || "";
  if (/Mac|iP(hone|ad|od)/.test(p) || /Mac OS X/.test(ua)) return "macos";
  if (/Win/.test(p) || /Windows/.test(ua)) return "win";
  return "linux";
}
