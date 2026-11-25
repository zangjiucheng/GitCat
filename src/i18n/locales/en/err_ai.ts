// Backend (app-authored) errors for the LLM Resolver (ai_resolve.rs). Keys
// become `err_ai.<key>`, looked up by `be()`. English is the source of truth.
export default {
  config_dir: "Couldn't open GitCat's settings folder — {detail}",
  save_failed: "Couldn't save the AI settings — {detail}",
  bad_base_url: "The endpoint must start with http:// or https:// — got {url}",
  disabled: "AI suggestions are turned off. Turn them on in Settings → AI.",
  no_key: "No API key. Add one in Settings → AI, or set ANTHROPIC_API_KEY.",
  insecure_key: "Won't send the API key over plain http to {url}. Use https, or a runner on this machine (localhost).",
  no_model: "No model chosen. Name the model in Settings → AI.",
  not_a_conflict: "That part of the file isn't a conflict.",
  binary_file: "This file is binary, so there's nothing to suggest — take one side instead.",
  hunk_too_big: "This conflict is too large to send for a suggestion. Resolve it by hand or take one side.",
  http_failed: "Couldn't reach the AI provider — {detail}",
  auth_failed: "The AI provider rejected the API key — {detail}",
  rate_limited: "The AI provider is rate-limiting requests. Try again in a moment. ({detail})",
  http_status: "The AI provider returned an error ({status}) — {detail}",
  refused: "The model declined to suggest a resolution for this conflict.",
  too_long: "The suggestion was cut off before it finished. Try a smaller conflict.",
  unparseable: "Couldn't read the model's reply as a suggestion.",
  markers_in_reply: "The model's reply still contained conflict markers, so it was discarded.",
};
