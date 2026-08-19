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

  // 행 / 저장소 우클릭 메뉴(Detail, Workdir, 상단바 저장소 이름).
  // reveal_*는 파일이 든 폴더를 열고 그 파일을 선택해요. open_dir_*는 그
  // 폴더 안으로 바로 들어가요 — 두 동사를 섞지 말아주세요.
  reveal_windows: "파일 탐색기에서 보기",
  reveal_macos: "Finder에서 보기",
  reveal_linux: "파일 관리자에서 보기",
  open_dir_windows: "파일 탐색기에서 열기",
  open_dir_macos: "Finder에서 열기",
  open_dir_linux: "파일 관리자에서 열기",
  // 저장소 기준 상대 경로(git이 그대로 쓰는 형태)와 절대 경로.
  copy_path: "경로 복사",
  copy_full_path: "전체 경로 복사",
};
