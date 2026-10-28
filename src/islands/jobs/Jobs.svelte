<script lang="ts">
  // The running-jobs chip and its popover. See jobs.svelte.ts for the model;
  // this is presentation only. Rendered into #jobsMount (the topbar's
  // .tb-right, just before Fetch/Pull/Push) by src/main.ts, and renders
  // NOTHING while idle — the topbar has ~40px of slack at the minimum window
  // width (e2e/topbar-min-width), so the chip only spends it while it matters.
  import { jobsCtrl, jobLabel, elapsed } from "./jobs.svelte.ts";
  import { t } from "@/i18n/i18n.svelte.ts";

  let root: HTMLElement | undefined = $state();

  // A click anywhere outside the chip/popover closes it, like the other
  // topbar popovers. pointerdown, so it lands before the click it precedes.
  function onWindowPointerDown(e: PointerEvent): void {
    if (!jobsCtrl.open) return;
    if (root && e.target instanceof Node && root.contains(e.target)) return;
    jobsCtrl.close();
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

{#if jobsCtrl.count > 0}
  <div class="jobs" bind:this={root}>
    <!-- Spinner + count only; "N running" lives in the tooltip and the
         accessible name. The worded chip overflowed the topbar at the
         minimum window width (e2e/jobs.spec.ts measures it). -->
    <button
      class="tb-btn jobs-chip"
      class:stalled={jobsCtrl.anyStalled}
      aria-haspopup="true"
      aria-expanded={jobsCtrl.open}
      aria-label={t("jobs.running", { n: jobsCtrl.count })}
      title={t("jobs.running", { n: jobsCtrl.count })}
      onclick={() => jobsCtrl.toggle()}
    >
      <span class="spinner" aria-hidden="true"></span>
      <span class="jobs-count">{jobsCtrl.count}</span>
    </button>

    {#if jobsCtrl.open}
      <div class="jobs-pop" role="dialog" aria-label={t("jobs.title")}>
        <div class="jobs-pop-title">{t("jobs.title")}</div>
        {#each jobsCtrl.visible as j (j.id)}
          {@const label = jobLabel(j)}
          <div class="jobs-row" class:stalled={j.stalled}>
            <div class="jobs-row-main">
              <span class="jobs-row-label" title={j.repo}>{label}</span>
              <span class="jobs-row-time mono">{elapsed(jobsCtrl.now - j.startedAtMs)}</span>
            </div>
            {#if j.stalled}
              <div class="jobs-row-stalled">{t("jobs.stalled", { secs: j.idleSecs })}</div>
            {/if}
            <div class="jobs-row-actions">
              {#if jobsCtrl.canShow(j)}
                <!-- A hidden progress modal of this job: bring it back. -->
                <button class="btn jobs-row-show" aria-label={t("jobs.show_aria", { label })} onclick={() => jobsCtrl.show(j.id)}
                  >{t("jobs.show")}</button
                >
              {/if}
              <button
                class="btn danger jobs-row-cancel"
                disabled={j.cancelling}
                aria-label={t("jobs.cancel_aria", { label })}
                onclick={() => jobsCtrl.cancel(j.id)}>{t("common.cancel")}</button
              >
            </div>
          </div>
        {:else}
          <div class="mut jobs-empty">{t("jobs.empty")}</div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .jobs {
    position: relative;
    flex: none;
  }
  /* Same weight as #undoCount's badge: accent-tinted, mono count, compact. */
  .jobs-chip {
    gap: 6px;
    padding: 6px 9px;
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .jobs-chip .spinner {
    width: 10px;
    height: 10px;
  }
  /* Stalled: the theme's warning amber — informs, never alarms. */
  .jobs-chip.stalled {
    color: var(--warning);
    border-color: color-mix(in srgb, var(--warning) 55%, var(--border));
    background: color-mix(in srgb, var(--warning) 10%, var(--elevated));
  }
  .jobs-pop {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 300;
    width: 300px;
    max-height: 60vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--r-control);
    box-shadow: var(--shadow);
  }
  .jobs-pop-title {
    padding: 2px 4px 4px;
    font-size: 11px;
    font-weight: 700;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .jobs-row {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 2px 8px;
    padding: 6px;
    border-radius: var(--r-chip);
    background: var(--elevated);
  }
  .jobs-row.stalled {
    background: color-mix(in srgb, var(--warning) 10%, var(--elevated));
  }
  .jobs-row-main {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .jobs-row-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12.5px;
    font-weight: 600;
  }
  .jobs-row-time {
    flex: none;
    font-size: 11px;
    color: var(--muted);
  }
  .jobs-row-stalled {
    grid-column: 1;
    font-size: 11.5px;
    color: var(--warning);
  }
  .jobs-row-actions {
    grid-column: 2;
    grid-row: 1 / span 2;
    display: flex;
    gap: 4px;
  }
  .jobs-row-actions .btn {
    padding: 3px 10px;
    font-size: 12px;
  }
  .jobs-empty {
    padding: 6px;
    font-size: 12px;
  }
</style>
