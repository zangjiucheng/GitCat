<script lang="ts">
  import { tamaGalleryCtrl, POSES, poseImg } from "./tamagallery.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import Sparkles from "@lucide/svelte/icons/sparkles";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && tamaGalleryCtrl.open) tamaGalleryCtrl.close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={tamaGalleryCtrl.open}>
  <div class="modal tama-gallery">
    <div class="modal-head">
      <div class="modal-tama"><img class="tama-pic" src={bridge.TAMA_IMG.happy} alt="Tama, delighted you found this" /></div>
      <div>
        <h3>You found Tama's gallery! <Sparkles class="ico" size={15} aria-hidden="true" /></h3>
        <p>Every pose she wears around the app &#8212; click one to see her wear it right now, in the corner. にゃ〜</p>
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
      <button class="btn ghost" onclick={() => tamaGalleryCtrl.close()}>Close</button>
    </div>
  </div>
</div>
