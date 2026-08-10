<script lang="ts">
  // Plugins manager — view. A VS Code Extensions-style two-pane modal: the
  // installed plugins list on the left, the selected one's detail on the right.
  // Reuses the shared .scrim/.modal/.modal-head/.modal-body/.modal-foot/.btn/
  // .mut/.spinner/.pl-err/.set-toggle/.d-lab/.log-row chrome (same as Settings/
  // ExternalTools); the two-pane split + list rows are the only bespoke styling
  // (the scoped style block below). All state + management is in plugins.svelte.ts.
  import { pluginsCtrl, pluginContribution } from "./plugins.svelte.ts";
  import { t } from "@/i18n/i18n.svelte.ts";
  import Trash2 from "@lucide/svelte/icons/trash-2";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && pluginsCtrl.open) pluginsCtrl.close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={pluginsCtrl.open}>
  <div class="modal plugins-modal">
    <div class="modal-head">
      <div>
        <h3>{t("plugins.title")}</h3>
        <p>{t("plugins.subtitle")}</p>
      </div>
    </div>

    <div class="pl-toolbar">
      <input
        class="pl-search"
        placeholder={t("plugins.filter_ph")}
        autocomplete="off"
        spellcheck="false"
        aria-label={t("plugins.filter_aria")}
        bind:value={pluginsCtrl.filter}
      />
      <button class="btn" disabled={pluginsCtrl.pluginInstalling} onclick={() => pluginsCtrl.installPlugin()}>
        {#if pluginsCtrl.pluginInstalling}<span class="spinner"></span> {t("plugins.installing")}{:else}&#65291; {t("plugins.install_from_file")}{/if}
      </button>
    </div>
    {#if pluginsCtrl.pluginsError}
      <div class="pl-err" style="margin:0 20px 8px">{pluginsCtrl.pluginsError}</div>
    {/if}

    <div class="modal-body pl-body">
      {#if pluginsCtrl.pluginsLoading && pluginsCtrl.plugins.length === 0}
        <div class="log-row" style="padding:24px"><span class="spinner"></span><span class="msg mut">{t("plugins.loading")}</span></div>
      {:else if pluginsCtrl.plugins.length === 0}
        <div class="pl-empty">
          <p class="mut" style="font-weight:600">{t("plugins.empty_title")}</p>
          <p class="mut" style="font-size:11.5px;max-width:380px;text-align:center;line-height:1.55">
            {t("plugins.empty_desc_pre")}<code>plugin.json</code>{t("plugins.empty_desc_post")}
          </p>
        </div>
      {:else}
        <div class="pl-split">
          <div class="pl-list" role="listbox" aria-label={t("plugins.installed_aria")} tabindex="-1">
            {#each pluginsCtrl.filteredPlugins as p (p.id)}
              <button
                type="button"
                class="pl-row"
                class:sel={pluginsCtrl.selectedId === p.id}
                class:off={p.enabled === false}
                role="option"
                aria-selected={pluginsCtrl.selectedId === p.id}
                onclick={() => pluginsCtrl.select(p.id)}
              >
                <span class="pl-dot" class:on={p.enabled !== false} title={p.enabled !== false ? t("plugins.enabled") : t("plugins.disabled")}></span>
                <span class="pl-row-main">
                  <span class="pl-row-name">{p.name}</span>
                  <span class="pl-row-ver mut">v{p.version}</span>
                </span>
              </button>
            {:else}
              <p class="mut" style="padding:14px 12px;font-size:12px">{t("plugins.no_match", { q: pluginsCtrl.filter.trim() })}</p>
            {/each}
          </div>

          <div class="pl-detail">
            {#if pluginsCtrl.selected}
              {@const p = pluginsCtrl.selected}
              {@const c = pluginContribution(p)}
              <div class="pl-detail-head">
                <h4 class="pl-detail-name">{p.name} <span class="mut" style="font-weight:400;font-size:13px">v{p.version}</span></h4>
                <span class="pl-detail-id mut">{p.id}</span>
              </div>
              {#if p.description}<p class="pl-detail-desc">{p.description}</p>{/if}

              <div class="d-lab" style="margin-top:16px">{t("plugins.contributes")}</div>
              <ul class="pl-contrib">
                {#if c.commands > 0}<li>{c.commands === 1 ? t("plugins.contrib_commands_one", { n: c.commands }) : t("plugins.contrib_commands_other", { n: c.commands })} <span class="mut">{t("plugins.contrib_commands_palette")}</span></li>{/if}
                {#if c.hooks > 0}<li>{c.hooks === 1 ? t("plugins.contrib_hooks_one", { n: c.hooks }) : t("plugins.contrib_hooks_other", { n: c.hooks })}</li>{/if}
                {#if c.panels > 0}<li>{c.panels === 1 ? t("plugins.contrib_panels_one", { n: c.panels }) : t("plugins.contrib_panels_other", { n: c.panels })}</li>{/if}
                {#if c.lua}<li>{t("plugins.contrib_lua")}</li>{/if}
                {#if c.tama}<li>{t("plugins.contrib_tama")}</li>{/if}
                {#if c.commands === 0 && c.hooks === 0 && c.panels === 0 && !c.lua && !c.tama}
                  <li class="mut">{t("plugins.contrib_nothing")}</li>
                {/if}
              </ul>

              <div class="pl-detail-actions">
                {#if pluginsCtrl.removingPluginId === p.id}
                  <div class="pl-confirm">
                    <span class="pl-confirm-msg">{t("plugins.remove_confirm_pre")}<b>{p.name}</b>{t("plugins.remove_confirm_mid")}<code>plugin.json</code>{t("plugins.remove_confirm_post")}</span>
                    <div class="pl-confirm-act">
                      <button class="btn ghost" disabled={pluginsCtrl.pluginBusyId === p.id} onclick={() => pluginsCtrl.cancelRemovePlugin()}>{t("common.cancel")}</button>
                      <button class="btn danger" disabled={pluginsCtrl.pluginBusyId === p.id} onclick={() => pluginsCtrl.confirmRemovePlugin(p.id)}>
                        {#if pluginsCtrl.pluginBusyId === p.id}<span class="spinner"></span> {/if}{t("common.remove")}
                      </button>
                    </div>
                  </div>
                {:else}
                  <div class="pl-enable">
                    <button
                      type="button"
                      class="pl-switch"
                      class:on={p.enabled !== false}
                      role="switch"
                      aria-checked={p.enabled !== false}
                      aria-label={p.enabled !== false ? t("plugins.disable_aria") : t("plugins.enable_aria")}
                      disabled={pluginsCtrl.pluginBusyId === p.id}
                      onclick={() => pluginsCtrl.setPluginEnabled(p.id, p.enabled === false)}
                    >
                      <span class="pl-switch-knob"></span>
                    </button>
                    <span class="pl-enable-label">{p.enabled !== false ? t("plugins.enabled") : t("plugins.disabled")}</span>
                    {#if pluginsCtrl.pluginBusyId === p.id}<span class="spinner"></span>{/if}
                  </div>
                  <span style="flex:1"></span>
                  <button class="pl-remove" disabled={pluginsCtrl.pluginBusyId === p.id} onclick={() => pluginsCtrl.startRemovePlugin(p.id)}>
                    <Trash2 size={14} aria-hidden="true" /> {t("common.remove")}
                  </button>
                {/if}
              </div>
            {:else}
              <div class="pl-empty"><p class="mut">{t("plugins.select_prompt")}</p></div>
            {/if}
          </div>
        </div>
      {/if}
    </div>

    <div class="modal-foot">
      <button class="btn ghost" onclick={() => pluginsCtrl.close()}>{t("common.close")}</button>
    </div>
  </div>
</div>

<style>
  /* Wider than the default modal — a two-pane view needs room. */
  .plugins-modal {
    width: min(860px, 92vw);
    max-width: 92vw;
  }
  .pl-toolbar {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 12px 20px 8px;
  }
  .pl-search {
    flex: 1;
    min-width: 0;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r-control);
    color: var(--text);
    font: inherit;
    font-size: 13px;
    padding: 7px 10px;
  }
  .pl-body {
    padding: 0;
    display: flex;
    min-height: 0;
  }
  .pl-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 40px 20px;
  }
  .pl-split {
    flex: 1;
    display: grid;
    grid-template-columns: minmax(180px, 240px) 1fr;
    min-height: 0;
    height: 52vh;
  }
  .pl-list {
    overflow: auto;
    border-right: 1px solid var(--border);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .pl-row {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-control);
    color: var(--text);
    font: inherit;
    padding: 7px 9px;
    cursor: pointer;
  }
  .pl-row:hover {
    background: var(--elevated);
  }
  .pl-row.sel {
    background: var(--elevated);
    border-color: var(--border);
  }
  .pl-row.off .pl-row-name {
    color: var(--muted);
  }
  .pl-dot {
    flex: 0 0 auto;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--muted);
    opacity: 0.5;
  }
  .pl-dot.on {
    background: var(--success);
    opacity: 1;
  }
  .pl-row-main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.25;
  }
  .pl-row-name {
    font-size: 12.5px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pl-row-ver {
    font-size: 10.5px;
  }
  .pl-detail {
    overflow: auto;
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
  }
  .pl-detail-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .pl-detail-name {
    margin: 0;
    font-size: 16px;
  }
  .pl-detail-id {
    font-family: var(--mono);
    font-size: 11px;
  }
  .pl-detail-desc {
    margin: 10px 0 0;
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--text);
  }
  .pl-contrib {
    margin: 6px 0 0;
    padding-left: 18px;
    font-size: 12.5px;
    line-height: 1.7;
  }
  .pl-detail-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: auto;
    padding-top: 18px;
  }
  /* Enable/disable — a proper pill toggle (amber when on) rather than a bare
     checkbox, to match the app's warm control language. */
  .pl-enable {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .pl-enable-label {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--text);
  }
  .pl-switch {
    position: relative;
    flex: 0 0 auto;
    width: 34px;
    height: 20px;
    padding: 0;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--elevated);
    cursor: pointer;
    transition:
      background-color 0.15s,
      border-color 0.15s;
  }
  .pl-switch.on {
    background: var(--accent);
    border-color: var(--accent);
  }
  .pl-switch:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .pl-switch-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--muted);
    transition:
      transform 0.15s,
      background-color 0.15s;
  }
  .pl-switch.on .pl-switch-knob {
    transform: translateX(14px);
    background: #fff;
  }
  /* Remove — a quiet ghost button that only lights up danger-red on hover,
     mirroring the app's .wd-act.danger / .tb-btn.danger pattern. */
  .pl-remove {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: var(--r-control);
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s,
      background-color 0.12s;
  }
  .pl-remove:hover:not(:disabled),
  .pl-remove:focus-visible:not(:disabled) {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 45%, transparent);
    background: color-mix(in srgb, var(--danger) 12%, transparent);
  }
  .pl-remove:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  /* Inline remove confirm — the destructive action gets the app's solid
     .btn.danger (red glow); Cancel stays a plain ghost. */
  .pl-confirm {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: space-between;
  }
  .pl-confirm-msg {
    flex: 1;
    min-width: 180px;
    font-size: 12px;
    color: var(--text);
  }
  .pl-confirm-act {
    display: flex;
    gap: 8px;
    flex: 0 0 auto;
  }
</style>
