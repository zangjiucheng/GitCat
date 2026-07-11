<script lang="ts">
  import { pickaxeSearchCtrl } from "./pickaxesearch.svelte.ts";
  import * as bridge from "../../legacy/bridge";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && pickaxeSearchCtrl.open) pickaxeSearchCtrl.close();
  }

  function onSubmit(e: Event) {
    e.preventDefault();
    void pickaxeSearchCtrl.search();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={pickaxeSearchCtrl.open}>
  <div class="modal pickaxe">
    <div class="modal-head">
      <div class="modal-tama"><img class="tama-pic" src={bridge.TAMA_IMG.curious} alt="Tama, curious" /></div>
      <div>
        <h3>Search Commit Content&#8230;</h3>
        <p>Find every commit whose <b>diff</b> touched a string or pattern &#8212; not just its message (<code>git log -S</code> / <code>-G</code>).</p>
      </div>
    </div>
    <div class="modal-body">
      <form class="rm-form" class:busy={pickaxeSearchCtrl.busy} onsubmit={onSubmit}>
        <input
          type="text"
          class="mono"
          placeholder={pickaxeSearchCtrl.mode === "added-removed" ? "search text…" : "regex…"}
          bind:value={pickaxeSearchCtrl.query}
          disabled={pickaxeSearchCtrl.busy}
          spellcheck="false"
          autocomplete="off"
        />
        <div class="nb-row">
          <select bind:value={pickaxeSearchCtrl.mode} disabled={pickaxeSearchCtrl.busy}>
            <option value="added-removed">Added/removed occurrences (-S)</option>
            <option value="diff-match">Diff line match (-G)</option>
          </select>
        </div>
        <div class="nb-row">
          {#if pickaxeSearchCtrl.mode === "added-removed"}
            <label class="cp-x" title="Treat the search text as a regex (--pickaxe-regex) instead of a literal string">
              <input type="checkbox" bind:checked={pickaxeSearchCtrl.regex} disabled={pickaxeSearchCtrl.busy} />
              treat as regex
            </label>
          {/if}
          <label class="cp-x" title="Walk every ref (--all), not just the current branch's own ancestry">
            <input type="checkbox" bind:checked={pickaxeSearchCtrl.allRefs} disabled={pickaxeSearchCtrl.busy} />
            search all branches
          </label>
        </div>
        <input
          type="text"
          class="mono"
          placeholder="optional: scope to one file/path&#8230;"
          bind:value={pickaxeSearchCtrl.file}
          disabled={pickaxeSearchCtrl.busy}
          spellcheck="false"
          autocomplete="off"
        />
        <div class="nb-row">
          <button class="btn" type="submit" disabled={pickaxeSearchCtrl.busy}>
            {#if pickaxeSearchCtrl.busy}<span class="spinner"></span> Searching&#8230;{:else}Search{/if}
          </button>
        </div>
        {#if pickaxeSearchCtrl.error}
          <div class="log-row"><span class="ic">&#9888;</span><span class="msg mut">{pickaxeSearchCtrl.error}</span></div>
        {/if}
      </form>

      {#if pickaxeSearchCtrl.data}
        {#if pickaxeSearchCtrl.data.entries.length === 0}
          <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut">no commits found matching this search</code></div>
        {:else}
          <div class="pk-list">
            {#each pickaxeSearchCtrl.data.entries as e (e.sha)}
              <button class="pk-row" onclick={() => pickaxeSearchCtrl.jumpToCommit(e.sha)} title="Jump to {e.shortSha}">
                <span class="pk-sha mono">{e.shortSha}</span>
                <span class="pk-main">
                  <span class="pk-subject">{e.subject}</span>
                  <span class="pk-meta mut">{e.an.n} &#183; {bridge.relTime(e.an.t)}</span>
                </span>
              </button>
            {/each}
            {#if pickaxeSearchCtrl.data.truncated}
              <div class="pk-row mut" style="cursor:default">&#8230; truncated (search capped)</div>
            {/if}
          </div>
        {/if}
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" disabled={pickaxeSearchCtrl.busy} onclick={() => pickaxeSearchCtrl.close()}>Close</button>
    </div>
  </div>
</div>
