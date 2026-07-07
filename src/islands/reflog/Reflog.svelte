<script lang="ts">
  import { reflogCtrl } from "./reflog.svelte.ts";
</script>

{#if reflogCtrl.error}
  <div class="log-row"><span class="ic">&#9888;</span><span class="msg mut">{reflogCtrl.error}</span></div>
{:else if reflogCtrl.entries.length === 0}
  <div class="log-row"><span class="msg mut">No reflog entries yet.</span></div>
{:else}
  {#each reflogCtrl.entries as e (e.index)}
    <div class="log-row">
      <span class="ic">{reflogCtrl.icon(e.kind)}</span>
      <span class="sel">{e.sha}</span>
      <span class="msg">{reflogCtrl.label(e)}</span>
      <button class="go" disabled={reflogCtrl.busy} onclick={() => reflogCtrl.restore(e.index)}>Restore here</button>
    </div>
  {/each}
{/if}
