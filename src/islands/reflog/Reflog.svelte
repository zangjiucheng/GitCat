<script lang="ts">
  import { reflogCtrl } from "./reflog.svelte.ts";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && reflogCtrl.open) reflogCtrl.close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={reflogCtrl.open}>
  <div class="modal reflog">
    <div class="modal-head">
      <div>
        <h3>Reflog &#8212; rescue a historical HEAD</h3>
        <p>Every HEAD move this repo remembers, newest first. Restoring snapshots first, so it's itself undoable.</p>
      </div>
    </div>
    <div class="modal-body">
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
    </div>
    <div class="modal-foot">
      <button class="btn ghost" disabled={reflogCtrl.busy} onclick={() => reflogCtrl.close()}>Close</button>
    </div>
  </div>
</div>
