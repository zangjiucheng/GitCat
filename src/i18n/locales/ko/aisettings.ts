// Settings → AI (LLM Resolver). Keys become `aisettings.<key>`.
export default {
  heading: "AI 충돌 제안",
  enable: "충돌 해결 방법 제안",
  privacy: "기본값은 꺼짐이에요. 켜면 충돌 해결 화면의 각 충돌에 제안 버튼이 생겨요. 누르면 그 충돌 하나만(양쪽 내용, 공통 조상, 앞뒤 약 40줄, 파일 경로) 아래 제공자에게 보내요. 저장소의 다른 내용은 보내지 않고, 해결 결과 저장을 누르기 전에는 아무것도 저장되지 않아요.",
  provider: "제공자",
  provider_anthropic: "Anthropic (Claude)",
  provider_openai: "OpenAI 호환 (Ollama, LM Studio 등)",
  model: "모델",
  model_placeholder_local: "받아 둔 모델, 예: qwen2.5-coder",
  base_url: "엔드포인트",
  api_key: "API 키",
  key_saved: "키가 저장되어 있어요. 비워 두면 그대로 유지돼요.",
  key_env: "환경 변수의 키를 사용 중이에요 (ANTHROPIC_API_KEY / OPENAI_API_KEY).",
  key_none: "저장된 키가 없어요. 로컬 실행기는 보통 키가 필요 없어요.",
  clear_key: "키 삭제",
  save: "저장",
  saved: "저장했어요.",
};
