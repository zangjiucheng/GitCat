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

  // Escape is NOT handled here: begin() pushes a "modal" keyboard scope whose
  // onEscape is syncProgressCtrl.escape() (cancel while running, hide while
  // cancelling, close when done) — see the controller.
</script>

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
      {#if syncProgressCtrl.stalled && syncProgressCtrl.running}
        <div class="sync-stalled" role="status">
          <span>{t("syncprogress.stalled", { secs: syncProgressCtrl.stallSecs })}</span>
          <button
            class="btn danger sync-stalled-cancel"
            disabled={syncProgressCtrl.cancelling}
            onclick={() => syncProgressCtrl.cancel()}>{t("common.cancel")}</button
          >
        </div>
      {/if}

      {#if syncProgressCtrl.lines.length}
        <pre class="mono sync-log" bind:this={logEl}>{syncProgressCtrl.lines.join("\n")}</pre>
      {:else if !syncProgressCtrl.done}
        <div class="mut sync-empty">{t("syncprogress.starting")} <span class="spinner"></span></div>
      {/if}

      {#if syncProgressCtrl.cancelled}
        <div class="mut sync-status sync-cancelled">
          <strong>{t("syncprogress.cancelled")}</strong>
          {#if syncProgressCtrl.cancelNote}<span>{syncProgressCtrl.cancelNote}</span>{/if}
        </div>
      {:else if syncProgressCtrl.error}
        <div class="pl-err sync-status">{syncProgressCtrl.error}</div>
      {:else if syncProgressCtrl.done}
        <div class="mut sync-status">{t("syncprogress.done")}</div>
      {/if}
    </div>
    <div class="modal-foot">
      {#if syncProgressCtrl.running}
        <button class="btn ghost" onclick={() => syncProgressCtrl.close()}>{t("syncprogress.hide")}</button>
        <button class="btn danger sync-cancel" disabled={syncProgressCtrl.cancelling} onclick={() => syncProgressCtrl.cancel()}>
          {syncProgressCtrl.cancelling ? t("syncprogress.cancelling") : t("common.cancel")}
        </button>
      {:else}
        <button class="btn ghost" onclick={() => syncProgressCtrl.close()}>{t("common.close")}</button>
      {/if}
    </div>
  </div>
</div>

<style>
  /* "Looks stuck" banner: informs only — nothing is killed until the user
     says so. Amber, matching the theme's warning token. */
  .sync-stalled {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--warning) 55%, transparent);
    border-radius: var(--r-panel);
    background: color-mix(in srgb, var(--warning) 12%, transparent);
    font-size: 12.5px;
    line-height: 1.4;
  }
  .sync-stalled span {
    flex: 1;
    min-width: 0;
  }
  .sync-stalled-cancel {
    flex: none;
    padding: 3px 10px;
    font-size: 12px;
  }
  .sync-cancelled {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
</style>
