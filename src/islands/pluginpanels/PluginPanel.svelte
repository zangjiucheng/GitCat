<script lang="ts">
  // Declarative plugin panel (PER-45) — view. A real .scrim/.modal (mounted
  // into <body> in src/main.ts, same chrome as Reflog/Plumbing/Rerere) that
  // renders whatever the active plugin panel DECLARED, from a fixed widget
  // vocabulary GitCat owns: heading / text / button / command-output. It never
  // evals anything — a `button` only ever calls pluginPanelsCtrl.runButton(),
  // which runs that plugin's OWN command via the declarative backend path.
  //
  // Reuses the global modal classes (.scrim/.modal/.modal-head/.modal-body/
  // .modal-foot/.btn/.spinner/.mut); the scoped style block below covers only
  // the per-widget bits (headings, paragraphs, the command-output preformatted
  // block).
  import { pluginPanelsCtrl } from "./pluginpanels.svelte.ts";
  import { t } from "@/i18n/i18n.svelte.ts";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && pluginPanelsCtrl.open) pluginPanelsCtrl.close();
  }

  // Backdrop click closes — but only a click landing on the scrim ITSELF, not
  // one bubbling up from inside the .modal.
  function onScrimClick(e: MouseEvent) {
    if (e.target === e.currentTarget) pluginPanelsCtrl.close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scrim" class:on={pluginPanelsCtrl.open} onclick={onScrimClick}>
  <div class="modal pluginpanel">
    <div class="modal-head">
      <div class="modal-tama"><img class="tama-pic" src={pluginPanelsCtrl.tamaImg} alt={t("pluginpanels.tama_alt")} /></div>
      <div>
        <h3>{pluginPanelsCtrl.panel?.title ?? t("pluginpanels.default_title")}</h3>
        {#if pluginPanelsCtrl.pluginName}<p>{pluginPanelsCtrl.pluginName}</p>{/if}
      </div>
    </div>
    <div class="modal-body">
      {#if pluginPanelsCtrl.panel}
        {@const panel = pluginPanelsCtrl.panel}
        {#each panel.items as item, i (i)}
          {#if item.type === "heading"}
            <h4 class="pp-heading">{item.text}</h4>
          {:else if item.type === "text"}
            <p class="pp-text">{item.text}</p>
          {:else if item.type === "button"}
            <div class="pp-btn-row">
              <button
                class="btn"
                disabled={pluginPanelsCtrl.runningButtons[item.command]}
                onclick={() => pluginPanelsCtrl.runButton(pluginPanelsCtrl.pluginId, item.command)}
              >
                {#if pluginPanelsCtrl.runningButtons[item.command]}<span class="spinner"></span> {t("pluginpanels.running")}{:else}{item.label}{/if}
              </button>
            </div>
          {:else if item.type === "command-output"}
            {@const out = pluginPanelsCtrl.outputs[i]}
            <div class="pp-out">
              <div class="pp-out-head">
                <span class="pp-out-label">{item.label ?? item.command}</span>
                <button
                  class="pp-rerun"
                  disabled={out?.running}
                  title={t("pluginpanels.rerun_title")}
                  onclick={() => pluginPanelsCtrl.runCommandOutput(i)}
                >
                  {#if out?.running}<span class="spinner"></span> {t("pluginpanels.running")}{:else}&#8635; {t("pluginpanels.rerun")}{/if}
                </button>
              </div>
              {#if out?.error}<div class="pp-out-err">{out.error}</div>{/if}
              {#if out?.running && !out?.text}
                <pre class="pp-pre mut"><span class="spinner"></span> {t("pluginpanels.running")}</pre>
              {:else}
                <pre class="pp-pre">{out?.text ?? ""}</pre>
              {/if}
            </div>
          {/if}
        {/each}
        {#if panel.items.length === 0}
          <p class="pp-text mut">{t("pluginpanels.empty")}</p>
        {/if}
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" onclick={() => pluginPanelsCtrl.close()}>{t("common.close")}</button>
    </div>
  </div>
</div>

<style>
  .pp-heading {
    margin: 14px 0 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }
  .pp-heading:first-child {
    margin-top: 2px;
  }
  .pp-text {
    margin: 6px 0;
    color: var(--muted);
    line-height: 1.5;
  }
  .pp-btn-row {
    margin: 8px 0;
  }
  .pp-out {
    margin: 10px 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--elevated);
  }
  .pp-out-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
  }
  .pp-out-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
  }
  .pp-rerun {
    appearance: none;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 6px;
    cursor: pointer;
  }
  .pp-rerun:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--accent);
  }
  .pp-rerun:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .pp-out-err {
    padding: 6px 10px 0;
    color: var(--accent2);
    font-size: 12px;
  }
  .pp-pre {
    margin: 0;
    padding: 10px;
    max-height: 340px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.45;
    color: var(--text);
  }
</style>
