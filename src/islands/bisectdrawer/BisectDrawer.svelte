<script lang="ts">
  import { bisectDrawerCtrl } from "./bisectdrawer.svelte.ts";
  import { bisectCtrl } from "../bisect/bisect.svelte.ts";
</script>

<div class="bisect-ctl">
  <button class="bx good" data-mark="good" disabled={bisectCtrl.busy} onclick={() => bisectDrawerCtrl.mark("good")}>&#10003; Mark good</button>
  <button class="bx bad" data-mark="bad" disabled={bisectCtrl.busy} onclick={() => bisectDrawerCtrl.mark("bad")}>&#10007; Mark bad</button>
  <button class="bx skip" data-mark="skip" disabled={bisectCtrl.busy} onclick={() => bisectDrawerCtrl.mark("skip")}>&#8631; Skip</button>
  <button
    class="bx"
    id="bisectStart"
    style="color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,transparent)"
    disabled={bisectCtrl.busy}
    onclick={() => bisectDrawerCtrl.start()}
    >{#if bisectCtrl.busy}<span class="spinner"></span> Starting…{:else}&#9654; Start bisect{/if}</button
  >
  <button class="bx reset" id="bisectReset" disabled={bisectCtrl.busy} onclick={() => bisectDrawerCtrl.reset()}>Reset</button>
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
