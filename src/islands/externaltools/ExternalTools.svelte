<script lang="ts">
  // External Tools settings modal — view. Deliberately no bespoke <style>
  // block: reuses `.scrim`/`.modal`/`.modal-head`/`.modal-body`/`.modal-foot`/
  // `.btn`/`.btn.ghost`/`.rm-form`/`.nb-row`/`.mono`/`.mut`/`.spinner` verbatim
  // (same shared chrome Remotes/Rerere/Reflog reuse — see index.html's own
  // doc comment on the MODALS section), the two-input-per-row shape mirroring
  // Remotes' own "name" + "URL" add-row.
  import { externalToolsCtrl } from "./externaltools.svelte.ts";
  import { t } from "../../i18n/i18n.svelte.ts";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && externalToolsCtrl.open) externalToolsCtrl.close();
  }

  function onFieldKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") void externalToolsCtrl.save();
  }

  function onToolFieldKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") void externalToolsCtrl.saveTool();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={externalToolsCtrl.open}>
  <div class="modal external-tools">
    <div class="modal-head">
      <div>
        <h3>{t("externaltools.title")}</h3>
        <p>{t("externaltools.subtitle")}</p>
      </div>
    </div>
    <div class="modal-body">
      {#if externalToolsCtrl.loading}
        <div class="log-row"><span class="spinner"></span><span class="msg mut">{t("externaltools.loading")}</span></div>
      {:else}
        {#if externalToolsCtrl.error}
          <div class="log-row"><span class="ic">&#9888;</span><span class="msg mut">{externalToolsCtrl.error}</span></div>
        {/if}
        <h4 class="d-lab">{t("externaltools.diff_tool")}</h4>
        <div class="rm-form">
          <input
            type="text"
            placeholder={t("externaltools.diff_name_ph")}
            bind:value={externalToolsCtrl.diffName}
            disabled={externalToolsCtrl.saving}
            spellcheck="false"
            autocomplete="off"
            onkeydown={onFieldKeydown}
          />
          <input
            type="text"
            class="mono"
            placeholder={t("externaltools.custom_cmd_ph")}
            bind:value={externalToolsCtrl.diffCmd}
            disabled={externalToolsCtrl.saving}
            spellcheck="false"
            autocomplete="off"
            onkeydown={onFieldKeydown}
          />
        </div>
        <p class="mut" style="font-size:11.5px;margin:2px 0 14px">
          {t("externaltools.diff_fallback_pre")}<code>git config diff.tool</code>{t("externaltools.diff_fallback_post")}
        </p>

        <h4 class="d-lab">{t("externaltools.merge_tool")}</h4>
        <div class="rm-form">
          <input
            type="text"
            placeholder={t("externaltools.merge_name_ph")}
            bind:value={externalToolsCtrl.mergeName}
            disabled={externalToolsCtrl.saving}
            spellcheck="false"
            autocomplete="off"
            onkeydown={onFieldKeydown}
          />
          <input
            type="text"
            class="mono"
            placeholder={t("externaltools.custom_cmd_ph")}
            bind:value={externalToolsCtrl.mergeCmd}
            disabled={externalToolsCtrl.saving}
            spellcheck="false"
            autocomplete="off"
            onkeydown={onFieldKeydown}
          />
        </div>
        <p class="mut" style="font-size:11.5px;margin:2px 0 0">
          {t("externaltools.merge_fallback_pre")}<code>git config merge.tool</code>{t("externaltools.merge_fallback_mid")}<code>$BASE</code>/<code>$LOCAL</code>/<code>$REMOTE</code>/<code>$MERGED</code>{t("externaltools.merge_fallback_post")}
        </p>

        <h4 class="d-lab" style="margin-top:16px">{t("externaltools.commit_cmd_heading")}</h4>
        <div class="rm-form">
          <input
            type="text"
            class="mono"
            placeholder={t("externaltools.commit_cmd_ph")}
            bind:value={externalToolsCtrl.commitCmd}
            disabled={externalToolsCtrl.saving}
            spellcheck="false"
            autocomplete="off"
            onkeydown={onFieldKeydown}
          />
          <div class="nb-row" style="margin-top:6px">
            <button
              class="btn ghost"
              style="padding:4px 10px"
              title={t("externaltools.ollama_btn_title")}
              disabled={externalToolsCtrl.saving || externalToolsCtrl.suggesting}
              onclick={() => externalToolsCtrl.suggestOllama()}
            >
              {#if externalToolsCtrl.suggesting}<span class="spinner"></span> {t("externaltools.checking")}{:else}&#10024; {t("externaltools.use_ollama")}{/if}
            </button>
          </div>
        </div>
        <p class="mut" style="font-size:11.5px;margin:2px 0 0">
          {t("externaltools.commit_help_1")}<b>{t("externaltools.commit_help_bold")}</b>{t("externaltools.commit_help_2")}&#10024;{t("externaltools.commit_help_3")}<code>opencommit --dry-run</code>{t("externaltools.commit_help_4")}<code>aicommit2</code>{t("externaltools.commit_help_5")}
        </p>

        <h4 class="d-lab" style="margin-top:18px">{t("externaltools.named_tools")}</h4>
        <p class="mut" style="font-size:11.5px;margin:0 0 8px">
          {t("externaltools.named_tools_help_pre")}<b>{t("externaltools.named_tools_help_bold")}</b>{t("externaltools.named_tools_help_post")}
        </p>
        {#if externalToolsCtrl.tools.length === 0}
          <div class="log-row"><span class="msg mut">{t("externaltools.no_named_tools")}</span></div>
        {:else}
          <div class="rm-list">
            {#each externalToolsCtrl.tools as tool (tool.id)}
              <div class="rm-item">
                <div class="rm-main">
                  <span class="rm-name">{tool.name}</span>
                  <span class="row-chip">{tool.kind}</span>
                  <span class="rm-url mono mut" title={tool.cmd}>{tool.cmd}</span>
                  {#if externalToolsCtrl.isActive(tool)}<span class="row-chip head">{t("externaltools.active")}</span>{/if}
                </div>
                <div class="rm-act">
                  <button disabled={externalToolsCtrl.toolsBusy} onclick={() => externalToolsCtrl.toggleActive(tool)}>
                    {externalToolsCtrl.isActive(tool) ? t("externaltools.deactivate") : t("externaltools.use")}
                  </button>
                  <button disabled={externalToolsCtrl.toolsBusy} onclick={() => externalToolsCtrl.startEditTool(tool)}>{t("externaltools.edit")}</button>
                  <button class="danger" disabled={externalToolsCtrl.toolsBusy} onclick={() => externalToolsCtrl.removeTool(tool.id)}>{t("common.remove")}</button>
                </div>
              </div>
            {/each}
          </div>
        {/if}

        <div class="rm-add">
          <div class="rm-form" class:busy={externalToolsCtrl.toolsBusy}>
            <input
              type="text"
              placeholder={t("externaltools.form_id_ph")}
              bind:value={externalToolsCtrl.formId}
              disabled={externalToolsCtrl.toolsBusy || externalToolsCtrl.editingId !== null}
              spellcheck="false"
              autocomplete="off"
              onkeydown={onToolFieldKeydown}
            />
            <input
              type="text"
              placeholder={t("externaltools.form_name_ph")}
              bind:value={externalToolsCtrl.formName}
              disabled={externalToolsCtrl.toolsBusy}
              spellcheck="false"
              autocomplete="off"
              onkeydown={onToolFieldKeydown}
            />
            <select bind:value={externalToolsCtrl.formKind} disabled={externalToolsCtrl.toolsBusy}>
              <option value="diff">{t("externaltools.diff_tool")}</option>
              <option value="merge">{t("externaltools.merge_tool")}</option>
              <option value="commit">{t("externaltools.commit_cmd_heading")}</option>
            </select>
            <input
              type="text"
              class="mono"
              placeholder={t("externaltools.form_cmd_ph")}
              bind:value={externalToolsCtrl.formCmd}
              disabled={externalToolsCtrl.toolsBusy}
              spellcheck="false"
              autocomplete="off"
              onkeydown={onToolFieldKeydown}
            />
            <div class="nb-row">
              {#if externalToolsCtrl.toolsBusy}<span class="spinner"></span>{/if}
              <button class="btn" disabled={externalToolsCtrl.toolsBusy} onclick={() => externalToolsCtrl.saveTool()}>
                {#if externalToolsCtrl.editingId !== null}{t("externaltools.update_tool")}{:else}&#65291; {t("externaltools.add_tool")}{/if}
              </button>
              {#if externalToolsCtrl.editingId !== null}
                <button class="btn ghost" disabled={externalToolsCtrl.toolsBusy} onclick={() => externalToolsCtrl.resetToolForm()}>{t("common.cancel")}</button>
              {/if}
            </div>
          </div>
        </div>
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" disabled={externalToolsCtrl.saving} onclick={() => externalToolsCtrl.close()}>{t("common.close")}</button>
      <button class="btn" disabled={externalToolsCtrl.loading || externalToolsCtrl.saving} onclick={() => externalToolsCtrl.save()}>
        {#if externalToolsCtrl.saving}<span class="spinner"></span> {t("externaltools.saving")}{:else}{t("common.save")}{/if}
      </button>
    </div>
  </div>
</div>
