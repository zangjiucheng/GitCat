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
    if (rangeSummaryCtrl.diffOpen) return; // the modal owns dismissal while it is up
    if (rangeSummaryCtrl.open && popEl && !popEl.contains(e.target as Node)) rangeSummaryCtrl.close();
  }
  // Escape steps back ONE level: the diff modal first, then the popover. Same
  // shape as CommitMenu.svelte's sub-form/menu unwind.
  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    if (rangeSummaryCtrl.diffOpen) rangeSummaryCtrl.closeDiff();
    else if (rangeSummaryCtrl.open) rangeSummaryCtrl.close();
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

      <!-- The stats above answer "how much"; this answers "what". The diff is a
           separate backend call (a Patch per file) so it is fetched only when
           actually asked for — see rangesummary.svelte.ts's own note. -->
      <div class="rs-row">
        <button class="btn" onclick={() => rangeSummaryCtrl.openDiff()}>{t("rangesummary.view_diff")}</button>
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

<!-- The full diff. Reuses the expanded-diff modal's chrome (.modal.diffx and
     its file tree / .diffview panes) so a range diff looks and scrolls exactly
     like a commit's own — and picks up .modal's height cap for free. -->
{#if rangeSummaryCtrl.diffOpen}
  <div class="scrim on" onpointerdown={(e) => e.target === e.currentTarget && rangeSummaryCtrl.closeDiff()}>
    <div class="modal diffx rs-diffx">
      <div class="modal-head">
        <div class="diffx-head-main">
          <h3>{t("rangesummary.diff_title")}</h3>
          <p>
            <span class="mono">{rangeSummaryCtrl.diffA}</span>
            &nbsp;&rarr;&nbsp;
            <span class="mono">{rangeSummaryCtrl.diffB}</span>
            {#if rangeSummaryCtrl.diff}
              &nbsp;&middot;&nbsp;{t("rangesummary.files_changed", { n: rangeSummaryCtrl.diff.filesChanged })}
              <span class="rs-add">+{rangeSummaryCtrl.diff.additions}</span>
              <span class="rs-del">&minus;{rangeSummaryCtrl.diff.deletions}</span>
            {/if}
          </p>
        </div>
      </div>

      <div class="modal-body diffx-body">
        <div class="diffx-files">
          <div class="diffx-files-head">
            <span class="d-lab" style="margin:0">{t("detail.files_label")}</span>
          </div>
          <div class="diffx-files-scroll tree">
            {#if rangeSummaryCtrl.diffLoading}
              <div class="mut" style="padding:6px 4px"><span class="spinner"></span> {t("detail.loading_files")}</div>
            {:else if rangeSummaryCtrl.diffError}
              <div class="mut" style="padding:6px 4px">{rangeSummaryCtrl.diffError}</div>
            {:else if !rangeSummaryCtrl.diff?.fileTree.length}
              <div class="mut" style="padding:6px 4px">{t("detail.no_file_changes")}</div>
            {:else}
              {#each rangeSummaryCtrl.diff.fileTree as f (f.path)}
                <div
                  class="file"
                  class:active={f.path === rangeSummaryCtrl.selectedFile}
                  title={f.path}
                  role="button"
                  tabindex="0"
                  onclick={() => rangeSummaryCtrl.selectFile(f.path)}
                  onkeydown={(e) => (e.key === "Enter" || e.key === " ") && rangeSummaryCtrl.selectFile(f.path)}
                >
                  <span class="st {f.status === 'A' ? 'A' : f.status === 'D' ? 'D' : 'M'}">{f.status}</span>
                  <span class="fname">{f.path}</span>
                  <span class="rs-add">+{f.additions}</span>
                  <span class="rs-del">&minus;{f.deletions}</span>
                </div>
              {/each}
            {/if}
          </div>
        </div>

        <div class="diffview diffx-diff" tabindex="0" role="region" aria-label={t("detail.diff_region")}>
          {#if rangeSummaryCtrl.rows.length === 0 && !rangeSummaryCtrl.diffLoading}
            <div class="mut" style="padding:8px">{t("detail.no_file_changes")}</div>
          {/if}
          {#each rangeSummaryCtrl.rows as row, i (i)}
            {#if row.kind === "hunk"}
              <div class="diff-hunk">{row.text}</div>
            {:else if row.kind === "note"}
              <div class="mut" style="padding:6px 8px">{row.text}</div>
            {:else if row.kind === "line"}
              <div class="diff-line {row.cls}">
                <span class="ln">{row.ln}</span><span class="mk">{row.mk}</span><code>{@html row.html}</code>
              </div>
            {/if}
          {/each}
        </div>
      </div>

      <div class="modal-foot">
        {#if rangeSummaryCtrl.diff?.truncated}
          <span class="mut" style="margin-right:auto">{t("rangesummary.diff_truncated")}</span>
        {/if}
        <button class="btn" onclick={() => rangeSummaryCtrl.closeDiff()}>{t("common.close")}</button>
      </div>
    </div>
  </div>
{/if}
