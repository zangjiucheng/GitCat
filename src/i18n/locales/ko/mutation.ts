// 파괴적/재작성 작업이 실행되기 전에 취소됐을 때 Tama가 하는 말
// (legacy/main.ts의 TamaMascot에서 발생하는 `mutation.cancel` 이벤트로 방출돼요).
// 키는 `mutation.<key>`가 돼요.
export default {
  cancel: "취소됐어요 — 아무것도 바뀌지 않았어요.",
  caution: "주의하세요 — 이 작업은 {cnt}를 다시 써요. 백업 {ref}을(를) 먼저 저장해뒀어요.",
  destructive: "{label}은(는) 되돌릴 수 없어요. 백업 {ref}이(가) 고정되어 있어요 — 확인하려면 ref 이름을 입력해주세요.",
  commit_one: "커밋 {n}개",
  commit_many: "커밋 {n}개",
  commit_some: "커밋 몇 개",
  this_label: "이 작업",
};
