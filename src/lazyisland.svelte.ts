// Mount a modal island's VIEW the first time its controller opens it.
//
// `src/main.ts` mounts every island into `document.body` at boot. For the
// on-demand modals that is work done for nothing: the component renders
// nothing at all until its controller's `open` flips, yet it is downloaded,
// parsed and mounted before the user has touched anything.
//
// The CONTROLLER still has to be eager — boot code reads it (menu wiring, ⌘K
// registration, settings applied to the document) — so only the view moves.
// That split is the whole trick: `open` is plain `$state` on a singleton that
// already exists, so watching it costs nothing and needs no new plumbing.
//
// SAFE ONLY for islands whose view is pure presentation: no `onMount`, no
// `$effect`, no listeners, and no props. An island that does work when it
// mounts must keep its eager `mount()`, because deferring the mount defers the
// work — silently, and until the user happens to open it. TamaGallery,
// Plugins, Settings and ExternalTools were each checked against that bar
// before being moved (see #81).
//
// Lives in a `.svelte.ts` file because `$effect` is a rune and `main.ts` is
// plain TypeScript — the effect has to be compiled here and called from there.

import { mount, type Component } from "svelte";

/**
 * Watch `isOpen()` and, the first time it is true, load and mount the view.
 *
 * Idempotent by construction: the guard is set BEFORE the dynamic import is
 * awaited, so a controller that flips `open` twice in quick succession cannot
 * race two mounts of the same component into `document.body`.
 *
 * The one visible consequence: the FIRST open waits for the chunk. Off the
 * local asset protocol that is well under a frame, and every later open is
 * exactly as it was — but it does mean the first open of a modal does not
 * animate its scrim in, since there is no scrim in the DOM yet to animate.
 */
export function mountOnFirstOpen(
  isOpen: () => boolean,
  load: () => Promise<{ default: Component<Record<string, never>> }>,
): void {
  let started = false;
  const stop = $effect.root(() => {
    $effect(() => {
      if (started || !isOpen()) return;
      started = true;
      void load()
        .then((mod) => {
          mount(mod.default, { target: document.body });
          // One job, done. Nothing here needs to observe `open` again — the
          // mounted component owns its own show/hide from now on.
          stop();
        })
        .catch((err) => {
          // A chunk that fails to load must not leave the modal permanently
          // dead, and must not become an unhandled rejection that nothing
          // surfaces. Clearing the guard means the next open tries again,
          // which is the right answer for the realistic cause: a transient
          // read of an asset that is sitting on local disk.
          started = false;
          console.error("lazyisland: could not load a modal view", err);
        });
    });
  });
}
