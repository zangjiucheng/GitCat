// Shared "copy to clipboard, then play the confirmation tick" pairing —
// every copy-to-clipboard action in the app (branch names, commit shas,
// commit messages, snapshot shas) used to repeat this exact two-line
// sequence independently at each of its 6 call sites, with no shared place
// to fix a bug in it once instead of in six places.
//
// navigator.clipboard.writeText() returns a rejectable Promise (a denied
// permission, an unfocused document, an insecure context) — the tick only
// plays once that promise actually resolves, so it stays an honest signal
// that the text really did land on the clipboard rather than a blind
// "the button was clicked" chime. Each call site's own "copied ✓" visual
// feedback is unchanged by this and still fires optimistically/immediately
// (that's a separate, pre-existing concern this file doesn't touch).
//
// Leaf module, same isolation reasoning as sound.ts's own header: imports
// ONLY from sound.ts, never from legacy/main.ts.
import { playTamaSound } from "./sound.ts";

export function copyToClipboard(text: string): void {
  navigator.clipboard?.writeText(text)?.then(
    () => playTamaSound("copy"),
    () => {
      // A denied/failed copy has no other feedback in this app today (no
      // error toast either) — staying silent here is strictly better than
      // confirming a copy that didn't actually happen.
    },
  );
}
