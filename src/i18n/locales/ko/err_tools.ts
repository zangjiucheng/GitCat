// 외부 도구, 코드 검색, pickaxe 모듈을 위한 백엔드(앱 자체 작성) 오류/상태
// 문자열(PER-82). 키는 `err_tools.<key>`가 되며, src/i18n/i18n.svelte.ts의
// `be()`가 Rust의 `ierr`/`ierrp` 메커니즘으로부터 조회해요. 영어가 SOURCE OF
// TRUTH예요.
export default {
  // code_search.rs / pickaxe.rs / tool_settings.rs 공용
  cannot_open_repo: "저장소를 열 수 없어요: {detail}",
  cannot_open_repo_cap: "저장소를 열 수 없어요: {detail}",
  not_a_valid_commit: "유효한 커밋이 아니에요: {rev} ({detail})",
  could_not_run_git: "git을 실행하지 못했어요: {detail}",
  git_exited_with_status: "git이 상태 코드 {code}(으)로 종료됐어요",
  enter_search_text: "검색할 내용을 입력해주세요.",
  search_text_nul: "검색 텍스트에 NUL 바이트가 포함되어 있어요.",

  // pickaxe.rs
  path_does_not_exist: "{path} 경로가 {short}에 존재하지 않아요.",
  unknown_pickaxe_mode: '알 수 없는 pickaxe 모드예요: {mode}("added-removed", "diff-match", "author" 중 하나여야 해요).',
  path_nul: "경로에 NUL 바이트가 포함되어 있어요.",

  // tool_settings.rs — 저장
  could_not_resolve_config_dir: "앱 설정 디렉터리를 확인하지 못했어요: {detail}",
  could_not_create_config_dir: "앱 설정 디렉터리를 만들지 못했어요: {detail}",
  could_not_read: "{path} 파일을 읽지 못했어요: {detail}",
  could_not_serialize: "직렬화하지 못했어요: {detail}",
  could_not_write: "{path} 파일을 쓰지 못했어요: {detail}",
  could_not_finalize: "{path} 파일의 저장을 마무리하지 못했어요: {detail}",

  // tool_settings.rs — 검증
  tool_name_charset: "도구 이름 {name}에는 문자, 숫자, '-', '_'만 사용할 수 있어요.",
  tool_id_required: "도구 id가 필요해요.",
  tool_id_charset: "도구 id {id}은(는) 소문자나 숫자로 시작해야 하고, 소문자, 숫자, '-'만 포함할 수 있어요.",
  tool_name_required: "도구 이름이 필요해요.",
  tool_command_required: "도구 명령이 필요해요.",
  no_tool_with_id: "id가 {id}인 {kind} 도구가 없어요.",
  no_value_given: "제공된 값이 없어요.",
  value_looks_like_flag: "플래그처럼 보이는 값은 거부해요: {value}",
  value_illegal_char: "값에 허용되지 않는 NUL/줄바꿈 문자가 있어요.",

  // tool_settings.rs — 커밋 메시지 생성
  no_commit_command:
    "커밋 메시지 명령이 설정되어 있지 않아요. 도구 ▸ 외부 도구에서 하나를 추가해주세요(예: `aicommit`) — GitCat이 이를 실행해서 출력을 여기로 가져와요. GitCat 자체는 어떤 AI와도 직접 통신하지 않아요.",
  could_not_run_commit_command: "커밋 메시지 명령을 실행하지 못했어요: {detail}",
  interactive_command:
    '이 명령은 대화형이에요 — 입력을 요청하려고 했어요. GitCat은 이를 비대화형으로 실행하고 출력에서 메시지를 읽으므로, 커밋 메시지를 그냥 "출력"하고 종료하는 명령을 설정해주세요(예: 스테이징된 diff를 모델에 파이프로 전달: `git diff --staged | ollama run <model> "write a commit message"`, 또는 작은 스크립트). aicommit2/opencommit처럼 대화형으로 \'생성 후 커밋\'까지 직접 처리하는 도구는 전체 커밋 과정을 스스로 담당해요 — 이 입력란이 아니라 해당 도구의 git 훅을 사용해주세요.',
  commit_command_failed: "커밋 메시지 명령이 실패했어요: {detail}",
  commit_command_no_output: "커밋 메시지 명령이 아무 출력도 내지 않았어요.",

  // tool_settings.rs — diff/병합 도구 실행
  no_diff_tool: "설정된 외부 diff 도구가 없어요. 도구 ▸ 외부 도구…에서 설정해주세요.",
  no_merge_tool: "설정된 외부 병합 도구가 없어요. 도구 ▸ 외부 도구…에서 설정해주세요.",
  could_not_launch_difftool: "git difftool을 실행하지 못했어요: {detail}",
  rev_range_both_or_neither: "fromRev와 toRev는 둘 다 지정하거나 둘 다 생략해야 해요.",
  range_and_staged_exclusive: "특정 리비전 범위와 `staged`는 동시에 사용할 수 없어요.",
  filename_double_quote:
    "{file}에 큰따옴표 문자가 포함되어 있어서 git 자체의 mergetool 통합이 안정적으로 처리할 수 없어요 — 이 파일은 대신 직접 해결해주세요.",
  cannot_inspect_repo_state: "저장소 상태를 확인할 수 없어요: {detail}",
  not_in_conflict_op:
    "지금은 체리픽, 병합, 리베이스, 되돌리기, 스태시, 스쿼시 병합, 패치 적용 충돌 상태가 아니에요(저장소 상태: {op}). {op} 충돌은 명령줄에서 git으로 해결해주세요.",
  could_not_run_mergetool: "git mergetool을 실행하지 못했어요: {detail}",
  tool_changed_nothing:
    "외부 도구가 정상적으로 종료됐지만 실제로 {file}을(를) 바꾸지는 않았어요 — 해결된 것은 없어요. git이 인덱스에서는 여전히 해결됨으로 표시했을 수 있어요; 계속하는 대신 중단을 사용해서 원래 충돌을 완전히 복원해주세요.",
  resolved_all_done: "외부 도구로 {file}을(를) 해결했어요. 모든 충돌이 해결됐어요 — 완료하려면 계속을 누르세요.",
  resolved_some_remaining: "외부 도구로 {file}을(를) 해결했어요. 아직 파일 {remaining}개에 충돌이 남아 있어요.",
  tool_no_success: "외부 도구가 {file}에 대한 해결 성공을 보고하지 않았어요.",
};
