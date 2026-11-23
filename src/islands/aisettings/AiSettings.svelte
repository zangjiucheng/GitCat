<script lang="ts">
  // Settings → AI. Mounted only while the tab is showing, so loading here
  // re-reads the backend's settings every time the tab is opened.
  import { onMount } from "svelte";
  import { aiSettingsCtrl as ai } from "./aisettings.svelte.ts";
  import { t } from "@/i18n/i18n.svelte.ts";
  import type { AiProvider } from "../../ipc/bindings";

  onMount(() => {
    void ai.load();
  });

  const modelPlaceholder = $derived(ai.provider === "anthropic" ? "claude-opus-5-5" : t("aisettings.model_placeholder_local"));
  const urlPlaceholder = $derived(ai.provider === "anthropic" ? "https://api.anthropic.com" : "http://localhost:11434/v1");
  const keyStatus = $derived(
    ai.view.hasApiKey ? t("aisettings.key_saved") : ai.view.envApiKey ? t("aisettings.key_env") : t("aisettings.key_none"),
  );
</script>

<h4 class="d-lab">{t("aisettings.heading")}</h4>
<label class="set-toggle" style="margin-bottom:8px">
  <input type="checkbox" bind:checked={ai.enabled} disabled={ai.saving} />
  {t("aisettings.enable")}
</label>
<!-- Said BEFORE anything is sent, next to the switch that sends it. -->
<p class="mut ai-privacy" style="font-size:11.5px;margin:0 0 14px">{t("aisettings.privacy")}</p>

<label class="d-lab" for="aiProvider" style="display:block">{t("aisettings.provider")}</label>
<div class="rm-form" style="margin-bottom:12px;max-width:260px">
  <select
    id="aiProvider"
    value={ai.provider}
    disabled={ai.saving}
    onchange={(e) => (ai.provider = (e.target as HTMLSelectElement).value as AiProvider)}
  >
    <option value="anthropic">{t("aisettings.provider_anthropic")}</option>
    <option value="openai_compatible">{t("aisettings.provider_openai")}</option>
  </select>
</div>

<div class="confirm-type" style="max-width:420px">
  <label for="aiModel">{t("aisettings.model")}</label>
  <input id="aiModel" autocomplete="off" spellcheck="false" placeholder={modelPlaceholder} bind:value={ai.model} disabled={ai.saving} />
  <label for="aiBaseUrl" style="margin-top:8px">{t("aisettings.base_url")}</label>
  <input id="aiBaseUrl" autocomplete="off" spellcheck="false" placeholder={urlPlaceholder} bind:value={ai.baseUrl} disabled={ai.saving} />
  <label for="aiKey" style="margin-top:8px">{t("aisettings.api_key")}</label>
  <!-- Write-only: the stored key is never sent back here. Blank keeps it. -->
  <input
    id="aiKey"
    type="password"
    autocomplete="off"
    spellcheck="false"
    placeholder={ai.view.hasApiKey ? "••••••••" : ""}
    bind:value={ai.apiKeyDraft}
    disabled={ai.saving}
  />
</div>
<p class="mut" style="font-size:11.5px;margin:6px 0 12px">
  {keyStatus}
  {#if ai.view.hasApiKey}
    <button class="btn ghost" style="margin-left:6px" disabled={ai.saving} onclick={() => ai.clearKey()}>{t("aisettings.clear_key")}</button>
  {/if}
</p>

<div style="display:flex;align-items:center;gap:10px">
  <button class="btn" disabled={ai.saving} onclick={() => ai.save()}>
    {#if ai.saving}<span class="spinner"></span>{/if}
    {t("aisettings.save")}
  </button>
  {#if ai.error}<span class="pl-err">{ai.error}</span>{:else if ai.savedNote}<span class="mut">{ai.savedNote}</span>{/if}
</div>
