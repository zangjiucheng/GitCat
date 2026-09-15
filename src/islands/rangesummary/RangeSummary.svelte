<!--
  Compare two commits (#49) — view.

  No <style> block: reuses the global .ref-pop popover chrome the commit menu
  already uses, so this sits at the cursor and dismisses exactly like every
  other canvas popover. Its own few rules live in index.html beside .cm-pop.
-->
<script lang="ts">
  import { rangeSummaryCtrl } from "./rangesummary.svelte.ts";
  import { t } from "@/i18n/i18n.svelte.ts";

  let popEl: HTMLDivElement | undefined = $state();

  // Same dismiss contract as CommitMenu.svelte's own: this island owns its
  // window listeners rather than borrowing another island's.
  function onWindowPointerdown(e: PointerEvent) {
    if (rangeSummaryCtrl.open && popEl && !popEl.contains(e.target as Node)) rangeSummaryCtrl.close();
  }
  function onWindowKeydown(e: KeyboardEvent) {
    if (rangeSummaryCtrl.open && e.key === "Escape") rangeSummaryCtrl.close();
  }

  const s = $derived(rangeSummaryCtrl.summary);
</script>

<svelte:window onpointerdown={onWindowPointerdown} onkeydown={onWindowKeydown} />

{#if rangeSummaryCtrl.open}
  <div class="ref-pop rs-pop" bind:this={popEl} style="left:{rangeSummaryCtrl.x}px;top:{rangeSummaryCtrl.y}px">
    <div class="cm-head">
      <span class="sha mono">{rangeSummaryCtrl.aShort} … {rangeSummaryCtrl.bShort}</span>
      <span class="subject">{t("rangesummary.title")}</span>
    </div>

    {#if rangeSummaryCtrl.loading}
      <div class="rs-row"><span class="spinner"></span><span class="mut">{t("common.loading")}</span></div>
    {:else if rangeSummaryCtrl.error}
      <div class="rs-row mut">{rangeSummaryCtrl.error}</div>
    {:else if s}
      {#if !s.mergeBase}
        <!-- Separate roots (an orphan branch, a grafted import). The delta
             below is still real, so it is still shown — an empty popover would
             just look broken. -->
        <div class="rs-note">{t("rangesummary.no_common_ancestor")}</div>
      {/if}

      {#if s.linear && s.ahead === 0}
        <div class="rs-note">{t("rangesummary.same_commit")}</div>
      {:else if s.linear}
        <div class="rs-row">
          <strong>{t("rangesummary.commits", { n: s.ahead })}</strong>
          <span class="mut">{s.from} → {s.to}</span>
        </div>
      {:else}
        <!-- Diverged: two legs, and this popover draws one list. Report the
             fork instead of showing one leg as if it were the whole range. -->
        <div class="rs-row">
          <strong>{t("rangesummary.diverged", { ahead: s.ahead, behind: s.behind })}</strong>
        </div>
        {#if s.mergeBase}
          <div class="rs-row mut">{t("rangesummary.fork_point", { sha: s.mergeBase })}</div>
        {/if}
      {/if}

      <div class="rs-row rs-stat">
        <span>{t("rangesummary.files_changed", { n: s.filesChanged })}</span>
        <span class="rs-add">+{s.additions}</span>
        <span class="rs-del">&minus;{s.deletions}</span>
      </div>

      {#if s.commits.length}
        <div class="rs-list">
          {#each s.commits as c (c.sha)}
            <div class="rs-commit">
              <span class="rs-dot" aria-hidden="true"></span>
              <span class="sha mono">{c.sha}</span>
              <span class="rs-subject">{c.subject}</span>
            </div>
          {/each}
        </div>
        {#if s.truncated}
          <div class="rs-note mut">{t("rangesummary.truncated", { n: s.commits.length })}</div>
        {/if}
      {/if}
    {/if}
  </div>
{/if}
