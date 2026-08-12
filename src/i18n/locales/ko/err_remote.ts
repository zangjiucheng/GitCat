// 원격 동기화(페치/풀/푸시), 원격 설정 CRUD, 서브모듈을 위한 앱 자체 작성
// 백엔드 오류 문자열(PER-82). 키는 `err_remote.<key>`가 돼요. 영어가 SOURCE OF
// TRUTH이며, 이 텍스트는 git_remote.rs / git_remote_manage.rs / submodule.rs의
// Rust `ierr`/`ierrp` 호출부와 그대로 일치해야 해요. 원본 git stderr는 여기에
// 키로 등록되지 않으며, 그대로 통과돼요.
export default {
  // 공용 git 실행 실패.
  run_git_failed: "git을 실행하지 못했어요: {detail}",
  git_wait_failed: "git 대기에 실패했어요: {detail}",
  git_exited_status: "git이 상태 코드 {code}(으)로 종료됐어요",
  // git 자체의 실패 출력에 덧붙는 SSH 해결 힌트({base}에는 원본 git stderr가
  // 그대로 담기며, 그 자체는 번역하지 않아요).
  ssh_publickey_wsl_hint:
    "{base} (WSL은 셸 초기화를 건너뛰기 때문에 ssh-agent가 시작되지 않아요 — WSL 터미널에서 직접 실행하거나, 패스프레이즈 없는 키를 사용해주세요)",
  host_key_wsl_hint:
    "{base} (WSL 터미널에서 이 원격을 대상으로 ssh/git 명령을 한 번 실행해서 호스트 키를 수락한 뒤 다시 시도해주세요)",
  host_key_hint:
    "{base} (터미널에서 이 원격을 대상으로 ssh/git 명령을 한 번 실행해서 호스트 키를 수락한 뒤 다시 시도해주세요)",
  // 저장소 열기 / 스냅샷.
  cannot_open: "저장소를 열 수 없어요: {detail}",
  snapshot_failed: "안전 스냅샷에 실패해서 중단해요: {detail}",
  // 원격 이름 검증.
  remote_name_empty: "원격 이름이 비어 있어요.",
  remote_name_flag: "플래그처럼 보이는 원격 이름은 거부해요: {name}",
  remote_name_control: "원격 이름에 허용되지 않는 공백/제어 문자가 있어요: {name}",
  // 원격 URL 검증(git_remote_manage의 더 가벼운 URL 가드).
  remote_url_empty: "원격 URL이 비어 있어요.",
  remote_url_flag: "플래그처럼 보이는 URL은 거부해요: {url}",
  remote_url_control: "원격 URL에 제어 문자가 포함되어 있어요.",
  // 브랜치 이름 검증.
  branch_name_empty: "브랜치 이름이 비어 있어요.",
  branch_name_flag: "플래그처럼 보이는 브랜치 이름은 거부해요: {name}",
  branch_name_control: "브랜치 이름에 허용되지 않는 공백/제어 문자가 있어요: {name}",
  branch_name_illegal_char: "브랜치 이름에 허용되지 않는 문자 '{ch}'이(가) 있어요: {name}",
  branch_name_invalid: "유효한 브랜치 이름이 아니에요: {name}",
  // 태그 이름 검증.
  tag_name_empty: "태그 이름이 비어 있어요.",
  tag_name_flag: "플래그처럼 보이는 태그 이름은 거부해요: {name}",
  tag_name_control: "태그 이름에 허용되지 않는 공백/제어 문자가 있어요: {name}",
  tag_name_illegal_char: "태그 이름에 허용되지 않는 문자 '{ch}'이(가) 있어요: {name}",
  tag_name_invalid: "유효한 태그 이름이 아니에요: {name}",
  // 브랜치 / 업스트림 확인.
  no_local_branch: "이름이 {branch}인 로컬 브랜치가 없어요.",
  branch_no_upstream_reset: "{branch} 브랜치에는 리셋할 업스트림이 설정되어 있지 않아요.",
  upstream_name_not_utf8: "{branch} 브랜치의 업스트림 이름이 유효한 UTF-8이 아니에요.",
  head_not_on_branch_push: "HEAD가 브랜치 위에 있지 않아요 — 푸시할 것이 없어요.",
  head_not_on_branch_force_push: "HEAD가 브랜치 위에 있지 않아요 — 강제 푸시할 것이 없어요.",
  no_upstream_use_push: "이 브랜치에는 아직 업스트림이 없어요 — 먼저 푸시로 게시해주세요.",
  upstream_remote_not_utf8: "이 브랜치의 업스트림 원격 이름이 유효한 UTF-8이 아니에요.",
  cannot_resolve_upstream_remote: "이 브랜치의 업스트림 원격을 확인하지 못했어요: {detail}",
  no_such_local_branch: "그런 로컬 브랜치가 없어요: {branch}",
  // 서브모듈 경로 / 저장소 URL 검증.
  submodule_path_empty: "서브모듈 경로가 비어 있어요.",
  submodule_path_flag: "플래그처럼 보이는 서브모듈 경로는 거부해요: {path}",
  submodule_path_control: "서브모듈 경로에 제어 문자가 있어요: {path}",
  repository_url_empty: "저장소 URL이 비어 있어요.",
  repository_url_flag: "플래그처럼 보이는 저장소 URL은 거부해요: {url}",
  repository_url_control: "저장소 URL에 제어 문자가 있어요: {url}",
  // 서브모듈 초기화 해제 / 제거 백업 + 정리
  // ({detail}에는 내부의, 이미 영어로 되어 있는 이유가 그대로 담겨요).
  backup_failed_deinit: "강제 초기화 해제 전 {path} 자체의 커밋 안 된 변경사항을 백업하지 못해 거부해요: {detail}",
  backup_failed_remove: "제거 전 {path} 자체의 커밋 안 된 변경사항을 백업하지 못해 거부해요: {detail}",
  gitlink_staged_but:
    "{path}의 gitlink가 제거 대상으로 스테이징됐지만, {detail}. 다시 시도하기 전에 `git status`로 부분적으로 처리된 상태를 확인해주세요",
};
