<!--
  The shared right-click menu (see contextmenu.svelte.ts for why one exists).

  Mounted once on <body> from src/main.ts, like every other overlay island —
  each surface calls contextMenuCtrl.open(items, x, y) from its own
  oncontextmenu handler instead of rendering a menu of its own.
-->
<script lang="ts">
  import { contextMenuCtrl } from "./contextmenu.svelte.ts";

  // Measured, not guessed: the item count varies per surface (three on the
  // repo chip, seven on a commit's file row), so a fixed height estimate
  // would clamp the short menus too early and the long ones too late.
  let menuW = $state(0);
  let menuH = $state(0);

  // Keep the menu fully on screen. A right-click near the bottom of the
  // window — which is exactly where the commit file list lives — would
  // otherwise open a menu whose last items are below the fold and
  // unreachable, since the backdrop swallows any scroll.
  //
  // Flip rather than merely clamp: at the bottom edge, sliding the menu up
  // by its own height puts it ABOVE the cursor (the direction the pointer
  // came from), whereas clamping would leave it under the cursor covering
  // the row that was just right-clicked.
  const PAD = 6;
  const pos = $derived.by(() => {
    const m = contextMenuCtrl.menu;
    if (!m) return { left: 0, top: 0 };
    // Before the first measurement both are 0, so this is the identity —
    // the menu paints at the click point for one frame, then settles.
    const vw = typeof window === "undefined" ? 0 : window.innerWidth;
    const vh = typeof window === "undefined" ? 0 : window.innerHeight;
    const left = vw && m.x + menuW + PAD > vw ? Math.max(PAD, m.x - menuW) : m.x;
    const top = vh && m.y + menuH + PAD > vh ? Math.max(PAD, m.y - menuH) : m.y;
    return { left, top };
  });
</script>

<!--
  Dismissal. A context menu has to go away on anything that means "I'm done
  looking at this": Escape, a scroll (the row it points at would slide out
  from under it), and a window resize (the clamp above is computed against
  one viewport size). The backdrop below covers plain clicks, including a
  right-click, which otherwise would open the browser's own menu on top.
-->
<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape" && contextMenuCtrl.menu) contextMenuCtrl.close();
  }}
  onscroll={() => contextMenuCtrl.close()}
  onresize={() => contextMenuCtrl.close()}
/>

{#if contextMenuCtrl.menu}
  <div
    class="ctxmenu-backdrop"
    role="presentation"
    onclick={() => contextMenuCtrl.close()}
    oncontextmenu={(e) => {
      e.preventDefault();
      contextMenuCtrl.close();
    }}
  ></div>
  <div class="ctxmenu" style="left:{pos.left}px; top:{pos.top}px" bind:clientWidth={menuW} bind:clientHeight={menuH} role="menu" tabindex="-1">
    {#each contextMenuCtrl.menu.items as item, i (item.id)}
      <!--
        A divider before the FIRST item is never meaningful — it separates the
        list from nothing. This matters because the shared item builders
        (fileitems/diritems) mark their group break on their own first entry,
        which is right when a surface puts its own actions above them and a
        stray top border when it does not (Detail's folder rows).
      -->
      {#if item.separatorBefore && i > 0}
        <div class="ctxmenu-sep" role="separator"></div>
      {/if}
      <button
        class="ctxmenu-item"
        class:danger={item.danger}
        role="menuitem"
        disabled={item.disabled}
        onclick={() => contextMenuCtrl.run(item)}>{item.label}</button
      >
    {/each}
  </div>
{/if}
