// 저장소 열기 및 등록, 저장소 루트 파일 읽기, 저장소 요약, 그래프 로드, 그리고
// `gitcat` CLI 설치(PER-82)를 위한 백엔드(앱 자체 작성) 오류/상태 문자열이에요.
// 키는 `err_repo.<key>`가 되며, src/i18n/i18n.svelte.ts의 `be()`가 Rust 쪽이
// `ierr`/`ierrp`로 반환하는 `i18n:err_repo.<key>` 문자열로부터 조회해요. 영어가
// SOURCE OF TRUTH예요.
export default {
  // repo_files.rs / repo_summary.rs / commands.rs(그래프 로드) 공용
  cannot_open_repo: "저장소를 열 수 없어요: {detail}",
  // identity.rs (set_git_identity)
  cannot_open_repo_cap: "저장소를 열 수 없어요: {detail}",
  // identity.rs (get_git_identity — 설정 마법사의 디렉터리 확인도 겸해요)
  not_a_git_repository: "git 저장소처럼 보이지 않아요 — {detail}",
  name_and_email_required: "이름과 이메일은 비워둘 수 없어요.",
  set_identity_success: "이 저장소의 사용자 정보를 설정했어요: {name} <{email}>.",

  // 공용 git 실행기 폴백(identity.rs / repo_summary.rs). detail은 그대로 전달되며
  // (git 자체의 종료 코드 / Option의 디버그 출력), 현지화하지 않아요.
  git_exited_with_status: "git이 상태 코드 {code}(으)로 종료됐어요",
  could_not_run_git: "git을 실행하지 못했어요: {detail}",

  // repo_registry.rs — 추적 저장소 JSON 영속화
  could_not_resolve_config_dir: "앱 설정 디렉터리를 확인하지 못했어요: {detail}",
  could_not_create_config_dir: "앱 설정 디렉터리를 만들지 못했어요: {detail}",
  could_not_read: "{path} 파일을 읽지 못했어요: {detail}",
  could_not_serialize: "직렬화하지 못했어요: {detail}",
  could_not_write: "{path} 파일을 쓰지 못했어요: {detail}",
  could_not_finalize: "{path} 파일의 저장을 마무리하지 못했어요: {detail}",

  // repo_files.rs — .gitignore/.mailmap 편집기
  not_editable_repo_file: "편집 가능한 저장소 파일이 아니에요: {name}(.gitignore와 .mailmap만 지원해요).",
  no_working_tree: "이 저장소에는 작업 트리가 없어요.",
  file_is_symlink: "{name}은(는) 심볼릭 링크예요 — 안전을 위해 이를 통한 읽기나 쓰기를 거부해요.",
  saved_file: "{name}을(를) 저장했어요.",

  // cli_shim.rs — `gitcat` 명령을 PATH에 설치
  cli_unsupported_platform: "앱에서 gitcat 명령을 설치하는 기능은 이 플랫폼에서 아직 지원하지 않아요.",
  couldnt_find_own_program: "GitCat 실행 파일을 찾을 수 없어요: {detail}",
  cli_macos_needs_bundle:
    "이 기능은 설치된 GitCat.app에서만 동작해요. 지금은 번들되지 않은 빌드(예: `cargo tauri dev`)를 실행하고 있는 것 같아요.",
  install_path_not_utf8: "GitCat의 설치 경로가 올바른 UTF-8이 아니에요.",
  couldnt_write: "{path} 파일을 쓰지 못했어요: {detail}",
  couldnt_create: "{path}을(를) 만들지 못했어요: {detail}",
  couldnt_stage_launcher: "런처를 준비하지 못했어요: {detail}",
  temp_path_not_utf8: "임시 경로가 올바른 UTF-8이 아니에요.",
  couldnt_run_admin_helper: "관리자 권한 헬퍼(osascript)를 실행하지 못했어요: {detail}",
  installation_cancelled: "설치가 취소됐어요.",
  couldnt_install_with_admin: "관리자 권한으로 설치하지 못했어요: {detail}",
  couldnt_find_home: "홈 디렉터리($HOME)를 찾을 수 없어요.",
  couldnt_find_localappdata: "%LOCALAPPDATA%를 찾을 수 없어요.",
};
