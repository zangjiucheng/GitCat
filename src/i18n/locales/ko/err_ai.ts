// LLM Resolver(ai_resolve.rs)의 백엔드(앱 작성) 오류. 키는
// `err_ai.<key>`가 되며 `be()`가 찾아요. 영어가 원본이에요.
export default {
  config_dir: "GitCat 설정 폴더를 열 수 없어요 — {detail}",
  save_failed: "AI 설정을 저장할 수 없어요 — {detail}",
  bad_base_url: "주소는 http:// 또는 https://로 시작해야 해요 — 입력값: {url}",
  disabled: "AI 제안이 꺼져 있어요. 설정 → AI에서 켜 주세요.",
  no_key: "API 키가 없어요. 설정 → AI에서 추가하거나 ANTHROPIC_API_KEY를 설정하세요.",
  no_model: "모델이 선택되지 않았어요. 설정 → AI에서 모델 이름을 입력하세요.",
  not_a_conflict: "파일의 이 부분은 충돌이 아니에요.",
  binary_file: "바이너리 파일이라 제안할 수 없어요 — 한쪽을 선택하세요.",
  hunk_too_big: "이 충돌은 제안을 받기에 너무 커요. 직접 해결하거나 한쪽을 선택하세요.",
  http_failed: "AI 제공자에 연결할 수 없어요 — {detail}",
  auth_failed: "AI 제공자가 API 키를 거부했어요 — {detail}",
  rate_limited: "AI 제공자가 요청을 제한하고 있어요. 잠시 후 다시 시도하세요. ({detail})",
  http_status: "AI 제공자가 오류를 반환했어요 ({status}) — {detail}",
  refused: "모델이 이 충돌에 대한 해결 제안을 거절했어요.",
  too_long: "제안이 끝나기 전에 잘렸어요. 더 작은 충돌로 시도해 보세요.",
  unparseable: "모델의 응답을 제안으로 읽을 수 없어요.",
  markers_in_reply: "모델의 응답에 충돌 표시가 남아 있어 버렸어요.",
};
