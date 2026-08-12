// 플러그인 시스템(PER-82)의 백엔드(앱 자체 작성) 오류/상태 문자열: 디스크 상의
// 레지스트리(plugin_registry.rs), 명령/훅 실행기(plugin_exec.rs), 그리고
// 내장 Luau 런타임(plugin_lua.rs). 키는 `err_plugins.<key>`가 되며 Rust의
// `ierr`/`ierrp` 메커니즘으로부터 `be()`(src/i18n/i18n.svelte.ts 참고)가
// 조회해요. 영어가 SOURCE OF TRUTH예요.
export default {
  // plugin_registry.rs — 영속 저장(plugins.json)
  could_not_resolve_config_dir: "앱 설정 디렉터리를 확인하지 못했어요: {detail}",
  could_not_create_config_dir: "앱 설정 디렉터리를 만들지 못했어요: {detail}",
  could_not_read: "{path} 파일을 읽지 못했어요: {detail}",
  could_not_serialize: "직렬화하지 못했어요: {detail}",
  could_not_write: "{path} 파일을 쓰지 못했어요: {detail}",
  could_not_finalize: "{path} 파일의 저장을 마무리하지 못했어요: {detail}",

  // plugin_registry.rs — 매니페스트 검증
  plugin_id_invalid:
    "플러그인 id {id}이(가) 유효하지 않아요 — 소문자나 숫자로 시작하고, 그 뒤로는 소문자, 숫자, '-'만 포함해야 해요.",
  missing_name: "플러그인 매니페스트에 name이 없거나 비어 있어요.",
  missing_version: "플러그인 매니페스트에 version이 없거나 비어 있어요.",
  cmd_exactly_one_both:
    "플러그인 명령 {id}은(는) 비어 있지 않은 `run`(shell) 또는 비어 있지 않은 `handler`(Luau) 중 정확히 하나만 선언해야 해요 — 그런데 둘 다 선언했어요.",
  cmd_exactly_one_neither:
    "플러그인 명령 {id}은(는) 비어 있지 않은 `run`(shell) 또는 비어 있지 않은 `handler`(Luau) 중 정확히 하나만 선언해야 해요 — 그런데 둘 다 선언하지 않았어요.",
  cmd_handler_no_lua:
    "플러그인 명령 {id}은(는) Luau `handler`를 선언했지만, 플러그인이 `lua` 스크립트 파일을 선언하지 않았어요.",
  hook_exactly_one_both:
    "이벤트 {event}에 대한 플러그인 훅은 비어 있지 않은 `run`(shell) 또는 비어 있지 않은 `handler`(Luau) 중 정확히 하나만 선언해야 해요 — 그런데 둘 다 선언했어요.",
  hook_exactly_one_neither:
    "이벤트 {event}에 대한 플러그인 훅은 비어 있지 않은 `run`(shell) 또는 비어 있지 않은 `handler`(Luau) 중 정확히 하나만 선언해야 해요 — 그런데 둘 다 선언하지 않았어요.",
  hook_handler_no_lua:
    "이벤트 {event}에 대한 플러그인 훅은 Luau `handler`를 선언했지만, 플러그인이 `lua` 스크립트 파일을 선언하지 않았어요.",
  tama_voice_pitch_not_finite:
    "플러그인 tama의 voicePitch {pitch}이(가) 유한한 수가 아니에요 — 유한한 값이어야 해요(범위를 벗어난 유한 값은 [{min}, {max}] 범위로 제한돼요).",
  tama_pose_key_unknown: "플러그인 tama의 포즈 키 {key}이(가) 내장 포즈가 아니에요 — {keys} 중 하나여야 해요.",
  tama_pose_unsafe_path:
    "플러그인 tama 포즈 {key}의 에셋 경로 {path}이(가) 안전하지 않아요 — 플러그인 디렉터리 내부의 상대 경로여야 해요('/'로 시작할 수 없고 '..'도 포함할 수 없어요).",
  panel_id_invalid:
    "플러그인 패널 id {id}이(가) 유효하지 않아요 — 소문자나 숫자로 시작하고, 그 뒤로는 소문자, 숫자, '-'만 포함해야 해요.",
  panel_id_duplicate: "플러그인에 중복된 패널 id {id}이(가) 있어요 — 패널 id는 플러그인 내에서 고유해야 해요.",
  panel_missing_title: "플러그인 패널 {id}에 비어 있지 않은 제목이 없어요.",
  panel_text_empty: "플러그인 패널 {id}에 텍스트가 비어 있는 text 항목이 있어요.",
  panel_heading_empty: "플러그인 패널 {id}에 텍스트가 비어 있는 heading 항목이 있어요.",
  panel_button_empty_label: "플러그인 패널 {id}에 라벨이 비어 있는 버튼이 있어요.",
  panel_button_missing_command:
    "플러그인 패널 {id}에 명령 {command}을(를) 참조하는 버튼이 있는데, 이 명령은 이 플러그인에 없어요.",
  panel_command_output_empty_label: "플러그인 패널 {id}에 라벨이 비어 있는 command-output 항목이 있어요.",
  panel_command_output_missing_command:
    "플러그인 패널 {id}에 명령 {command}을(를) 참조하는 command-output이 있는데, 이 명령은 이 플러그인에 없어요.",

  // plugin_registry.rs — 매니페스트 읽기(용량 제한, 파싱)
  manifest_not_regular_file: "플러그인 매니페스트 {path}이(가) 일반 파일이 아니에요.",
  manifest_too_large: "플러그인 매니페스트 {path}이(가) 너무 커요({bytes}바이트; 제한은 {limit}바이트예요).",
  manifest_too_large_limit: "플러그인 매니페스트 {path}이(가) 너무 커요(제한 {limit}바이트).",
  manifest_invalid: "{path}은(는) 유효한 플러그인 매니페스트가 아니에요: {detail}",

  // plugin_registry.rs — 설치 / 활성화 / 제거 / 스킨 조회
  already_installed: "id가 {id}인 플러그인이 이미 설치되어 있어요.",
  no_plugin_with_id: "id가 {id}인 플러그인이 설치되어 있지 않아요.",
  plugin_disabled: "플러그인 {id}이(가) 비활성화되어 있어요.",

  // plugin_registry.rs — Luau 스크립트 로딩(read_plugin_lua)
  lua_no_source_dir: "플러그인의 Luau 스크립트가 들어 있을 소스 디렉터리를 확인할 수 없어요.",
  lua_no_script_file: "플러그인이 `lua` 스크립트 파일을 선언하지 않았어요.",
  lua_unsafe_path:
    "플러그인의 `lua` 경로 {path}이(가) 안전하지 않아요 — 플러그인 디렉터리 내부의 상대 경로여야 해요('/'로 시작할 수 없고 '..'도 포함할 수 없어요).",
  lua_not_lua_extension: "플러그인의 `lua` 경로 {path}은(는) `.lua` 파일을 가리켜야 해요.",
  lua_cannot_resolve_dir: "플러그인 소스 디렉터리 {dir}을(를) 확인할 수 없어요: {detail}",
  lua_cannot_read: "플러그인 Luau 스크립트 {path}을(를) 읽을 수 없어요: {detail}",
  lua_escapes_dir: "플러그인 Luau 스크립트 {path}이(가) 플러그인 디렉터리를 벗어나요 — 불러오기를 거부해요.",
  lua_not_regular_file: "플러그인 Luau 스크립트 {path}이(가) 일반 파일이 아니에요.",
  lua_too_large: "플러그인 Luau 스크립트 {path}이(가) 너무 커요({bytes}바이트; 제한은 {limit}바이트예요).",
  lua_too_large_limit: "플러그인 Luau 스크립트 {path}이(가) 너무 커요(제한 {limit}바이트).",

  // plugin_exec.rs — 명령/훅 실행기
  could_not_open_repo_snapshot:
    "변경을 수반하는 플러그인 동작 전에 스냅샷을 찍기 위해 저장소를 열지 못했어요: {detail}",
  windows_cmd_unsafe_value:
    "Windows에서 이 플러그인 명령 실행을 거부해요: {tok} 값에 cmd.exe에 안전하지 않은 문자(& | < > ^ % ! \" 중 하나 또는 줄바꿈)가 포함되어 있어요. 이는 GitCat 플러그인 실행기의 알려진 Windows 제약이에요.",
  could_not_run_command: "플러그인 명령을 실행하지 못했어요: {detail}",
  command_not_found: "플러그인 명령 {plugin_id}/{command_id}을(를) 찾을 수 없거나 비활성화되어 있어요.",
  no_repo_for_command: "플러그인 명령에 저장소 경로가 제공되지 않았어요.",
  no_repo_for_hooks: "플러그인 훅에 저장소 경로가 제공되지 않았어요.",

  // plugin_lua.rs — 내장 Luau 런타임
  lua_vm_create: "샌드박스화된 Lua VM을 만들지 못했어요: {detail}",
  lua_memory_limit: "Lua 메모리 제한을 적용하지 못했어요: {detail}",
  lua_harden_globals: "Lua 전역 변수를 강화하지 못했어요: {detail}",
  lua_enable_sandbox: "Lua 샌드박스를 활성화하지 못했어요: {detail}",
  lua_install_host_api: "플러그인 호스트 API를 설치하지 못했어요: {detail}",
  lua_script_error: "플러그인 스크립트 오류: {detail}",
  lua_module_not_table:
    "플러그인의 메인 Lua 파일은 핸들러 함수들의 테이블을 `return`해야 하는데, {type}을(를) 반환했어요",
  lua_handler_not_found: "플러그인 핸들러 '{handler}'을(를) 메인 파일이 반환한 테이블에서 찾을 수 없었어요",
  lua_handler_not_function: "플러그인 핸들러 '{handler}'은(는) {type}이고, 함수가 아니에요",
  lua_handler_error: "플러그인 핸들러 오류: {detail}",
};
