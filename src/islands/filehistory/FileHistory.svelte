<script lang="ts">
  import { fileHistoryCtrl } from "./filehistory.svelte.ts";
  import * as bridge from "../../legacy/bridge";

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
          History &#8212; <span class="mono">{fileHistoryCtrl.file}</span>
        </h3>
        <p>
          {#if fileHistoryCtrl.oldPath}renamed from <span class="mono">{fileHistoryCtrl.oldPath}</span> &#183; {/if}
          {#if fileHistoryCtrl.atCommit}as of <span class="mono">{fileHistoryCtrl.atCommit.slice(0, 7)}</span>{:else}HEAD{/if}
          &#183; follows renames
        </p>
        <p
          class="mut fh-caveat"
          title="git's own --follow can lose track of a file's earlier history when a rename on one branch is later combined by a merge with unrelated changes on another — a known git limitation, not a GitCat bug."
        >
          may be incomplete around a rename that crosses a merge (known git limitation)
        </p>
      </div>
    </div>
    <div class="modal-body">
      {#if fileHistoryCtrl.loading}
        <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut"><span class="spinner"></span> loading history&#8230;</code></div>
      {:else if fileHistoryCtrl.error}
        <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut">{fileHistoryCtrl.error}</code></div>
      {:else if fileHistoryCtrl.data && fileHistoryCtrl.data.entries.length === 0}
        <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut">no history found for this file</code></div>
      {:else if fileHistoryCtrl.data}
        <div class="fh-list">
          {#each fileHistoryCtrl.data.entries as e (e.sha)}
            <button class="fh-row" onclick={() => fileHistoryCtrl.jumpToCommit(e.sha)} title="Jump to {e.shortSha}">
              <span class="fh-sha mono">{e.shortSha}</span>
              <span class="fh-main">
                <span class="fh-subject">{e.subject}</span>
                <span class="fh-meta mut">{e.an.n} &#183; {bridge.relTime(e.an.t)}{#if e.path !== fileHistoryCtrl.file} &#183; <span class="mono">{e.path}</span>{/if}</span>
                {#if e.renamedFrom}
                  <span class="fh-rename mut">&#8592; renamed from <span class="mono">{e.renamedFrom}</span></span>
                {/if}
              </span>
            </button>
          {/each}
          {#if fileHistoryCtrl.data.truncated}
            <div class="fh-row mut" style="cursor:default">&#8230; truncated (history capped)</div>
          {/if}
        </div>
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" onclick={() => fileHistoryCtrl.close()}>Close</button>
    </div>
  </div>
</div>
