<script lang="ts">
  import { reflogCtrl } from "./reflog.svelte.ts";
  import { t } from "@/i18n/i18n.svelte.ts";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && reflogCtrl.open) reflogCtrl.close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={reflogCtrl.open}>
  <div class="modal reflog">
    <div class="modal-head">
      <div class="modal-tama"><img class="tama-pic" src={reflogCtrl.tamaImg} alt={t("reflog.tama_alt")} /></div>
      <div>
        <h3>{t("reflog.title")}</h3>
        <p>{t("reflog.subtitle")}</p>
      </div>
    </div>
    <div class="modal-body">
      {#if reflogCtrl.loading}
        <div class="log-row"><span class="spinner"></span><span class="msg mut">{t("reflog.loading_list")}</span></div>
      {:else if reflogCtrl.error}
        <div class="log-row"><span class="ic">&#9888;</span><span class="msg mut">{reflogCtrl.error}</span></div>
      {:else if reflogCtrl.entries.length === 0}
        <div class="log-row"><span class="msg mut">{t("reflog.empty")}</span></div>
      {:else}
        {#each reflogCtrl.entries as e (e.index)}
          <div class="log-row">
            <span class="ic">{@html reflogCtrl.icon(e.kind)}</span>
            <span class="sel">{e.sha}</span>
            <span class="msg">{reflogCtrl.label(e)}</span>
            <button class="go" disabled={reflogCtrl.busy} onclick={() => reflogCtrl.restore(e.index)}
              >{#if reflogCtrl.restoringIndex === e.index}<span class="spinner"></span> {t("reflog.restoring")}{:else}{t("reflog.restore_here")}{/if}</button
            >
          </div>
        {/each}
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" disabled={reflogCtrl.busy} onclick={() => reflogCtrl.close()}>{t("common.close")}</button>
    </div>
  </div>
</div>
