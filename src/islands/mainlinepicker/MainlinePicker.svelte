<script lang="ts">
  import { mainlinePickerCtrl } from "./mainlinepicker.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import { t } from "../../i18n/i18n.svelte.ts";

  // Parent 1 is the branch the merge was made ON (merged into); parent 2 is the
  // branch merged in. Spell that out so the choice isn't just "1 or 2".
  function role(n: number): string {
    if (n === 1) return t("mainlinepicker.role_mainline");
    if (n === 2) return t("mainlinepicker.role_merged_in");
    return t("mainlinepicker.role_parent", { n });
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && mainlinePickerCtrl.open) mainlinePickerCtrl.cancel();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={mainlinePickerCtrl.open}>
  <div class="modal mainline">
    <div class="modal-head">
      <div class="modal-tama"><img class="tama-pic" src={bridge.TAMA_IMG.curious} alt={t("mainlinepicker.tama_alt")} /></div>
      <div>
        <h3>{t("mainlinepicker.title")}</h3>
        <p>
          <span class="mono">{mainlinePickerCtrl.sha.slice(0, 8)}</span>{t("mainlinepicker.merge_desc")}
        </p>
      </div>
    </div>
    <div class="modal-body">
      <div class="ml-list">
        {#each mainlinePickerCtrl.parents as p (p.number)}
          <button class="ml-parent" onclick={() => mainlinePickerCtrl.pick(p.number)}>
            <span class="ml-num">-m {p.number}</span>
            <span class="ml-body">
              <span class="ml-sha mono">{p.shortSha}</span>
              <span class="ml-summary">{p.summary}</span>
              <span class="ml-role mut">{role(p.number)}</span>
            </span>
          </button>
        {/each}
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" onclick={() => mainlinePickerCtrl.cancel()}>{t("common.cancel")}</button>
    </div>
  </div>
</div>
