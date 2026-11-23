// Settings → AI (LLM Resolver). Keys become `aisettings.<key>`.
export default {
  heading: "AI conflict suggestions",
  enable: "Suggest resolutions for conflicts",
  privacy: "Off by default. When on, the resolver gets a Suggest button on each conflict. Pressing it sends that one conflict — both sides, the common ancestor, about 40 lines either side, and the file's path — to the provider below. Nothing else from the repository is sent, and nothing is saved until you press Save resolution.",
  provider: "Provider",
  provider_anthropic: "Anthropic (Claude)",
  provider_openai: "OpenAI-compatible (Ollama, LM Studio, …)",
  model: "Model",
  model_placeholder_local: "the model you pulled, e.g. qwen2.5-coder",
  base_url: "Endpoint",
  api_key: "API key",
  key_saved: "A key is saved. Leave the field blank to keep it.",
  key_env: "Using the key from the environment (ANTHROPIC_API_KEY / OPENAI_API_KEY).",
  key_none: "No key saved. A local runner usually needs none.",
  clear_key: "Remove key",
  save: "Save",
  saved: "Saved.",
};
