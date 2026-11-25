// LLM Resolver(ai_resolve.rs)的后端(应用自撰)错误。键名对应
// `err_ai.<key>`,由 `be()` 查找。英文为最终来源。
export default {
  config_dir: "无法打开 GitCat 的设置文件夹 — {detail}",
  save_failed: "无法保存 AI 设置 — {detail}",
  bad_base_url: "地址必须以 http:// 或 https:// 开头 — 当前是 {url}",
  disabled: "AI 建议已关闭。请在 设置 → AI 中开启。",
  no_key: "没有 API key。请在 设置 → AI 中填写,或设置 ANTHROPIC_API_KEY。",
  insecure_key: "不会通过明文 http 把 API key 发送到 {url}。请改用 https,或使用本机(localhost)上的服务。",
  no_model: "没有选择模型。请在 设置 → AI 中填写模型名。",
  not_a_conflict: "文件的这一部分不是冲突。",
  binary_file: "这是二进制文件,无法给出建议 — 请直接选用一侧。",
  hunk_too_big: "这个冲突太大,不适合发送去生成建议。请手动解决或直接选用一侧。",
  http_failed: "无法连接 AI 服务 — {detail}",
  auth_failed: "AI 服务拒绝了这个 API key — {detail}",
  rate_limited: "AI 服务正在限流,请稍后再试。({detail})",
  http_status: "AI 服务返回错误({status})— {detail}",
  refused: "模型拒绝为这个冲突给出解决建议。",
  too_long: "建议在完成前被截断了。请尝试更小的冲突。",
  unparseable: "无法把模型的回复解析为建议。",
  markers_in_reply: "模型的回复里仍有冲突标记,已丢弃。",
};
