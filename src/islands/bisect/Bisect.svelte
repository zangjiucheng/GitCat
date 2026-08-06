<script lang="ts">
  import { bisectCtrl } from "./bisect.svelte.ts";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import { t } from "@/i18n/i18n.svelte.ts";

  // Escape hides the panel non-destructively — the bisect keeps running in the
  // backend; re-open via the drawer "Start bisect".
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && bisectCtrl.open) bisectCtrl.close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" id="bisectScrim" class:on={bisectCtrl.open}>
  <div class="modal bisecter">
    <div class="modal-head">
      <div class="modal-tama"><img class="tama-pic" src={bisectCtrl.tamaImg} alt={t("bisect.tama_alt")} /></div>
      <div>
        <h3>{t("bisect.title")}</h3>
        <p>{bisectCtrl.hint}</p>
      </div>
    </div>
    <div class="modal-body">
      <div class="bz-prog">
        <div class="bz-track"><i style="width:{bisectCtrl.fillPct}%"></i></div>
        <span class="bz-stat">{bisectCtrl.statText}</span>
      </div>
      {#if !bisectCtrl.done}
        <div class="bz-cur">
          <div class="bz-cur-h">{t("bisect.checked_out")}</div>
          <div class="bz-sha">{bisectCtrl.vm?.current?.sha ?? "—"}</div>
          <div class="bz-subj">{bisectCtrl.vm?.current?.subject ?? ""}</div>
        </div>
        <div class="bz-run">
          <div class="bz-run-h">{t("bisect.automate_h")}</div>
          <div class="bz-run-row">
            {#if bisectCtrl.autoRunning}
              <span class="bz-run-status"><span class="spinner"></span> {t("bisect.testing_auto")}</span>
              <button class="btn ghost bz-cancel" onclick={() => bisectCtrl.cancelRun()}>&#9632; {t("common.cancel")}</button>
            {:else}
              <input
                class="bz-run-input mono"
                type="text"
                placeholder={t("bisect.run_placeholder")}
                spellcheck="false"
                autocomplete="off"
                disabled={bisectCtrl.busy}
                bind:value={bisectCtrl.runCommand}
                onkeydown={(e) => {
                  if (e.key === "Enter") bisectCtrl.startRun(bisectCtrl.repo);
                }}
              />
              <button
                class="btn"
                disabled={bisectCtrl.marksDisabled || !bisectCtrl.runCommand.trim()}
                onclick={() => bisectCtrl.startRun(bisectCtrl.repo)}>&#9654; {t("bisect.run_auto")}</button
              >
            {/if}
          </div>
        </div>
      {:else}
        <div class="bz-result">
          <div class="bz-result-h">&#10003; {t("bisect.first_bad_h")}</div>
          <div class="bz-sha bad">{bisectCtrl.vm?.firstBad?.sha ?? ""}</div>
          <div class="bz-subj">{bisectCtrl.vm?.firstBad?.subject ?? ""}</div>
        </div>
      {/if}
      <div class="backup-note" style="margin-top:12px">
        <RotateCcw class="ico" size={14} aria-hidden="true" /> {@html t("bisect.backup_note")}
      </div>
    </div>
    <div class="modal-foot">
      <button
        class="btn ghost"
        id="bzQuit"
        disabled={bisectCtrl.busy || bisectCtrl.autoRunning}
        onclick={() => bisectCtrl.reset()}
        title={bisectCtrl.autoRunning ? t("bisect.reset_title_cancel_first") : ""}
        >{#if bisectCtrl.busy && !bisectCtrl.activeTerm}<span class="spinner"></span> {t("bisect.resetting")}{:else}{bisectCtrl.done
            ? t("bisect.reset_restore")
            : t("bisect.quit_reset")}{/if}</button
      >
      {#if !bisectCtrl.done}
        <span class="bz-mark-group">
          <button class="btn bz-good" disabled={bisectCtrl.marksDisabled} onclick={() => bisectCtrl.mark("good")}
            >{#if bisectCtrl.activeTerm === "good"}<span class="spinner"></span>{:else}&#10003; {t("bisect.mark_good")}{/if}</button
          ><button class="btn bz-skip" disabled={bisectCtrl.marksDisabled} onclick={() => bisectCtrl.mark("skip")}
            >{#if bisectCtrl.activeTerm === "skip"}<span class="spinner"></span>{:else}&#8631; {t("bisect.mark_skip")}{/if}</button
          ><button class="btn bz-bad" disabled={bisectCtrl.marksDisabled} onclick={() => bisectCtrl.mark("bad")}
            >{#if bisectCtrl.activeTerm === "bad"}<span class="spinner"></span>{:else}&#10007; {t("bisect.mark_bad")}{/if}</button
          >
        </span>
      {/if}
    </div>
  </div>
</div>
