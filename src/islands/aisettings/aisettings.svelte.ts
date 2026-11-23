// LLM Resolver settings (Settings → AI). The backend owns the file and the
// key (ai_resolve.rs): this controller only ever holds what the webview is
// allowed to see — `hasApiKey`, never the key — plus the form's draft.
//
// `apiKeyDraft` is write-only: blank means "leave the stored key alone", and
// clearing a stored key is its own action (clearKey), so saving the rest of
// the form can never wipe a key by accident.

import { commands, type AiProvider, type AiSettingsView } from "../../ipc/bindings";
import { IN_TAURI } from "../../ipc/env";
import { be, t } from "@/i18n/i18n.svelte.ts";

const DEMO: AiSettingsView = { enabled: false, provider: "anthropic", model: "", baseUrl: "", hasApiKey: false, envApiKey: false };

class AiSettingsState {
  loaded = $state(false);
  view = $state<AiSettingsView>({ ...DEMO });

  // The form. Seeded from `view` on every load so Cancel-by-navigation is free.
  enabled = $state(false);
  provider = $state<AiProvider>("anthropic");
  model = $state("");
  baseUrl = $state("");
  apiKeyDraft = $state("");

  saving = $state(false);
  error = $state("");
  savedNote = $state("");

  /** The resolver's Suggest button shows only when this is true. */
  get ready(): boolean {
    return this.view.enabled;
  }

  private seed(v: AiSettingsView) {
    this.view = v;
    this.enabled = v.enabled;
    this.provider = v.provider;
    this.model = v.model;
    this.baseUrl = v.baseUrl;
    this.apiKeyDraft = "";
  }

  async load(): Promise<void> {
    this.error = "";
    this.savedNote = "";
    if (!IN_TAURI) {
      this.seed(this.view);
      this.loaded = true;
      return;
    }
    try {
      const r = await commands.getAiSettings();
      if (r.status === "ok") this.seed(r.data);
      else this.error = be(r.error);
    } catch (e) {
      this.error = String(e);
    } finally {
      this.loaded = true;
    }
  }

  private async write(apiKey: string | null): Promise<void> {
    this.error = "";
    this.savedNote = "";
    if (!IN_TAURI) {
      // Design mode: keep the form's values so the pane can be exercised.
      this.seed({
        enabled: this.enabled,
        provider: this.provider,
        model: this.model.trim(),
        baseUrl: this.baseUrl.trim(),
        hasApiKey: apiKey === null ? this.view.hasApiKey : apiKey.trim() !== "",
        envApiKey: false,
      });
      this.savedNote = t("aisettings.saved");
      return;
    }
    this.saving = true;
    try {
      const r = await commands.setAiSettings(this.enabled, this.provider, this.model, this.baseUrl, apiKey);
      if (r.status === "ok") {
        this.seed(r.data);
        this.savedNote = t("aisettings.saved");
      } else this.error = be(r.error);
    } catch (e) {
      this.error = String(e);
    } finally {
      this.saving = false;
    }
  }

  /** Save the form. A blank key field keeps whatever key is stored. */
  save(): Promise<void> {
    const k = this.apiKeyDraft.trim();
    return this.write(k === "" ? null : k);
  }

  clearKey(): Promise<void> {
    return this.write("");
  }
}

export const aiSettingsCtrl = new AiSettingsState();
