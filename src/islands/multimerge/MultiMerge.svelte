<script lang="ts">
  import { multimergeCtrl } from "./multimerge.svelte.ts";
  import type { MultiMergeMode, MultiMergeStrategy } from "./multimerge.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import { t } from "@/i18n/i18n.svelte.ts";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && multimergeCtrl.open && !multimergeCtrl.busy) multimergeCtrl.close();
  }

  const MODES: MultiMergeMode[] = ["sequential", "octopus"];
  const STRATEGIES: MultiMergeStrategy[] = ["auto", "no-ff", "ff-only"];
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={multimergeCtrl.open}>
  <div class="modal multimerge">
    <div class="modal-head">
      <div class="modal-tama"><img class="tama-pic" src={bridge.TAMA_IMG.alarm} alt={t("multimerge.tama_alt")} /></div>
      <div>
        <h3>{t("multimerge.title")}</h3>
        <p>{t("multimerge.subtitle")}</p>
      </div>
    </div>
    <div class="modal-body">
      {#if multimergeCtrl.resuming}
        <p class="mut">
          {t("multimerge.resume_status", {
            done: multimergeCtrl.queueDoneList.length,
            left: multimergeCtrl.queueRemaining.length + (multimergeCtrl.queueCurrent ? 1 : 0),
          })}
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
            <div class="mm-empty mut">{t("multimerge.empty")}</div>
          {/each}
        </div>
        <div class="mm-mode">
          {#each MODES as m}
            <button
              type="button"
              class="mm-mode-btn"
              class:on={multimergeCtrl.mode === m}
              disabled={multimergeCtrl.busy}
              title={t("multimerge.mode_hint_" + m)}
              onclick={() => multimergeCtrl.setMode(m)}
            >
              {t("multimerge.mode_" + m)}
            </button>
          {/each}
          {#if multimergeCtrl.mode === "sequential"}
            <select
              class="mm-strategy"
              value={multimergeCtrl.strategy}
              disabled={multimergeCtrl.busy}
              aria-label={t("multimerge.strategy_aria")}
              onchange={(e) => multimergeCtrl.setStrategy((e.currentTarget as HTMLSelectElement).value as MultiMergeStrategy)}
            >
              {#each STRATEGIES as s}
                <option value={s}>{t("multimerge.strategy_" + s)}</option>
              {/each}
            </select>
          {/if}
        </div>
        {#if multimergeCtrl.mode === "octopus"}
          <p class="mm-caveat mut">{t("multimerge.octopus_caveat")}</p>
        {/if}
      {/if}
    </div>
    <div class="modal-foot">
      {#if multimergeCtrl.resuming}
        <button class="btn ghost" disabled={multimergeCtrl.busy} onclick={() => multimergeCtrl.resumeCancel()}
          >{#if multimergeCtrl.busy}<span class="spinner"></span> {t("multimerge.cancelling")}{:else}{t("multimerge.cancel_queue")}{/if}</button
        >
        <button
          class="btn"
          style="background:var(--accent2);border-color:var(--accent2)"
          disabled={multimergeCtrl.busy}
          onclick={() => multimergeCtrl.resumeContinue()}
          >{#if multimergeCtrl.busy}<span class="spinner"></span> {t("multimerge.continuing")}{:else}{t("multimerge.continue")}{/if}</button
        >
      {:else}
        <button class="btn ghost" disabled={multimergeCtrl.busy} onclick={() => multimergeCtrl.close()}>{t("common.cancel")}</button>
        <button
          class="btn"
          style="background:var(--accent2);border-color:var(--accent2)"
          disabled={!multimergeCtrl.canMerge}
          onclick={() => multimergeCtrl.merge()}
          >{#if multimergeCtrl.busy}<span class="spinner"></span> {t("multimerge.merging")}{:else}{multimergeCtrl.selectedCount === 1 ? t("multimerge.merge_one", { n: multimergeCtrl.selectedCount }) : t("multimerge.merge_many", { n: multimergeCtrl.selectedCount })}{/if}</button
        >
      {/if}
    </div>
  </div>
</div>
