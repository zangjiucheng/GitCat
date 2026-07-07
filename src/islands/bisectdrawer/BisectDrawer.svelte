<script lang="ts">
  import { bisectDrawerCtrl } from "./bisectdrawer.svelte.ts";
</script>

<div class="bisect-ctl">
  <button class="bx good" data-mark="good" onclick={() => bisectDrawerCtrl.mark("good")}>&#10003; Mark good</button>
  <button class="bx bad" data-mark="bad" onclick={() => bisectDrawerCtrl.mark("bad")}>&#10007; Mark bad</button>
  <button class="bx skip" data-mark="skip" onclick={() => bisectDrawerCtrl.mark("skip")}>&#8631; Skip</button>
  <button
    class="bx"
    id="bisectStart"
    style="color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,transparent)"
    onclick={() => bisectDrawerCtrl.start()}>&#9654; Start bisect</button
  >
  <button class="bx reset" id="bisectReset" onclick={() => bisectDrawerCtrl.reset()}>Reset</button>
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
