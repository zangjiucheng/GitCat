<script lang="ts">
  import { tamaGalleryCtrl, POSES, poseImg } from "./tamagallery.svelte.ts";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import { t } from "../../i18n/i18n.svelte.ts";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && tamaGalleryCtrl.open) tamaGalleryCtrl.close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={tamaGalleryCtrl.open}>
  <div class="modal tama-gallery">
    <div class="modal-head">
      <div class="modal-tama"><img class="tama-pic" src={poseImg("happy")} alt="Tama, delighted you found this" /></div>
      <div>
        <h3>{t("tamagallery.title")} <Sparkles class="ico" size={15} aria-hidden="true" /></h3>
        <p>{t("tamagallery.subtitle")}</p>
      </div>
    </div>
    <div class="modal-body">
      <div class="tg-grid">
        {#each POSES as pose (pose.key)}
          <button class="tg-card" class:active={tamaGalleryCtrl.activeKey === pose.key} onclick={() => tamaGalleryCtrl.preview(pose)}>
            <img src={poseImg(pose.key)} alt={pose.label} />
            <span class="tg-label">{pose.label}</span>
          </button>
        {/each}
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" onclick={() => tamaGalleryCtrl.close()}>{t("common.close")}</button>
    </div>
  </div>
</div>
