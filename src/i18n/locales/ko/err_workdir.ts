// 작업 트리(스테이징/스테이징 해제/버리기/커밋/스태시)와 브랜치(생성/체크아웃/
// 리셋/삭제/이름 변경) 명령을 위한 앱 자체 작성 백엔드 오류 문자열 —
// src-tauri/src/workdir.rs와 src-tauri/src/git_write.rs를 참고하세요. 키는
// `err_workdir.<key>`가 되며 저 Rust 파일들이 ierr()/ierrp()로 반환하는
// `i18n:err_workdir.<key>` 문자열을 `be()`(i18n.svelte.ts)가 조회해요. 영어가
// SOURCE OF TRUTH이며, 여기 있는 `{name}` 플레이스홀더는 Rust 쪽이 전달하는
// 매개변수와 일치해야 해요. 원본 git stderr는 키로 등록되지 않고 — `be()`를
// 그대로 통과해요.
export default {
  // 공용 헬퍼(workdir.rs + git_write.rs).
  could_not_run_git: "git을 실행하지 못했어요: {detail}",
  cannot_open_repo: "저장소를 열 수 없어요: {detail}",
  safety_snapshot_failed: "안전 스냅샷에 실패해서 중단해요: {detail}",
  // pathspec 검증.
  file_path_empty: "파일 경로가 비어 있어요.",
  file_path_looks_like_flag: "플래그처럼 보이는 파일 경로는 거부해요: {file}",
  file_path_illegal_char: "파일 경로에 허용되지 않는 NUL/CR/LF 문자가 있어요: {file}",
  // 파일 diff.
  no_staged_changes_found: "{file}에 스테이징된 변경사항이 없어요.",
  no_unstaged_changes_found: "{file}에 스테이징 안 된 변경사항이 없어요.",
  // 버리기(파일 + 스테이징 안 된 이름 변경 되돌리기).
  could_not_back_up_before_discarding: "버리기 전 {file}을(를) 백업하지 못해 거부해요: {detail}",
  cannot_restore_old_path: "이전 경로 {old_path}을(를) 복원할 수 없어요: {detail}",
  refusing_old_path_exists_no_backup:
    "거부해요: {old_path}이(가) 이미 존재하고, 복원하기 전에 백업하지도 못했어요: {detail}",
  could_not_restore_path: "{old_path}을(를) 복원하지 못했어요: {detail}",
  restored_but_could_not_remove: "{old_path}을(를) 복원했지만, {new_path}을(를) 제거하지 못했어요: {detail}",
  // 줄/헝크 단위 스테이징.
  stale_diff: "이 파일의 diff가 마지막으로 본 뒤로 바뀌었어요 — 새로고침한 뒤 다시 시도해주세요.",
  typechange_line_staging_unsupported:
    "{file}의 타입이 바뀌었어요(파일 <-> 심볼릭 링크 등) — 줄 단위 스테이징은 지원하지 않아요. 대신 파일 전체를 스테이징하거나 버려주세요.",
  binary_line_staging_unsupported:
    "{file}은(는) 바이너리 파일이에요 — 줄 단위 스테이징은 지원하지 않아요. 대신 파일 전체를 스테이징하거나 버려주세요.",
  invalid_selected_line_kind: '선택한 줄 종류 {kind}이(가) 잘못됐어요 — "+"/"-" 줄만 선택할 수 있어요.',
  no_lines_selected: "선택한 줄이 없어요.",
  partial_no_newline_unsupported:
    "{file}의 마지막 줄이 이 변경의 적어도 한쪽에서 줄바꿈으로 끝나지 않아요 — 그 지점에서는 부분 줄 선택을 지원하지 않아요. 대신 헝크 전체(또는 파일 전체)를 선택해주세요.",
  could_not_write_patch_stdin: "패치를 git apply의 표준 입력에 쓰지 못했어요: {detail}",
  // 커밋.
  commit_message_empty: "커밋 메시지가 비어 있어요.",
  // 스태시 저장 / 적용 / 팝 / 삭제.
  nothing_to_stash: "스태시할 것이 없어요 — 작업 트리가 깨끗해요.",
  stash_changed_since:
    "stash@{{index}}이(가) 마지막으로 본 뒤로 바뀌었어요(이전엔 {expected}, 지금은 {actual}) — 스태시 목록을 새로고침한 뒤 다시 시도해주세요.",
  stash_no_longer_exists: "stash@{{index}}이(가) 더 이상 존재하지 않아요 — 스태시 목록을 새로고침한 뒤 다시 시도해주세요.",
  another_op_in_progress: "다른 작업(병합/리베이스/체리픽)이 이미 진행 중이에요 — 먼저 해결하거나 중단해주세요.",
  unresolved_stash_conflicts: "이전 스태시 적용/팝에서 해결되지 않은 충돌이 있어요 — 먼저 해결하거나 중단해주세요.",
  stash_apply_conflict_one:
    "{stash_ref}을(를) 적용하는 중 파일 {n}개에서 충돌이 발생했어요. 충돌 해결기에서 해결한 뒤 계속하거나, 중단하세요. 스태시 항목은 그대로 남아 있어요.",
  stash_apply_conflict_other:
    "{stash_ref}을(를) 적용하는 중 파일 {n}개에서 충돌이 발생했어요. 충돌 해결기에서 해결한 뒤 계속하거나, 중단하세요. 스태시 항목은 그대로 남아 있어요.",
  stash_pop_conflict_one:
    "{stash_ref}을(를) 팝하는 중 파일 {n}개에서 충돌이 발생했어요. 충돌 해결기에서 해결한 뒤 계속하거나, 중단하세요. 스태시 항목은 그대로 남아 있어요.",
  stash_pop_conflict_other:
    "{stash_ref}을(를) 팝하는 중 파일 {n}개에서 충돌이 발생했어요. 충돌 해결기에서 해결한 뒤 계속하거나, 중단하세요. 스태시 항목은 그대로 남아 있어요.",
  refusing_to_drop_no_backup: "{stash_ref} 삭제를 거부해요 — 먼저 백업하지 못했어요: {detail}",
  // 스태시 충돌의 중단 / 계속.
  no_stash_conflict_to_abort: "진행 중인 스태시 충돌이 없어서 중단할 수 없어요.",
  could_not_resolve_snapshot: "충돌 이전 스냅샷 {backup_ref}을(를) 확인하지 못했어요: {detail}",
  no_stash_conflict_to_continue: "진행 중인 스태시 충돌이 없어서 계속할 수 없어요.",
  still_conflicted_one: "아직 파일 {n}개에 충돌이 남아 있어요. 해결한 뒤 계속하거나, 중단하세요.",
  still_conflicted_other: "아직 파일 {n}개에 충돌이 남아 있어요. 해결한 뒤 계속하거나, 중단하세요.",
  could_not_drop_popped_stash: "충돌을 해결했지만, 팝한 스태시 항목을 삭제하지 못했어요: {detail}",
  // 스태시 적용/팝 실행 취소.
  unresolved_conflicts_use_resolver:
    "스태시 적용/팝에서 해결되지 않은 충돌이 있어요 — 실행 취소 대신 충돌 해결기(계속/중단)로 해결해주세요.",
  working_tree_already_clean: "작업 트리가 이미 깨끗해요 — 실행 취소할 것이 없어요.",
  // 브랜치 이름 / 시작점 검증(git_write.rs).
  branch_name_empty: "브랜치 이름이 비어 있어요.",
  branch_name_looks_like_flag: "플래그처럼 보이는 브랜치 이름은 거부해요: {name}",
  branch_name_illegal_whitespace: "브랜치 이름에 허용되지 않는 공백/제어 문자가 있어요: {name}",
  branch_name_illegal_char: "브랜치 이름에 허용되지 않는 문자 '{ch}'이(가) 있어요: {name}",
  not_valid_branch_name: "유효한 브랜치 이름이 아니에요: {name}",
  start_point_empty: "시작점이 비어 있어요.",
  start_point_looks_like_flag: "플래그처럼 보이는 시작점은 거부해요: {rev}",
  start_point_control_char: "시작점에 제어 문자가 포함되어 있어요.",
  // 브랜치 명령(git_write.rs).
  unknown_reset_mode: "알 수 없는 리셋 모드예요: {mode}(soft, mixed, hard 중 하나여야 해요).",
  cannot_resolve_to_commit: "{target}을(를) 커밋으로 확인할 수 없어요: {detail}",
  cannot_delete_current_branch: "{name} 브랜치를 삭제할 수 없어요: 지금 사용 중인 브랜치예요. 먼저 다른 브랜치로 전환해주세요.",
};
