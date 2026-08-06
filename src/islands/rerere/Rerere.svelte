<script lang="ts">
  // Rerere panel — view. Deliberately NO <style> block: reuses the old
  // drawer pane's existing global classes (.rr-row / .h / .rr-badge / .mut /
  // .cp-x), now inside the shared .scrim/.modal chrome instead — see
  // index.html's own doc comment on the old DRAWER section.
  import { rerereCtrl } from "./rerere.svelte.ts";
  import { IN_TAURI } from "../../ipc/env";
  import { t } from "../../i18n/i18n.svelte.ts";

  function onToggle(e: Event) {
    rerereCtrl.setEnabled((e.currentTarget as HTMLInputElement).checked);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && rerereCtrl.open) rerereCtrl.close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={rerereCtrl.open}>
  <div class="modal rerere">
    <div class="modal-head">
      <div>
        <h3>{t("rerere.title")}</h3>
        <p>{t("rerere.subtitle")}</p>
      </div>
    </div>
    <div class="modal-body">
      <div class="rr-row">
        <label class="cp-x" title={t("rerere.toggle_title")}>
          <input type="checkbox" checked={rerereCtrl.enabled} disabled={rerereCtrl.busy || !rerereCtrl.vm} onchange={onToggle} />
          rerere {rerereCtrl.enabled ? t("rerere.on") : t("rerere.off")}
        </label>
        {#if rerereCtrl.busy}
          <span class="mut"><span class="spinner"></span> {t("rerere.saving")}</span>
        {:else}
          <span class="mut">{rerereCtrl.sourceNote}</span>
        {/if}
      </div>

      {#if !rerereCtrl.vm}
        <div class="rr-row">
          <span class="mut"
            >{#if rerereCtrl.busy}<span class="spinner"></span> {t("common.loading")}{:else if IN_TAURI}{t("rerere.open_repo_hint")}{:else}{t("common.loading")}{/if}</span
          >
        </div>
      {:else}
        {#if rerereCtrl.vm.liveConflict}
          <div class="rr-row"><span class="mut">{t("rerere.live_conflict", { n: rerereCtrl.vm.livePaths.length })}</span></div>
        {/if}
        {#each rerereCtrl.rows as row (row.key)}
          <div class="rr-row">
            <span class="h">{row.label}</span>
            {#if row.resolved}
              <span class="rr-badge">{t("rerere.badge_recorded")}</span>
            {:else}
              <span class="mut">{t("rerere.pending")}</span>
            {/if}
            {#if row.isPath}<span class="mut">{t("rerere.live")}</span>{/if}
          </div>
        {:else}
          <div class="rr-row">
            <span class="mut">{t("rerere.empty")}</span>
          </div>
        {/each}
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" onclick={() => rerereCtrl.close()}>{t("common.close")}</button>
    </div>
  </div>
</div>
