<script lang="ts">
  import { codeSearchCtrl } from "./codesearch.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import { t } from "../../i18n/i18n.svelte.ts";
  import Eye from "@lucide/svelte/icons/eye";
  import History from "@lucide/svelte/icons/history";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && codeSearchCtrl.open) {
      codeSearchCtrl.close();
      return;
    }
    // ⌘F / Ctrl+F — "find in code": open Search Code. Shift is excluded so
    // ⌘⇧F stays free for the ref filter (see main.ts). Suppresses the webview's
    // native find-in-page. Needs a repo open to have anything to search.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
      if (!bridge.CUR_REPO) return;
      e.preventDefault();
      codeSearchCtrl.show(bridge.CUR_REPO as unknown as string);
    }
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
        <h3>{t("codesearch.title")}</h3>
        <p>{t("codesearch.subtitle")}</p>
      </div>
    </div>
    <div class="modal-body">
      <form class="rm-form" class:busy={codeSearchCtrl.busy} onsubmit={onSubmit}>
        <input
          type="text"
          class="mono"
          placeholder={t("codesearch.ph_search")}
          bind:value={codeSearchCtrl.query}
          disabled={codeSearchCtrl.busy}
          spellcheck="false"
          autocomplete="off"
        />
        <div class="nb-row">
          <label class="cp-x" title={t("codesearch.case_title")}>
            <input type="checkbox" bind:checked={codeSearchCtrl.caseSensitive} disabled={codeSearchCtrl.busy} />
            {t("codesearch.case_label")}
          </label>
        </div>
        <input
          type="text"
          class="mono"
          placeholder={t("codesearch.ph_commit")}
          bind:value={codeSearchCtrl.atCommit}
          disabled={codeSearchCtrl.busy}
          spellcheck="false"
          autocomplete="off"
        />
        <div class="nb-row">
          <button class="btn" type="submit" disabled={codeSearchCtrl.busy}>
            {#if codeSearchCtrl.busy}<span class="spinner"></span> {t("codesearch.searching")}{:else}{t("codesearch.search_btn")}{/if}
          </button>
        </div>
        {#if codeSearchCtrl.error}
          <div class="log-row"><span class="ic">&#9888;</span><span class="msg mut">{codeSearchCtrl.error}</span></div>
        {/if}
      </form>

      {#if codeSearchCtrl.data}
        {#if codeSearchCtrl.data.matches.length === 0}
          <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut">{t("codesearch.no_matches")}</code></div>
        {:else}
          <div class="cs-list">
            {#each codeSearchCtrl.data.matches as m, i (m.path + ':' + m.line + ':' + i)}
              <div class="cs-row">
                <span class="cs-loc mono">{m.path}<span class="mut">:{m.line}</span></span>
                <code class="cs-snippet mono">{m.text.trim()}</code>
                <span class="cs-act">
                  <button class="wd-act" title={t("codesearch.blame_title", { path: m.path })} onclick={() => codeSearchCtrl.openBlame(m)}><Eye class="ico" size={14} aria-hidden="true" /></button>
                  <button class="wd-act" title={t("codesearch.history_title", { path: m.path })} onclick={() => codeSearchCtrl.openHistory(m)}><History class="ico" size={14} aria-hidden="true" /></button>
                </span>
              </div>
            {/each}
            {#if codeSearchCtrl.data.truncated}
              <div class="cs-row mut" style="cursor:default">{t("codesearch.truncated")}</div>
            {/if}
          </div>
        {/if}
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" disabled={codeSearchCtrl.busy} onclick={() => codeSearchCtrl.close()}>{t("common.close")}</button>
    </div>
  </div>
</div>
