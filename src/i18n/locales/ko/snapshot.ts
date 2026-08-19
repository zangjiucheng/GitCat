// 백업 스냅샷이 고정됐을 때 Tama의 Safety Manager 대사
// (legacy/main.ts의 TamaMascot에서 발생하는 `snapshot.surfaced` 이벤트로
// 방출돼요). 키는 `snapshot.<key>`가 돼요.
export default {
  surfaced: "백업 {ref}이(가) 고정됐어요 — 걱정하지 마세요, 제가 지키고 있어요.",
};
