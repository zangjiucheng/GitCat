<script lang="ts">
  import { fileHistoryCtrl } from "./filehistory.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import { t } from "../../i18n/i18n.svelte.ts";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && fileHistoryCtrl.open) fileHistoryCtrl.close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={fileHistoryCtrl.open}>
  <div class="modal filehistory">
    <div class="modal-head">
      <div class="fh-head-main">
        <h3>
          {t("filehistory.heading")} &#8212; <span class="mono">{fileHistoryCtrl.file}</span>
        </h3>
        <p>
          {#if fileHistoryCtrl.oldPath}{t("filehistory.renamed_from")} <span class="mono">{fileHistoryCtrl.oldPath}</span> &#183; {/if}
          {#if fileHistoryCtrl.atCommit}{t("filehistory.as_of")} <span class="mono">{fileHistoryCtrl.atCommit.slice(0, 7)}</span>{:else}HEAD{/if}
          &#183; {t("filehistory.follows_renames")}
        </p>
        <p
          class="mut fh-caveat"
          title={t("filehistory.caveat_title")}
        >
          {t("filehistory.caveat")}
        </p>
      </div>
    </div>
    <div class="modal-body">
      {#if fileHistoryCtrl.loading}
        <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut"><span class="spinner"></span> {t("filehistory.loading")}</code></div>
      {:else if fileHistoryCtrl.error}
        <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut">{fileHistoryCtrl.error}</code></div>
      {:else if fileHistoryCtrl.data && fileHistoryCtrl.data.entries.length === 0}
        <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut">{t("filehistory.empty")}</code></div>
      {:else if fileHistoryCtrl.data}
        <div class="fh-list">
          {#each fileHistoryCtrl.data.entries as e (e.sha)}
            <button class="fh-row" onclick={() => fileHistoryCtrl.jumpToCommit(e.sha)} title={t("filehistory.jump_to", { sha: e.shortSha })}>
              <span class="fh-sha mono">{e.shortSha}</span>
              <span class="fh-main">
                <span class="fh-subject">{e.subject}</span>
                <span class="fh-meta mut">{e.an.n} &#183; {bridge.relTime(e.an.t)}{#if e.path !== fileHistoryCtrl.file} &#183; <span class="mono">{e.path}</span>{/if}</span>
                {#if e.renamedFrom}
                  <span class="fh-rename mut">&#8592; {t("filehistory.renamed_from")} <span class="mono">{e.renamedFrom}</span></span>
                {/if}
              </span>
            </button>
          {/each}
          {#if fileHistoryCtrl.data.truncated}
            <div class="fh-row mut" style="cursor:default">{t("filehistory.truncated")}</div>
          {/if}
        </div>
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" onclick={() => fileHistoryCtrl.close()}>{t("common.close")}</button>
    </div>
  </div>
</div>
