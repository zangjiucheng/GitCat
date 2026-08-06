<script lang="ts">
  import { bisectDrawerCtrl } from "./bisectdrawer.svelte.ts";
  import { bisectCtrl } from "../bisect/bisect.svelte.ts";
  import { t } from "../../i18n/i18n.svelte.ts";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && bisectDrawerCtrl.open && !bisectCtrl.busy) bisectDrawerCtrl.close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="bisect-panel" class:on={bisectDrawerCtrl.open}>
  <div class="bisect-panel-head">
    <span>{t("bisectdrawer.title")}</span>
    <button class="x" title={t("common.close")} onclick={() => bisectDrawerCtrl.close()}>&#10005;</button>
  </div>
  <div class="bisect-ctl">
    <button class="bx good" data-mark="good" disabled={bisectCtrl.busy} onclick={() => bisectDrawerCtrl.mark("good")}>&#10003; {t("bisectdrawer.mark_good")}</button>
    <button class="bx bad" data-mark="bad" disabled={bisectCtrl.busy} onclick={() => bisectDrawerCtrl.mark("bad")}>&#10007; {t("bisectdrawer.mark_bad")}</button>
    <button class="bx skip" data-mark="skip" disabled={bisectCtrl.busy} onclick={() => bisectDrawerCtrl.mark("skip")}>&#8631; {t("bisectdrawer.skip")}</button>
    <button
      class="bx"
      id="bisectStart"
      style="color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,transparent)"
      disabled={bisectCtrl.busy}
      onclick={() => bisectDrawerCtrl.start()}
      >{#if bisectCtrl.busy}<span class="spinner"></span> {t("bisectdrawer.starting")}{:else}&#9654; {t("bisectdrawer.start")}{/if}</button
    >
    <button class="bx reset" id="bisectReset" disabled={bisectCtrl.busy} onclick={() => bisectDrawerCtrl.reset()}>{t("bisectdrawer.reset")}</button>
  </div>
  <div class="bisect-range" id="bisectRange">
    {#each bisectDrawerCtrl.rangeCells as cell}
      <div class="bcell" class:cand={!cell.culled} class:culled={cell.culled}></div>
    {/each}
  </div>
  <div class="bisect-prog">
    <div class="track"><i id="bisectFill" style="width:{bisectDrawerCtrl.fillPct}%"></i></div>
    <div class="steps" id="bisectSteps">{bisectDrawerCtrl.stepsText}</div>
  </div>
  <div class="bisect-cur" id="bisectCur">{@html bisectDrawerCtrl.curHtml}</div>
</div>
