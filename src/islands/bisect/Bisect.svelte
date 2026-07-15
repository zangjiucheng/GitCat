<script lang="ts">
  import { bisectCtrl } from "./bisect.svelte.ts";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";

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
      <div class="modal-tama"><img class="tama-pic" src={bisectCtrl.tamaImg} alt="Tama, on the hunt" /></div>
      <div>
        <h3>Bisecting &#8212; hunting the first bad commit</h3>
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
          <div class="bz-cur-h">Checked out &#183; testing now</div>
          <div class="bz-sha">{bisectCtrl.vm?.current?.sha ?? "—"}</div>
          <div class="bz-subj">{bisectCtrl.vm?.current?.subject ?? ""}</div>
        </div>
        <div class="bz-run">
          <div class="bz-run-h">Automate with a command</div>
          <div class="bz-run-row">
            {#if bisectCtrl.autoRunning}
              <span class="bz-run-status"><span class="spinner"></span> Testing commits automatically&#8230;</span>
              <button class="btn ghost bz-cancel" onclick={() => bisectCtrl.cancelRun()}>&#9632; Cancel</button>
            {:else}
              <input
                class="bz-run-input mono"
                type="text"
                placeholder="e.g. npm test, ./check.sh"
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
                onclick={() => bisectCtrl.startRun(bisectCtrl.repo)}>&#9654; Run automatically</button
              >
            {/if}
          </div>
        </div>
      {:else}
        <div class="bz-result">
          <div class="bz-result-h">&#10003; First bad commit</div>
          <div class="bz-sha bad">{bisectCtrl.vm?.firstBad?.sha ?? ""}</div>
          <div class="bz-subj">{bisectCtrl.vm?.firstBad?.subject ?? ""}</div>
        </div>
      {/if}
      <div class="backup-note" style="margin-top:12px">
        <RotateCcw class="ico" size={14} aria-hidden="true" /> Your original branch is safe &#8212; <b>Reset</b> puts HEAD back. A snapshot was pinned before checkout.
      </div>
    </div>
    <div class="modal-foot">
      <button
        class="btn ghost"
        id="bzQuit"
        disabled={bisectCtrl.busy || bisectCtrl.autoRunning}
        onclick={() => bisectCtrl.reset()}
        title={bisectCtrl.autoRunning ? "Cancel the automated run first" : ""}
        >{#if bisectCtrl.busy && !bisectCtrl.activeTerm}<span class="spinner"></span> Resetting…{:else}{bisectCtrl.done
            ? "Reset — restore HEAD"
            : "Quit & reset"}{/if}</button
      >
      {#if !bisectCtrl.done}
        <span class="bz-mark-group">
          <button class="btn bz-good" disabled={bisectCtrl.marksDisabled} onclick={() => bisectCtrl.mark("good")}
            >{#if bisectCtrl.activeTerm === "good"}<span class="spinner"></span>{:else}&#10003; Good{/if}</button
          ><button class="btn bz-skip" disabled={bisectCtrl.marksDisabled} onclick={() => bisectCtrl.mark("skip")}
            >{#if bisectCtrl.activeTerm === "skip"}<span class="spinner"></span>{:else}&#8631; Skip{/if}</button
          ><button class="btn bz-bad" disabled={bisectCtrl.marksDisabled} onclick={() => bisectCtrl.mark("bad")}
            >{#if bisectCtrl.activeTerm === "bad"}<span class="spinner"></span>{:else}&#10007; Bad{/if}</button
          >
        </span>
      {/if}
    </div>
  </div>
</div>
