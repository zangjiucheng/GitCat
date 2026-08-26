// 여러 island에서 재사용되는 공용 UI 문자열. 키는 `common.<key>`가 돼요.
export default {
  ok: "확인",
  cancel: "취소",
  close: "닫기",
  save: "저장",
  remove: "제거",
  loading: "불러오는 중…",
  // 두 창 사이 분할선의 툴팁이에요(islands/detailpanel/Splitter). 어떤 목록을
  // 조절하는지는 접근성 이름이 이미 말해주니, 여기선 동작만 알려줘요.
  // 두 번 클릭은 알려주지 않으면 알 수가 없는 동작이라 넣었어요.
  splitter_tip: "끌어서 크기 조절 — 두 번 클릭하면 원래대로",
  install: "설치",
};
