<script lang="ts">
  import { syncProgressCtrl } from "./syncprogress.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import { t } from "@/i18n/i18n.svelte.ts";

  let logEl: HTMLElement | undefined = $state();

  // Auto-scroll the log to the bottom as new git progress segments arrive, so
  // the latest ("Receiving objects: N%…") line is always in view.
  $effect(() => {
    syncProgressCtrl.lines.length; // track: re-run whenever a segment is appended
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && syncProgressCtrl.open) syncProgressCtrl.close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={syncProgressCtrl.open}>
  <div class="modal syncprogress">
    <div class="modal-head">
      <div class="modal-tama"><img class="tama-pic" src={bridge.TAMA_IMG.thinking} alt="Tama, working" /></div>
      <div>
        <h3>{syncProgressCtrl.title || t("syncprogress.title")}</h3>
        <p>{t("syncprogress.body")}</p>
      </div>
    </div>
    <div class="modal-body">
      {#if syncProgressCtrl.lines.length}
        <pre class="mono sync-log" bind:this={logEl}>{syncProgressCtrl.lines.join("\n")}</pre>
      {:else if !syncProgressCtrl.done}
        <div class="mut sync-empty">{t("syncprogress.starting")} <span class="spinner"></span></div>
      {/if}

      {#if syncProgressCtrl.error}
        <div class="pl-err sync-status">{syncProgressCtrl.error}</div>
      {:else if syncProgressCtrl.done}
        <div class="mut sync-status">{t("syncprogress.done")}</div>
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" onclick={() => syncProgressCtrl.close()}>{t("common.close")}</button>
    </div>
  </div>
</div>
