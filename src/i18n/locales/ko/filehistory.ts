// 파일별 히스토리 모달 문자열. 키는 `filehistory.<key>`가 돼요.
export default {
  heading: "히스토리",
  renamed_from: "이전 경로:",
  as_of: "기준:",
  follows_renames: "이름 변경 추적",
  caveat: "병합을 가로지르는 이름 변경 부근에서는 정보가 빠질 수 있어요(git의 알려진 한계)",
  caveat_title:
    "한 브랜치에서 일어난 이름 변경이 나중에 다른 브랜치의 무관한 변경과 병합으로 합쳐지면, git 자체의 --follow가 파일의 이전 히스토리를 놓칠 수 있어요 — GitCat의 버그가 아니라 git의 알려진 한계예요.",
  loading: "히스토리 불러오는 중…",
  empty: "이 파일의 히스토리를 찾지 못했어요",
  jump_to: "{sha} 커밋으로 이동",
  truncated: "…잘림(히스토리 제한)",
  open_repo_first: "먼저 저장소를 열어주세요.",
  err_load: "이 파일의 히스토리를 불러오지 못했어요.",
  err_unavailable: "파일 히스토리를 사용할 수 없어요 — {reason}",
  warn_not_loaded: "현재 그래프에는 불러오지 않은 커밋이에요",
};
