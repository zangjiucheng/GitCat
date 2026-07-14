<script lang="ts">
  import { codeSearchCtrl } from "./codesearch.svelte.ts";
  import * as bridge from "../../legacy/bridge";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && codeSearchCtrl.open) codeSearchCtrl.close();
  }

  function onSubmit(e: Event) {
    e.preventDefault();
    void codeSearchCtrl.search();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={codeSearchCtrl.open}>
  <div class="modal codesearch">
    <div class="modal-head">
      <div class="modal-tama"><img class="tama-pic" src={bridge.TAMA_IMG.curious} alt="Tama, curious" /></div>
      <div>
        <h3>Search Code&#8230;</h3>
        <p>Full-text search the code as it's currently checked out (or a chosen historical commit) &#8212; not just commit messages or diffs.</p>
      </div>
    </div>
    <div class="modal-body">
      <form class="rm-form" class:busy={codeSearchCtrl.busy} onsubmit={onSubmit}>
        <input
          type="text"
          class="mono"
          placeholder="search text&#8230;"
          bind:value={codeSearchCtrl.query}
          disabled={codeSearchCtrl.busy}
          spellcheck="false"
          autocomplete="off"
        />
        <div class="nb-row">
          <label class="cp-x" title="Match the exact case of what you typed">
            <input type="checkbox" bind:checked={codeSearchCtrl.caseSensitive} disabled={codeSearchCtrl.busy} />
            case sensitive
          </label>
        </div>
        <input
          type="text"
          class="mono"
          placeholder="optional: search at a historical commit (sha/ref) — blank = current checkout"
          bind:value={codeSearchCtrl.atCommit}
          disabled={codeSearchCtrl.busy}
          spellcheck="false"
          autocomplete="off"
        />
        <div class="nb-row">
          <button class="btn" type="submit" disabled={codeSearchCtrl.busy}>
            {#if codeSearchCtrl.busy}<span class="spinner"></span> Searching&#8230;{:else}Search{/if}
          </button>
        </div>
        {#if codeSearchCtrl.error}
          <div class="log-row"><span class="ic">&#9888;</span><span class="msg mut">{codeSearchCtrl.error}</span></div>
        {/if}
      </form>

      {#if codeSearchCtrl.data}
        {#if codeSearchCtrl.data.matches.length === 0}
          <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut">no matches found</code></div>
        {:else}
          <div class="cs-list">
            {#each codeSearchCtrl.data.matches as m, i (m.path + ':' + m.line + ':' + i)}
              <div class="cs-row">
                <span class="cs-loc mono">{m.path}<span class="mut">:{m.line}</span></span>
                <code class="cs-snippet mono">{m.text.trim()}</code>
                <span class="cs-act">
                  <button class="wd-act" title="Blame {m.path}" onclick={() => codeSearchCtrl.openBlame(m)}>&#128065;</button>
                  <button class="wd-act" title="History of {m.path}" onclick={() => codeSearchCtrl.openHistory(m)}>&#128336;</button>
                </span>
              </div>
            {/each}
            {#if codeSearchCtrl.data.truncated}
              <div class="cs-row mut" style="cursor:default">&#8230; truncated (search capped)</div>
            {/if}
          </div>
        {/if}
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" disabled={codeSearchCtrl.busy} onclick={() => codeSearchCtrl.close()}>Close</button>
    </div>
  </div>
</div>
