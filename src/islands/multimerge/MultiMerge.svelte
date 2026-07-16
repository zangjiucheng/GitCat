<script lang="ts">
  import { multimergeCtrl } from "./multimerge.svelte.ts";
  import type { MultiMergeMode, MultiMergeStrategy } from "./multimerge.svelte.ts";
  import * as bridge from "../../legacy/bridge";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && multimergeCtrl.open && !multimergeCtrl.busy) multimergeCtrl.close();
  }

  const MODES: { value: MultiMergeMode; label: string; hint: string }[] = [
    { value: "sequential", label: "Sequential", hint: "Merge one at a time — each conflict is resolvable normally" },
    { value: "octopus", label: "Octopus", hint: "One commit for every branch — but ANY conflict fails the whole merge" },
  ];
  const STRATEGIES: { value: MultiMergeStrategy; label: string }[] = [
    { value: "auto", label: "Auto (fast-forward when possible)" },
    { value: "no-ff", label: "Always create a merge commit" },
    { value: "ff-only", label: "Fast-forward only" },
  ];
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={multimergeCtrl.open}>
  <div class="modal multimerge">
    <div class="modal-head">
      <div class="modal-tama"><img class="tama-pic" src={bridge.TAMA_IMG.alarm} alt="Tama, alarmed" /></div>
      <div>
        <h3>Merge Multiple Branches</h3>
        <p>Pick two or more branches to merge into the current branch.</p>
      </div>
    </div>
    <div class="modal-body">
      {#if multimergeCtrl.resuming}
        <p class="mut">
          A sequential merge queue is already in progress &#8212; {multimergeCtrl.queueDoneList.length} merged,
          {multimergeCtrl.queueRemaining.length + (multimergeCtrl.queueCurrent ? 1 : 0)} left.
        </p>
        <div class="mm-list">
          {#each multimergeCtrl.queueDoneList as sha}
            <div class="mm-row done"><span class="mm-mk">&#10003;</span><span class="mm-name">{multimergeCtrl.labelFor(sha)}</span></div>
          {/each}
          {#if multimergeCtrl.queueCurrent}
            <div class="mm-row current"><span class="mm-mk">&#9679;</span><span class="mm-name">{multimergeCtrl.labelFor(multimergeCtrl.queueCurrent)}</span></div>
          {/if}
          {#each multimergeCtrl.queueRemaining as sha}
            <div class="mm-row"><span class="mm-mk">&#9675;</span><span class="mm-name">{multimergeCtrl.labelFor(sha)}</span></div>
          {/each}
        </div>
      {:else}
        <div class="mm-list" class:busy={multimergeCtrl.busy}>
          {#each multimergeCtrl.branches as b (b.name)}
            <label class="mm-row" class:checked={multimergeCtrl.selected.has(b.name)}>
              <input
                type="checkbox"
                checked={multimergeCtrl.selected.has(b.name)}
                disabled={multimergeCtrl.busy}
                onchange={() => multimergeCtrl.toggle(b.name)}
              />
              <span class="mm-name">{b.name}</span>
              {#if b.ahead || b.behind}
                <span class="mm-meta mut">{b.ahead ?? 0}&#8593; {b.behind ?? 0}&#8595;</span>
              {/if}
            </label>
          {:else}
            <div class="mm-empty mut">No other local branches to merge.</div>
          {/each}
        </div>
        <div class="mm-mode">
          {#each MODES as m}
            <button
              type="button"
              class="mm-mode-btn"
              class:on={multimergeCtrl.mode === m.value}
              disabled={multimergeCtrl.busy}
              title={m.hint}
              onclick={() => multimergeCtrl.setMode(m.value)}
            >
              {m.label}
            </button>
          {/each}
          {#if multimergeCtrl.mode === "sequential"}
            <select
              class="mm-strategy"
              value={multimergeCtrl.strategy}
              disabled={multimergeCtrl.busy}
              aria-label="Merge strategy"
              onchange={(e) => multimergeCtrl.setStrategy((e.currentTarget as HTMLSelectElement).value as MultiMergeStrategy)}
            >
              {#each STRATEGIES as s}
                <option value={s.value}>{s.label}</option>
              {/each}
            </select>
          {/if}
        </div>
        {#if multimergeCtrl.mode === "octopus"}
          <p class="mm-caveat mut">
            Octopus creates one commit naming every branch &#8212; but git can't resolve a conflict across more than two
            branches at once, so any conflict aborts the whole merge untouched. Use Sequential if you expect conflicts.
          </p>
        {/if}
      {/if}
    </div>
    <div class="modal-foot">
      {#if multimergeCtrl.resuming}
        <button class="btn ghost" disabled={multimergeCtrl.busy} onclick={() => multimergeCtrl.resumeCancel()}
          >{#if multimergeCtrl.busy}<span class="spinner"></span> Cancelling…{:else}Cancel queue{/if}</button
        >
        <button
          class="btn"
          style="background:var(--accent2);border-color:var(--accent2)"
          disabled={multimergeCtrl.busy}
          onclick={() => multimergeCtrl.resumeContinue()}
          >{#if multimergeCtrl.busy}<span class="spinner"></span> Continuing…{:else}Continue{/if}</button
        >
      {:else}
        <button class="btn ghost" disabled={multimergeCtrl.busy} onclick={() => multimergeCtrl.close()}>Cancel</button>
        <button
          class="btn"
          style="background:var(--accent2);border-color:var(--accent2)"
          disabled={!multimergeCtrl.canMerge}
          onclick={() => multimergeCtrl.merge()}
          >{#if multimergeCtrl.busy}<span class="spinner"></span> Merging…{:else}Merge {multimergeCtrl.selectedCount} branch{multimergeCtrl.selectedCount === 1 ? "" : "es"}{/if}</button
        >
      {/if}
    </div>
  </div>
</div>
