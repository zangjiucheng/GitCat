<script lang="ts">
  import { exportPatchesCtrl } from "./exportpatches.svelte.ts";
  import { t } from "@/i18n/i18n.svelte.ts";

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
        <h3>{t("exportpatches.title")}</h3>
        <p>{t("exportpatches.subtitle_pre")}<code>.patch</code>{t("exportpatches.subtitle_mid")}<code>git format-patch</code>{t("exportpatches.subtitle_post")}</p>
      </div>
    </div>
    <div class="modal-body">
      <div class="rm-form" class:busy={exportPatchesCtrl.busy}>
        <input
          type="text"
          class="mono"
          placeholder={t("exportpatches.ph_from")}
          bind:value={exportPatchesCtrl.from}
          disabled={exportPatchesCtrl.busy}
          spellcheck="false"
          autocomplete="off"
          onkeydown={onFieldKeydown}
        />
        <input
          type="text"
          class="mono"
          placeholder={t("exportpatches.ph_to")}
          bind:value={exportPatchesCtrl.to}
          disabled={exportPatchesCtrl.busy}
          spellcheck="false"
          autocomplete="off"
          onkeydown={onFieldKeydown}
        />
        <div class="nb-row">
          <span class="mut">{t("exportpatches.range_hint")}</span>
          {#if exportPatchesCtrl.busy}<span class="spinner"></span>{/if}
        </div>
        {#if exportPatchesCtrl.error}
          <div class="log-row"><span class="ic">&#9888;</span><span class="msg mut">{exportPatchesCtrl.error}</span></div>
        {/if}
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" disabled={exportPatchesCtrl.busy} onclick={() => exportPatchesCtrl.close()}>{t("common.cancel")}</button>
      <button class="btn" disabled={exportPatchesCtrl.busy} onclick={() => exportPatchesCtrl.confirm()}
        >{#if exportPatchesCtrl.busy}<span class="spinner"></span> {t("exportpatches.exporting")}{:else}{t("exportpatches.export_btn")}{/if}</button
      >
    </div>
  </div>
</div>
