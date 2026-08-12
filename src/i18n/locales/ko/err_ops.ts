// 저장소 작업(OPERATIONS)을 위한 앱 자체 작성 백엔드 오류 문자열 — 패치
// 내보내기/적용(git format-patch --stdout / git am --3way), 3-way 충돌
// 해결기, git bisect. src-tauri/src/patch.rs, src-tauri/src/conflict.rs,
// src-tauri/src/git_bisect.rs를 참고하세요. 키는 `err_ops.<key>`가 되며 저
// Rust 파일들이 ierr()/ierrp()로 반환하는 `i18n:err_ops.<key>` 문자열을
// `be()`(i18n.svelte.ts)가 조회해요. 영어가 SOURCE OF TRUTH이며, 여기 있는
// `{name}` 플레이스홀더는 Rust 쪽이 전달하는 매개변수와 일치해야 해요. 원본
// git stderr는 키로 등록되지 않고 — `be()`를 그대로 통과해요.
export default {
  // 공용 헬퍼(patch.rs + conflict.rs + git_bisect.rs).
  could_not_run_git: "git을 실행하지 못했어요: {detail}",
  cannot_open_repo: "저장소를 열 수 없어요: {detail}",
  cannot_open_repo_lc: "저장소를 열 수 없어요: {detail}",
  safety_snapshot_failed: "안전 스냅샷에 실패해서 중단해요: {detail}",
  cannot_resolve_revision: "리비전 {rev}을(를) 확인할 수 없어요: {detail}",
  refusing_rev_like_flag: "플래그처럼 보이는 리비전은 거부해요: {rev}",
  rev_control_char: "리비전에 제어 문자가 포함되어 있어요.",
  refusing_path_like_flag: "플래그처럼 보이는 경로는 거부해요: {path}",
  path_illegal_nul_newline: "경로에 허용되지 않는 NUL/줄바꿈 문자가 있어요.",
  // 패치 내보내기 / 적용(patch.rs).
  could_not_write_am_stdin: "패치를 git am의 표준 입력에 쓰지 못했어요: {detail}",
  no_revision_given: "리비전이 지정되지 않았어요.",
  no_dest_file_chosen: "대상 파일이 선택되지 않았어요.",
  dest_illegal_nul: "대상 경로에 허용되지 않는 NUL 문자가 있어요.",
  no_patch_file_chosen: "패치 파일이 선택되지 않았어요.",
  apply_conflict_one:
    "패치를 적용하는 중 파일 {n}개에서 충돌이 발생했어요. 해결한 뒤 계속하거나, 이 커밋을 건너뛰거나, 중단하세요.",
  apply_conflict_other:
    "패치를 적용하는 중 파일 {n}개에서 충돌이 발생했어요. 해결한 뒤 계속하거나, 이 커밋을 건너뛰거나, 중단하세요.",
  could_not_finish_applying: "패치 적용을 끝내지 못했어요: {detail}. 계속을 눌러 재시도하거나, 이 커밋을 건너뛰거나, 중단하세요.",
  cannot_export_merge_single:
    "병합 커밋을 단일 패치로 내보낼 수 없어요 — format-patch는 병합에 대해 명확한 단일 diff를 만들지 못해요(git 자체도 그 병합이 아니라 첫 번째 부모의 커밋을 조용히 내보내요). 대신 명시적인 리비전 범위와 함께 패치 내보내기… 메뉴를 사용해주세요.",
  format_patch_failed: "git format-patch가 실패했어요.",
  nothing_to_export: "내보낼 것이 없어요 — 그 범위에는 커밋이 없어요.",
  could_not_write_dest: "{dest}에 쓰지 못했어요: {detail}",
  another_op_in_progress: "다른 작업이 이미 진행 중이에요 — 먼저 해결하거나 중단해주세요.",
  could_not_read_patch_file: "패치 파일을 읽지 못했어요: {detail}",
  no_patch_apply_to_continue: "진행 중인 패치 적용이 없어서 계속할 수 없어요.",
  no_patch_apply_to_skip: "진행 중인 패치 적용이 없어서 커밋을 건너뛸 수 없어요.",
  // 3-way 충돌 해결기(conflict.rs).
  cannot_inspect_repo_state: "저장소 상태를 확인할 수 없어요: {detail}",
  not_in_resolvable_op:
    "지금은 체리픽, 병합, 리베이스, 되돌리기, 스태시, 스쿼시 병합, 패치 적용 충돌 상태가 아니에요(저장소 상태: {op}). {op} 충돌은 명령줄에서 git으로 해결해주세요.",
  unknown_side: '알 수 없는 쪽이에요: {side}("ours" 또는 "theirs" 중 하나여야 해요).',
  no_file_specified: "파일이 지정되지 않았어요.",
  refusing_absolute_path: "절대 경로는 거부해요.",
  refusing_path_dotdot: '".."이 포함된 경로는 거부해요.',
  file_not_conflicted: "{file}은(는) 충돌 상태가 아니에요.",
  cannot_create_scratch_dir: "임시 디렉터리를 만들 수 없어요: {detail}",
  cannot_write_scratch_files: "임시 파일을 쓸 수 없어요: {detail}",
  merge_file_exited_with_status: "git merge-file이 상태 코드 {code}(으)로 종료됐어요",
  could_not_parse_conflict_markers: "이 파일의 충돌 마커를 파싱할 수 없어요 — 닫히지 않은 충돌 영역을 발견했어요.",
  cannot_write_file: "{file}에 쓸 수 없어요: {detail}",
  // Bisect(git_bisect.rs).
  no_commit_specified: "커밋이 지정되지 않았어요.",
  not_a_commit: "이 저장소가 아는 커밋이 아니에요: {rev}",
  bisect_already_in_progress: "이미 bisect가 진행 중이에요 — 새로 시작하기 전에 리셋해주세요.",
  select_known_good: "bisect 범위의 기준이 될, 정상으로 확인된 커밋을 하나 이상 선택해주세요.",
  cannot_verify_clean: "작업 트리가 깨끗한지 확인할 수 없어 bisect를 거부해요: {detail}",
  working_tree_dirty: "작업 트리에 커밋 안 된 변경사항이 있어요 — bisect 전에 커밋하거나 스태시해주세요.",
  unknown_mark: '알 수 없는 마크예요: {mark}("good", "bad", "skip" 중 하나여야 해요).',
  no_bisect_in_progress_start: "진행 중인 bisect가 없어요 — 먼저 시작해주세요.",
  bisect_run_aborted: "자동 bisect 실행이 중단됐어요 — {detail}.",
  bisect_run_already_in_progress: "이미 자동 bisect 실행이 진행 중이에요 — 다른 걸 시작하기 전에 취소해주세요.",
};
