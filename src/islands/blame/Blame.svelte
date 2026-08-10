<script lang="ts">
  import { blameCtrl } from "./blame.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import { t } from "@/i18n/i18n.svelte.ts";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && blameCtrl.open) blameCtrl.close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={blameCtrl.open}>
  <div class="modal blame">
    <div class="modal-head">
      <div class="blame-head-main">
        <h3>
          {t("blame.heading")} &#8212; <span class="mono">{blameCtrl.file}</span>
        </h3>
        <p>
          {#if blameCtrl.oldPath}{t("blame.renamed_from")} <span class="mono">{blameCtrl.oldPath}</span> &#183; {/if}
          {#if blameCtrl.atCommit}{t("blame.at")} <span class="mono">{blameCtrl.atCommit.slice(0, 7)}</span>{:else}{t("blame.head_last_committed")}{/if}
        </p>
      </div>
      <label class="blame-iw">
        <input
          type="checkbox"
          checked={blameCtrl.ignoreWhitespace}
          disabled={blameCtrl.loading}
          onchange={() => blameCtrl.toggleIgnoreWhitespace()}
        /> {t("blame.ignore_whitespace")}
      </label>
    </div>
    <div class="modal-body blame-body">
      {#if blameCtrl.loading}
        <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut"><span class="spinner"></span> {t("blame.loading")}</code></div>
      {:else if blameCtrl.error}
        <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut">{blameCtrl.error}</code></div>
      {:else if blameCtrl.data && blameCtrl.data.totalLines === 0}
        <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut">{t("blame.empty")}</code></div>
      {:else if blameCtrl.data}
        <div class="blame-grid">
          {#each blameCtrl.rows as row, i (i)}
            <div class="blame-row tint-{row.tint}">
              <div class="blame-gutter">
                {#if row.isFirst}
                  <button class="blame-chip" onclick={() => blameCtrl.jumpToCommit(row.hunk.sha)} title={t("blame.jump_to", { sha: row.hunk.shortSha })}>
                    <span class="blame-chip-sha mono">{row.hunk.shortSha}</span>
                    <span class="blame-chip-author">{row.hunk.author.n}</span>
                    <span class="blame-chip-time mut">{bridge.relTime(row.hunk.author.t)}</span>
                    {#if row.hunk.origPath}
                      <span class="blame-chip-orig mut" title={t("blame.orig_title", { path: row.hunk.origPath })}>&#8592; {row.hunk.origPath}</span>
                    {/if}
                  </button>
                {/if}
              </div>
              <code class="blame-code">{@html row.html}</code>
            </div>
          {/each}
          {#if blameCtrl.data.truncated}
            <div class="blame-row">
              <div class="blame-gutter"></div>
              <code class="blame-code mut">{t("blame.truncated")}</code>
            </div>
          {/if}
        </div>
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" onclick={() => blameCtrl.close()}>{t("common.close")}</button>
    </div>
  </div>
</div>
