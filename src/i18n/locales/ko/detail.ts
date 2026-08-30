// 커밋 상세 패널 문자열. 키는 `detail.<key>` 형태가 돼요.
export default {
  // Tama 히어로 / 빈 상태.
  hero_alt: "GitCat의 수호자 Tama",
  hero_bubble_loaded:
    'はじめまして! 나는 GitCat의 수호자 <b>Tama</b>다옹. 매번 무언가 바뀌기 전에 스냅샷을 찍어두니까, 히스토리는 언제나 나와 함께 <span class="jp">안전하다옹♪</span>',
  hero_bubble_loaded_plain: "매번 변경 전에 스냅샷이 찍혀요 — 히스토리는 항상 안전해요.",
  hero_stat: '<b>{ms}ms</b> 만에 배치된 커밋 <span class="n">{n}</span>개',
  hero_hint_loaded: "커밋을 클릭해 살펴보세요 · 점을 다른 점 위로 끌어다 놓으면 체리픽돼요 · ⌘Z로 실행 취소",
  hero_bubble_empty:
    'はじめまして! 나는 <b>Tama</b>다옹. Git 저장소를 열어주면 눈 깜짝할 사이에 히스토리를 전부 펼쳐 <span class="jp">보인다옹♪</span>',
  hero_bubble_empty_plain: "시작하려면 Git 저장소를 열어주세요.",
  open_repo: "저장소 열기…",
  hero_hint_open: "또는 상단 바에 있는 저장소 이름 <b>▾</b>을 클릭하세요",
  // 커밋 본문 / id 스트립 / 되돌리기.
  loading: "불러오는 중…",
  show_less: "간략히 보기",
  show_more: "더 보기",
  click_to_copy: "클릭하면 전체 해시가 복사돼요",
  copied: "복사됨 ✓",
  row_of: "{row} / {total}행",
  cant_revert_merge: "병합 커밋은 되돌릴 수 없어요",
  revert_commit: "커밋 되돌리기",
  // 탭 이름. 지금 **보고 있는** 커밋이에요 — 쓰고 있는 커밋을 가리키는
  // workdir.commit과는 일부러 다른 키예요.
  tab_commit: "커밋",
  // 작성자 / 커미터.
  author: "작성자",
  committer: "커미터",
  author_ne_committer: "⚠ 작성자 ≠ 커미터(패치 적용 / 리베이스됨) — 체리픽과 리베이스가 만들어내는, 바로 그 배울 점이에요.",
  // Ref + 스냅샷 커버리지.
  refs_pointing_here: "여기를 가리키는 ref",
  no_refs: "여기를 가리키는 ref가 없어요",
  covered:
    '<b>backup/…{ago} 전</b> 스냅샷이 이 커밋을 보호하고 있어요<br /><span class="mut">Safety Manager 백업 ref로 도달할 수 있어요 — ⌘Z로 여기까지 되돌릴 수 있어요.</span>',
  // 변경사항 / diffstat / 파일 트리.
  changes: "변경사항",
  loading_diff: "diff 불러오는 중…",
  file: "파일",
  files_plural: "파일",
  capped_suffix: " (잘림)",
  loading_files: "파일 불러오는 중…",
  no_file_changes: "파일 변경사항 없음",
  diff: "Diff",
  expand_diff: "diff 확대",
  expand_diff_aria: "diff를 전체 화면으로 확대",
  files_label: "파일",
  resize_file_list: "파일 목록 크기 조절",
  collapse_all_folders: "모든 폴더 접기",
  expand_all_folders: "모든 폴더 펼치기",
  // 파일 행 작업.
  blame: "Blame",
  blame_file: "{path} 파일 Blame",
  history: "히스토리",
  history_file: "{path} 파일 히스토리",
  open_external_diff: "diff를 외부 도구로 열기",
  open_external_diff_for: "{path} 파일의 diff를 외부 도구로 열기",
  // Tama 토스트.
  parent_blame_failed: "삭제된 파일을 Blame하려고 했지만 부모 커밋을 확인하지 못했어요.",
  parent_history_failed: "삭제된 파일의 히스토리를 표시하려고 했지만 부모 커밋을 확인하지 못했어요.",
  parent_resolve_failed: "부모 커밋을 확인하지 못했어요 — {e}",
};
