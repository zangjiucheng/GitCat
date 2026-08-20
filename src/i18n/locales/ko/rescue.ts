// HEAD가 분리됐을 때, 그리고 다시 브랜치로 돌아왔을 때 Tama가 하는 말
// (legacy/main.ts의 TamaMascot에서 발생하는 `rescue.detached` / `rescue.resolved`
// 이벤트로 방출돼요). 키는 `rescue.<key>`가 돼요.
export default {
  detached: "HEAD가 분리됐어요 — 제가 있으니 걱정하지 마세요. 한 번만 누르면 {branch} 브랜치로 돌아가요.",
  resolved: "{branch} 브랜치로 돌아왔어요. 이제 안전해요.",
};
