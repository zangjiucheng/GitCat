<script lang="ts">
  import { exportPatchesCtrl } from "./exportpatches.svelte.ts";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && exportPatchesCtrl.open) exportPatchesCtrl.close();
  }

  function onFieldKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") void exportPatchesCtrl.confirm();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={exportPatchesCtrl.open}>
  <div class="modal remotes">
    <div class="modal-head">
      <div>
        <h3>Export Patches</h3>
        <p>Export a commit range as one combined <code>.patch</code> file (<code>git format-patch</code>) to share or email.</p>
      </div>
    </div>
    <div class="modal-body">
      <div class="rm-form" class:busy={exportPatchesCtrl.busy}>
        <input
          type="text"
          class="mono"
          placeholder="from&#8230; e.g. origin/main"
          bind:value={exportPatchesCtrl.from}
          disabled={exportPatchesCtrl.busy}
          spellcheck="false"
          autocomplete="off"
          onkeydown={onFieldKeydown}
        />
        <input
          type="text"
          class="mono"
          placeholder="to&#8230; e.g. HEAD"
          bind:value={exportPatchesCtrl.to}
          disabled={exportPatchesCtrl.busy}
          spellcheck="false"
          autocomplete="off"
          onkeydown={onFieldKeydown}
        />
        <div class="nb-row">
          <span class="mut">Every commit after &#8220;from&#8221; up to and including &#8220;to&#8221;.</span>
          {#if exportPatchesCtrl.busy}<span class="spinner"></span>{/if}
        </div>
        {#if exportPatchesCtrl.error}
          <div class="log-row"><span class="ic">&#9888;</span><span class="msg mut">{exportPatchesCtrl.error}</span></div>
        {/if}
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" disabled={exportPatchesCtrl.busy} onclick={() => exportPatchesCtrl.close()}>Cancel</button>
      <button class="btn" disabled={exportPatchesCtrl.busy} onclick={() => exportPatchesCtrl.confirm()}
        >{#if exportPatchesCtrl.busy}<span class="spinner"></span> Exporting&#8230;{:else}Export&#8230;{/if}</button
      >
    </div>
  </div>
</div>
