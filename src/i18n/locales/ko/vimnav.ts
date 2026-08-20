// 키보드 단축키 도움말 오버레이(vim 스타일 내비게이션). 설명만 번역하고, 키 글리프
// (⌘K, j, k, …)는 그대로 둬요. 키는 `vimnav.<key>`가 돼요.
export default {
  title: "키보드 단축키",
  subtitle: "항상 켜져 있지만, 입력 필드에 타이핑하는 중에는 절대 작동하지 않아요.",
  cmd_legend: "macOS에서는 Cmd, Windows/Linux에서는 Ctrl",
  shift_legend: "Shift",

  sec_search: "검색",
  sec_sync: "동기화",
  sec_view: "보기 및 패널",
  sec_navigate: "탐색",
  sec_actions: "작업",

  palette: "명령 팔레트(커밋, ref, 작업)",
  search_code: "코드 검색(파일 내용에서 찾기)",
  filter_refs: "ref 필터(사이드바의 ref 검색창으로 포커스 이동)",
  fetch: "페치(원격에서 다운로드)",
  pull: "풀",
  push: "푸시",
  jump_uncommitted: "커밋 안 된 변경사항으로 이동",
  jump_head: "현재 커밋(HEAD)으로 이동",
  focus_mode: "포커스 모드(양쪽 사이드 패널 접기)",
  zoom: "그래프 확대/축소",
  down_up: "아래 / 위(그래프 또는 포커스된 목록)",
  first_last: "첫 / 마지막 커밋",
  half_page: "반 페이지 아래 / 위",
  scroll: "스크롤(그래프에 포커스가 있을 때)",
  enter: "선택한 커밋의 diff 열기(또는 포커스된 행 활성화)",
  undo: "실행 취소(Safety Manager 스냅샷으로 되돌리기)",
  esc: "대화상자 닫기, 입력 확인 취소, 큰 diff 화면 나가기",
  toggle_help: "이 도움말 표시 전환",
};
