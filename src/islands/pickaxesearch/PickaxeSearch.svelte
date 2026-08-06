<script lang="ts">
  import { pickaxeSearchCtrl } from "./pickaxesearch.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import { t } from "../../i18n/i18n.svelte.ts";

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
        <h3>{t("pickaxesearch.title")}</h3>
        {#if pickaxeSearchCtrl.mode === "author"}
          <p>{t("pickaxesearch.sub_author_pre")}<b>{t("pickaxesearch.sub_author_bold")}</b>{t("pickaxesearch.sub_author_mid")}<code>git log --author</code>{t("pickaxesearch.sub_author_post")}</p>
        {:else}
          <p>{t("pickaxesearch.sub_diff_pre")}<b>{t("pickaxesearch.sub_diff_bold")}</b>{t("pickaxesearch.sub_diff_mid")}<code>git log -S</code> / <code>-G</code>{t("pickaxesearch.sub_diff_post")}</p>
        {/if}
      </div>
    </div>
    <div class="modal-body">
      <form class="rm-form" class:busy={pickaxeSearchCtrl.busy} onsubmit={onSubmit}>
        <input
          type="text"
          class="mono"
          placeholder={pickaxeSearchCtrl.mode === "added-removed"
            ? t("pickaxesearch.ph_search_text")
            : pickaxeSearchCtrl.mode === "author"
              ? t("pickaxesearch.ph_author")
              : t("pickaxesearch.ph_regex")}
          bind:value={pickaxeSearchCtrl.query}
          disabled={pickaxeSearchCtrl.busy}
          spellcheck="false"
          autocomplete="off"
        />
        <div class="nb-row">
          <select bind:value={pickaxeSearchCtrl.mode} disabled={pickaxeSearchCtrl.busy}>
            <option value="added-removed">{t("pickaxesearch.opt_added_removed")}</option>
            <option value="diff-match">{t("pickaxesearch.opt_diff_match")}</option>
            <option value="author">{t("pickaxesearch.opt_author")}</option>
          </select>
        </div>
        <div class="nb-row">
          {#if pickaxeSearchCtrl.mode === "added-removed"}
            <label class="cp-x" title={t("pickaxesearch.regex_title")}>
              <input type="checkbox" bind:checked={pickaxeSearchCtrl.regex} disabled={pickaxeSearchCtrl.busy} />
              {t("pickaxesearch.regex_label")}
            </label>
          {/if}
          <label class="cp-x" title={t("pickaxesearch.allrefs_title")}>
            <input type="checkbox" bind:checked={pickaxeSearchCtrl.allRefs} disabled={pickaxeSearchCtrl.busy} />
            {t("pickaxesearch.allrefs_label")}
          </label>
        </div>
        <input
          type="text"
          class="mono"
          placeholder={t("pickaxesearch.ph_file")}
          bind:value={pickaxeSearchCtrl.file}
          disabled={pickaxeSearchCtrl.busy}
          spellcheck="false"
          autocomplete="off"
        />
        <div class="nb-row">
          <button class="btn" type="submit" disabled={pickaxeSearchCtrl.busy}>
            {#if pickaxeSearchCtrl.busy}<span class="spinner"></span> {t("pickaxesearch.searching")}{:else}{t("pickaxesearch.search_btn")}{/if}
          </button>
        </div>
        {#if pickaxeSearchCtrl.error}
          <div class="log-row"><span class="ic">&#9888;</span><span class="msg mut">{pickaxeSearchCtrl.error}</span></div>
        {/if}
      </form>

      {#if pickaxeSearchCtrl.data}
        {#if pickaxeSearchCtrl.data.entries.length === 0}
          <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut">{t("pickaxesearch.no_results")}</code></div>
        {:else}
          <div class="pk-list">
            {#each pickaxeSearchCtrl.data.entries as e (e.sha)}
              <button class="pk-row" onclick={() => pickaxeSearchCtrl.jumpToCommit(e.sha)} title={t("pickaxesearch.row_jump", { sha: e.shortSha })}>
                <span class="pk-sha mono">{e.shortSha}</span>
                <span class="pk-main">
                  <span class="pk-subject">{e.subject}</span>
                  <span class="pk-meta mut">{e.an.n} &#183; {bridge.relTime(e.an.t)}</span>
                </span>
              </button>
            {/each}
            {#if pickaxeSearchCtrl.data.truncated}
              <div class="pk-row mut" style="cursor:default">{t("pickaxesearch.truncated")}</div>
            {/if}
          </div>
        {/if}
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" disabled={pickaxeSearchCtrl.busy} onclick={() => pickaxeSearchCtrl.close()}>{t("common.close")}</button>
    </div>
  </div>
</div>
