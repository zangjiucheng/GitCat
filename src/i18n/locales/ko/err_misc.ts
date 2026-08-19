// "misc" 그룹에 속한 Rust 모듈(PER-82)의 백엔드(앱 자체 작성) 오류/상태
// 문자열: git 설정, 파일 히스토리, plumbing 플레이그라운드, fsck/고립된 커밋
// 복구, blame, WSL 라우팅, 내장 터미널, Safety Manager(실행 취소/스냅샷),
// 업데이터, reflog 복구, rerere. 키는 `err_misc.<key>`가 되며
// src/i18n/i18n.svelte.ts의 `be()`가 Rust의 `ierr`/`ierrp` 메커니즘으로부터
// 조회해요. 영어가 SOURCE OF TRUTH예요.
export default {
  // 공용 저장소 열기 실패(소문자/대문자 시작 두 가지 변형 — 각 호출부의 표현을
  // 그대로 따름).
  cannot_open_repo: "저장소를 열 수 없어요: {detail}",
  cannot_open_repo_cap: "저장소를 열 수 없어요: {detail}",
  not_a_valid_commit: "유효한 커밋이 아니에요: {rev} ({detail})",
  could_not_run_git: "git을 실행하지 못했어요: {detail}",
  git_exited_with_status: "git이 상태 코드 {code}(으)로 종료됐어요",

  // file_history.rs
  path_does_not_exist: "{path} 경로가 {short}에 존재하지 않아요.",
  file_is_a_directory: "{path}은(는) {short}에서 디렉터리예요 — 파일을 선택해주세요.",
  no_file_for_history: "히스토리를 표시할 파일이 없어요.",
  path_nul: "경로에 NUL 바이트가 포함되어 있어요.",

  // blame.rs
  file_is_binary_no_blame: "{path}은(는) 바이너리 파일이에요 — 바이너리 콘텐츠에는 blame을 사용할 수 없어요.",

  // plumbing.rs
  enter_rev_to_inspect: "살펴볼 rev, sha, ref를 입력해주세요.",
  not_a_valid_rev: "이 저장소에서 유효한 rev가 아니에요: {rev} ({detail})",
  resolved_not_a_tag: "확인된 객체가 Tag 종류라고 되어 있지만 실제로는 아니에요.",
  unsupported_object_kind: "{rev}에 대해 지원되지 않는 객체 종류({kind})예요 — commit, tree, blob, tag 중 하나여야 해요.",

  // git_config.rs — 검증
  config_key_empty: "설정 키는 비어 있으면 안 돼요.",
  config_key_malformed: '{key}은(는) git 설정 키처럼 보이지 않아요(예: "section.key" 형식이어야 해요).',
  config_key_charset:
    "{key}에 이 위치의 git 설정 키에는 쓸 수 없는 문자가 포함되어 있어요 — 점으로 구분된 각 부분은 문자, 숫자, '-', '_'만 사용할 수 있어요.",
  value_looks_like_flag: "플래그처럼 보이는 값은 거부해요: {value}",

  // git_config.rs — 설정/해제 결과(범위를 나타내는 말이 키 안에 포함돼 있어
  // 문장 일부로 함께 번역돼요).
  config_set_local: "{key} = {value}(으)로 설정했어요(이 저장소).",
  config_set_global: "{key} = {value}(으)로 설정했어요(전역).",
  config_unset_local: "{key} 설정을 해제했어요(이 저장소).",
  config_unset_global: "{key} 설정을 해제했어요(전역).",
  config_already_unset_local: "{key}은(는) 이미 설정이 해제되어 있었어요(이 저장소).",
  config_already_unset_global: "{key}은(는) 이미 설정이 해제되어 있었어요(전역).",

  // wsl.rs
  wsl_status_timed_out: "WSL 상태 확인이 {timeout} 후 시간 초과됐어요 — 터미널에서 `wsl --shutdown`을 실행한 뒤 이 저장소를 다시 열어보세요",
  unexpected_rev_list_output: "`git rev-list --left-right --count`의 출력이 예상과 달라요: {output}",
  wsl_ahead_behind_timed_out: "WSL 앞선/뒤처진 커밋 수 확인이 {timeout} 후 시간 초과됐어요",

  // terminal.rs
  terminal_session_ended: "이 터미널 세션은 이미 종료됐어요.",

  // updater.rs
  bad_nightly_endpoint: "잘못된 nightly 엔드포인트: {detail}",
  updater_endpoint_error: "업데이터 엔드포인트 오류: {detail}",
  updater_init_failed: "업데이터 초기화에 실패했어요: {detail}",
  update_check_failed: "업데이트 확인에 실패했어요: {detail}",

  // reflog.rs
  restore_needs_worktree: "복원에는 작업 트리가 필요해요(베어 저장소는 지원하지 않아요)",
  cannot_verify_clean_refusing_restore: "작업 트리가 깨끗한지 확인할 수 없어 복원을 거부해요: {detail}",
  worktree_has_uncommitted_restore: "작업 트리에 커밋 안 된 변경사항이 있어요 — 복원하기 전에 커밋하거나 스태시해주세요.",
  cannot_read_head_reflog_cap: "HEAD의 reflog를 읽을 수 없어요: {detail}",
  cannot_read_head_reflog: "HEAD의 reflog를 읽을 수 없어요: {detail}",
  reflog_stale_selection_one: "{ref}이(가) 더 이상 존재하지 않아요 — reflog에는 이제 항목이 {count}개 있어요. 오래된 선택으로 복원하는 것은 거부해요.",
  reflog_stale_selection_many: "{ref}이(가) 더 이상 존재하지 않아요 — reflog에는 이제 항목이 {count}개 있어요. 오래된 선택으로 복원하는 것은 거부해요.",
  restore_aborted_snapshot_failed: "복원이 중단됐어요 — 먼저 현재 상태의 스냅샷을 찍지 못했어요: {detail}",
  restore_failed: "복원에 실패했어요: {detail}",
  restored_to: "{ref}({sha}) 시점으로 복원했어요.",

  // safety.rs — 스냅샷 / 실행 취소
  snapshot_created_not_found: "스냅샷을 만들었지만 찾을 수 없어요",
  nothing_to_undo: "실행 취소할 것이 없어요 — 아직 스냅샷이 없어요.",
  undo_needs_worktree: "실행 취소에는 작업 트리가 필요해요(베어 저장소는 지원하지 않아요)",
  cannot_verify_clean_refusing_undo: "작업 트리가 깨끗한지 확인할 수 없어 실행 취소를 거부해요: {detail}",
  worktree_has_uncommitted_undo: "작업 트리에 커밋 안 된 변경사항이 있어요 — 실행 취소하기 전에 커밋하거나 스태시해주세요.",
  undo_aborted_snapshot_failed: "실행 취소가 중단됐어요 — 먼저 현재 상태의 스냅샷을 찍지 못했어요: {detail}",
  undo_failed_restoring_head: "실행 취소 중 HEAD 복원에 실패했어요: {detail}",
  undo_failed: "실행 취소에 실패했어요: {detail}",
  undo_failed_detaching_head: "실행 취소 중 HEAD 분리에 실패했어요: {detail}",
  couldnt_stash_before_undo: "실행 취소 전에 변경사항을 스태시하지 못했어요 — {detail}",

  // rerere.rs
  rerere_enabled: "이 저장소에서 rerere를 활성화했어요.",
  rerere_disabled: "이 저장소에서 rerere를 비활성화했어요.",
};
