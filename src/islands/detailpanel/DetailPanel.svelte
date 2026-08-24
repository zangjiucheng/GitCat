<!--
  Owns the #detail slot.

  Before this, Detail.svelte rendered <Workdir /> inside itself, so the
  commit-detail view contained the working-tree view. That was survivable
  while both were plain scrolling stacks, but neither could own a tab strip
  or a splitter while one was nested in the other — so the chrome moves here
  and the two views become content.

  This is now the ONLY component permanently mounted at #detail (main.ts
  mounts DetailPanel once, at boot, and never destroys it) — Detail and
  Workdir below are swapped in and out as `view` changes. Detail.svelte used
  to hold that permanent mount itself, so its expanded-diff modal's Escape
  handler lived on `<svelte:window>` there and simply outlived every view
  switch. Now that Detail can be unmounted (whenever the working tree is
  selected), that handler has to live here instead — `detailCtrl.diffExpanded`
  is controller state, not component state, so it (correctly) survives a
  Detail unmount, and the Escape key needs a listener with the same lifetime
  to still be able to clear it.
-->
<script lang="ts">
  import { workdirCtrl } from "../workdir/workdir.svelte.ts";
  import { detailCtrl } from "../detail/detail.svelte.ts";
  import Detail from "../detail/Detail.svelte";
  import Workdir from "../workdir/Workdir.svelte";

  // The working tree replaces the commit view entirely — the same condition
  // Detail.svelte used to branch on internally.
  const view = $derived(workdirCtrl.selected ? "worktree" : "commit");

  // Moved here from Detail.svelte (see header comment above): must stay
  // registered even while Detail is unmounted, because collapsing the
  // expanded-diff modal from the working-tree view — then switching back to
  // find it still open — is exactly the bug this relocation fixes.
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && detailCtrl.diffExpanded) detailCtrl.collapseDiff();
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if view === "worktree"}
  <Workdir />
{:else}
  <Detail />
{/if}
