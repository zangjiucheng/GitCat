<script lang="ts">
  import { bisectCtrl } from "./bisect.svelte.ts";

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
      {:else}
        <div class="bz-result">
          <div class="bz-result-h">&#10003; First bad commit</div>
          <div class="bz-sha bad">{bisectCtrl.vm?.firstBad?.sha ?? ""}</div>
          <div class="bz-subj">{bisectCtrl.vm?.firstBad?.subject ?? ""}</div>
        </div>
      {/if}
      <div class="backup-note" style="margin-top:12px">
        &#128257; Your original branch is safe &#8212; <b>Reset</b> puts HEAD back. A snapshot was pinned before checkout.
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" id="bzQuit" onclick={() => bisectCtrl.reset()}
        >{bisectCtrl.done ? "Reset — restore HEAD" : "Quit & reset"}</button
      >
      {#if !bisectCtrl.done}
        <span class="bz-mark-group">
          <button class="btn bz-good" disabled={bisectCtrl.marksDisabled} onclick={() => bisectCtrl.mark("good")}
            >&#10003; Good</button
          ><button class="btn bz-skip" disabled={bisectCtrl.marksDisabled} onclick={() => bisectCtrl.mark("skip")}
            >&#8631; Skip</button
          ><button class="btn bz-bad" disabled={bisectCtrl.marksDisabled} onclick={() => bisectCtrl.mark("bad")}
            >&#10007; Bad</button
          >
        </span>
      {/if}
    </div>
  </div>
</div>
