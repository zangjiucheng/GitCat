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
// SAFE ONLY for islands whose view does no work the app needs before someone
// opens it. Deferring a mount defers whatever that mount did — silently, and
// until the user happens to open the thing. The bar, in the order it is worth
// checking:
//
//   * no `onMount` / `onDestroy` doing work anyone else depends on
//   * no `$effect` with a side effect outside the component
//   * no `addEventListener` AND no `<svelte:window>` / `<svelte:document>` /
//     `<svelte:body>` — the second form is the one a grep for the first will
//     quietly miss, and every modal island here uses it for its Escape handler
//   * no props
//
// A global listener is fine when it is guarded by the same `open` the mount is
// keyed to: it cannot matter before the mount, because the mount is what `open`
// triggers. Every island moved so far is that shape (`if (Escape && ctrl.open)
// ctrl.close()`), which is why they qualify despite having one.
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
  /**
   * Where to mount. Defaults to `document.body`, which is where every modal
   * island goes; BisectDrawer is the exception, living inside `#canvasWrap`.
   * Resolved lazily, at mount time rather than at call time, so a target that
   * is static markup in index.html does not have to be looked up during boot.
   */
  target: () => Element = () => document.body,
): void {
  let started = false;
  const stop = $effect.root(() => {
    $effect(() => {
      if (started || !isOpen()) return;
      started = true;
      void load()
        .then((mod) => {
          mount(mod.default, { target: target() });
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
