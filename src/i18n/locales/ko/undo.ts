// 실행 취소 이후 Tama가 축하하는 대사
// (legacy/main.ts의 TamaMascot에서 발생하는 `undo.performed` 이벤트로
// 방출돼요). 키는 `undo.<key>`가 돼요.
export default {
  performed: "{hash} 커밋으로 되돌렸어요 — 아무것도 잃지 않았어요, 먼저 {ref}을(를) 봉인해뒀어요. ♪",
};
