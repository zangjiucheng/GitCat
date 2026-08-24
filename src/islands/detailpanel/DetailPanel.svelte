<!--
  Owns the #detail slot.

  Before this, Detail.svelte rendered <Workdir /> inside itself, so the
  commit-detail view contained the working-tree view. That was survivable
  while both were plain scrolling stacks, but neither could own a tab strip
  or a splitter while one was nested in the other — so the chrome moves here
  and the two views become content.
-->
<script lang="ts">
  import { workdirCtrl } from "../workdir/workdir.svelte.ts";
  import Detail from "../detail/Detail.svelte";
  import Workdir from "../workdir/Workdir.svelte";

  // The working tree replaces the commit view entirely — the same condition
  // Detail.svelte used to branch on internally.
  const view = $derived(workdirCtrl.selected ? "worktree" : "commit");
</script>

{#if view === "worktree"}
  <Workdir />
{:else}
  <Detail />
{/if}
