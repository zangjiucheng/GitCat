<script lang="ts">
  import { reflogCtrl } from "./reflog.svelte.ts";
</script>

{#if reflogCtrl.loading}
  <div class="log-row"><span class="spinner"></span><span class="msg mut">Loading reflog&#8230;</span></div>
{:else if reflogCtrl.error}
  <div class="log-row"><span class="ic">&#9888;</span><span class="msg mut">{reflogCtrl.error}</span></div>
{:else if reflogCtrl.entries.length === 0}
  <div class="log-row"><span class="msg mut">No reflog entries yet.</span></div>
{:else}
  {#each reflogCtrl.entries as e (e.index)}
    <div class="log-row">
      <span class="ic">{reflogCtrl.icon(e.kind)}</span>
      <span class="sel">{e.sha}</span>
      <span class="msg">{reflogCtrl.label(e)}</span>
      <button class="go" disabled={reflogCtrl.busy} onclick={() => reflogCtrl.restore(e.index)}
        >{#if reflogCtrl.restoringIndex === e.index}<span class="spinner"></span> Restoring&#8230;{:else}Restore here{/if}</button
      >
    </div>
  {/each}
{/if}
