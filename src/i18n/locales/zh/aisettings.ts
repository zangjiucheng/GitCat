// Settings → AI (LLM Resolver). Keys become `aisettings.<key>`.
export default {
  heading: "AI 冲突建议",
  enable: "为冲突提供解决建议",
  privacy: "默认关闭。开启后,解决冲突界面的每个冲突旁会出现“建议”按钮。点击后,只会把这一处冲突(两边内容、共同祖先、前后约 40 行以及文件路径)发送给下面的服务商。仓库里的其它内容都不会发送;在你点“保存解决结果”之前也不会写入任何内容。",
  provider: "服务商",
  provider_anthropic: "Anthropic(Claude)",
  provider_openai: "OpenAI 兼容接口(Ollama、LM Studio 等)",
  model: "模型",
  model_placeholder_local: "你下载的模型,例如 qwen2.5-coder",
  base_url: "接口地址",
  api_key: "API key",
  key_saved: "已保存 key。留空即保持不变。",
  key_env: "正在使用环境变量里的 key(ANTHROPIC_API_KEY / OPENAI_API_KEY)。",
  key_none: "没有保存 key。本地模型通常不需要。",
  clear_key: "移除 key",
  save: "保存",
  saved: "已保存。",
};
