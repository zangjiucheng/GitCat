import { beforeEach, describe, expect, it, vi } from "vitest";

let mockInTauri = true;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));
vi.mock("../../ipc/bindings", () => ({
  commands: { getAiSettings: vi.fn(), setAiSettings: vi.fn() },
}));

import { commands, type AiSettingsView } from "../../ipc/bindings";
import { aiSettingsCtrl as ai } from "./aisettings.svelte.ts";

const view = (p: Partial<AiSettingsView> = {}): AiSettingsView => ({
  enabled: false,
  provider: "anthropic",
  model: "",
  baseUrl: "",
  hasApiKey: false,
  envApiKey: false,
  ...p,
});
const ok = <T>(data: T) => ({ status: "ok" as const, data });

beforeEach(() => {
  vi.clearAllMocks();
  mockInTauri = true;
});

describe("aiSettingsCtrl", () => {
  it("load() seeds the form from the backend and leaves the key field blank", async () => {
    vi.mocked(commands.getAiSettings).mockResolvedValueOnce(ok(view({ enabled: true, model: "m", hasApiKey: true })));
    ai.apiKeyDraft = "left over";
    await ai.load();
    expect(ai.enabled).toBe(true);
    expect(ai.model).toBe("m");
    expect(ai.apiKeyDraft).toBe("");
    expect(ai.ready).toBe(true);
  });

  it("save() with a blank key field keeps the stored key (sends null)", async () => {
    vi.mocked(commands.setAiSettings).mockResolvedValueOnce(ok(view({ enabled: true, hasApiKey: true })));
    ai.enabled = true;
    ai.provider = "anthropic";
    ai.model = "";
    ai.baseUrl = "";
    ai.apiKeyDraft = "   ";
    await ai.save();
    expect(commands.setAiSettings).toHaveBeenCalledWith(true, "anthropic", "", "", null);
  });

  it("save() with a typed key sends it, and the field is cleared afterwards", async () => {
    vi.mocked(commands.setAiSettings).mockResolvedValueOnce(ok(view({ hasApiKey: true })));
    ai.apiKeyDraft = " sk-new ";
    await ai.save();
    expect(vi.mocked(commands.setAiSettings).mock.calls[0][4]).toBe("sk-new");
    expect(ai.apiKeyDraft).toBe("");
  });

  it("clearKey() sends an empty key, which removes it", async () => {
    vi.mocked(commands.setAiSettings).mockResolvedValueOnce(ok(view({ hasApiKey: false })));
    await ai.clearKey();
    expect(vi.mocked(commands.setAiSettings).mock.calls[0][4]).toBe("");
    expect(ai.view.hasApiKey).toBe(false);
  });

  it("a backend error is shown in the pane", async () => {
    vi.mocked(commands.setAiSettings).mockResolvedValueOnce({ status: "error", error: "bad url" } as never);
    await ai.save();
    expect(ai.error).toBe("bad url");
  });

  it("design mode keeps the form's values without a backend", async () => {
    mockInTauri = false;
    ai.enabled = true;
    ai.model = "x";
    await ai.save();
    expect(commands.setAiSettings).not.toHaveBeenCalled();
    expect(ai.view.enabled).toBe(true);
    expect(ai.view.model).toBe("x");
  });
});
