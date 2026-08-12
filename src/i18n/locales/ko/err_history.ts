// 히스토리를 다시 쓰는 작업(리베이스, 병합(스쿼시 + 다중/옥토퍼스/순차 포함),
// 되돌리기, 태그 생성/삭제, 체리픽)을 위한 앱 자체 작성 백엔드 오류 문자열
// (PER-82). 키는 `err_history.<key>`가 돼요. 영어가 SOURCE OF TRUTH이며,
// 이 텍스트는 git_rebase.rs / git_merge.rs / git_revert.rs / git_tag.rs /
// git_pick.rs의 Rust `ierr`/`ierrp` 호출부와 그대로 일치해야 해요. 원본 git
// stderr는 여기에 키로 등록되지 않으며(병합/리베이스 실패 후 그런 출력이
// 많이 나와요), 그대로 통과돼요.
export default {
  // 공용 git 실행 / 저장소 열기 / 스냅샷 / 리비전 검증 실패.
  // ({detail}에는 원본 io/git2 사유가 그대로 담기며 번역하지 않아요.)
  could_not_run_git: "git을 실행하지 못했어요: {detail}",
  cannot_open: "저장소를 열 수 없어요: {detail}",
  snapshot_failed: "안전 스냅샷에 실패해서 중단해요: {detail}",
  revision_looks_like_flag: "플래그처럼 보이는 리비전은 거부해요: {rev}",
  revision_control_char: "리비전에 제어 문자가 포함되어 있어요.",

  // 리베이스.
  no_rebase_target: "리베이스할 대상이 없어요.",
  cannot_resolve_revision: "리비전 {rev}을(를) 확인할 수 없어요: {detail}",
  revision_not_commit: "리비전 {rev}은(는) 커밋이 아니에요: {detail}",
  cannot_walk_from_head: "HEAD에서부터 순회할 수 없어요: {detail}",
  cannot_resolve_target: "대상을 확인할 수 없어요: {detail}",
  bad_commit_id: "잘못된 커밋 id {sha}: {detail}",
  cannot_find_commit: "커밋 {sha}을(를) 찾을 수 없어요: {detail}",
  could_not_create_todo_dir: "rebase-todo 디렉터리를 만들지 못했어요: {detail}",
  could_not_write_todo: "미리 계산된 todo를 쓰지 못했어요: {detail}",
  rebase_in_progress: "이미 리베이스가 진행 중이에요 — 먼저 해결하거나 중단해주세요.",
  no_rebase_to_continue: "진행 중인 리베이스가 없어서 계속할 수 없어요.",
  no_rebase_to_skip: "진행 중인 리베이스가 없어서 커밋을 건너뛸 수 없어요.",
  nothing_to_rebase: "리베이스할 것이 없어요 — HEAD와 대상 사이에 커밋이 없어요.",
  unknown_rebase_action: "알 수 없는 리베이스 동작이에요: {action}",
  first_commit_squash:
    "계획의 첫 커밋은 squash/fixup일 수 없어요 — 그 앞에 합칠 대상이 없어요.",
  plan_out_of_date: "이 계획이 저장소와 어긋나 있어요 — 새로고침한 뒤 다시 시도해주세요.",

  // 병합(단일 / 스쿼시 / 다중).
  no_commit_to_merge: "병합할 커밋이 없어요.",
  merge_in_progress: "이미 병합이 진행 중이에요 — 먼저 해결하거나 중단해주세요.",
  unknown_merge_strategy: '알 수 없는 병합 전략이에요: {strategy}("auto", "no-ff", "ff-only" 중 하나여야 해요).',
  no_merge_to_continue: "진행 중인 병합이 없어서 계속할 수 없어요.",
  other_op_in_progress:
    "다른 작업(병합/리베이스/체리픽/되돌리기)이 이미 진행 중이에요 — 먼저 해결하거나 중단해주세요.",
  unresolved_conflicts_already: "이미 해결되지 않은 충돌이 있어요 — 먼저 해결하거나 중단해주세요.",
  no_squash_conflict_to_abort: "진행 중인 스쿼시 병합 충돌이 없어서 중단할 수 없어요.",
  cannot_resolve_snapshot: "충돌 이전 스냅샷 {ref}을(를) 확인하지 못했어요: {detail}",
  no_squash_conflict_to_continue: "진행 중인 스쿼시 병합 충돌이 없어서 계속할 수 없어요.",
  unknown_merge_mode: '알 수 없는 병합 모드예요: {mode}("octopus" 또는 "sequential"이어야 해요).',
  pick_at_least_two: "병합할 브랜치를 두 개 이상 선택해주세요.",
  sequential_queue_in_progress:
    "이미 순차 병합 대기열이 진행 중이에요 — 먼저 계속하거나 중단해주세요.",
  no_sequential_queue: "진행 중인 순차 병합 대기열이 없어요.",
  finish_resolving_first: "먼저 현재 병합의 충돌 해결을 끝내주세요.",

  // 되돌리기.
  no_commit_to_revert: "되돌릴 커밋이 없어요.",
  revert_in_progress: "이미 되돌리기가 진행 중이에요 — 먼저 해결하거나 중단해주세요.",
  no_revert_to_continue: "진행 중인 되돌리기가 없어서 계속할 수 없어요.",

  // 체리픽.
  no_commit_to_cherry_pick: "체리픽할 커밋이 없어요.",
  cannot_resolve: "{rev}을(를) 확인할 수 없어요: {detail}",
  cannot_read_commit: "커밋 {rev}을(를) 읽을 수 없어요: {detail}",
  cherry_pick_in_progress: "이미 체리픽이 진행 중이에요 — 먼저 해결하거나 중단해주세요.",
  no_cherry_pick_to_continue: "진행 중인 체리픽이 없어서 계속할 수 없어요.",

  // 태그 생성 / 삭제.
  tag_name_empty: "태그 이름이 비어 있어요.",
  tag_name_flag: "플래그처럼 보이는 태그 이름은 거부해요: {name}",
  tag_name_control: "태그 이름에 허용되지 않는 공백/제어 문자가 있어요: {name}",
  tag_name_illegal_char: "태그 이름에 허용되지 않는 문자 '{ch}'이(가) 있어요: {name}",
  tag_name_invalid: "유효한 태그 이름이 아니에요: {name}",
  target_empty: "대상이 비어 있어요.",
  target_flag: "플래그처럼 보이는 대상은 거부해요: {rev}",
  target_control: "대상에 제어 문자가 포함되어 있어요.",
  tag_does_not_exist: "태그 {name}이(가) 존재하지 않아요.",
  refuse_delete_tag_backup:
    "태그 {name} 삭제를 거부해요 — 먼저 백업하지 못했어요: {detail}",
};
