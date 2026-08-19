// 설정 모달 문자열. 키는 `settings.<key>` 형태가 돼요.
export default {
  title: "설정",
  subtitle: "테마, 체리픽 기본값, 업데이트 확인, 이 저장소의 git 사용자 정보.",
  tab_general: "일반",
  tab_tama: "Tama",
  tab_identity: "Git 사용자 정보",
  tab_gitconfig: "Git 설정",
  language: "언어",
  language_hint: "앱의 표시 언어예요. 즉시 적용돼요.",
  cli_h4: "명령줄",
  cli_desc:
    "PATH에 <code>gitcat</code> 명령을 추가하면, VS Code의 <code>code .</code>처럼 어떤 터미널에서든 저장소를 열 수 있어요. 터미널을 막지 않고 앱을 열어요. macOS에서는 비밀번호를 입력해야 할 수도 있어요.",
  cli_installing: "설치하는 중…",
  cli_install_btn: "'gitcat' 명령 설치",
  cli_ok: "{path}에 설치했어요. 새 터미널을 열고 원하는 저장소 안에서 gitcat . 명령을 실행해보세요.",
  cli_err: "gitcat 명령을 설치하지 못했어요.",
  cli_err_e: "gitcat 명령을 설치하지 못했어요. {e}",

  // 테마
  appearance: "테마",
  theme_system: "시스템 설정 따르기",
  theme_light: "밝게",
  theme_dark: "어둡게",

  // 그래프
  graph: "그래프",
  show_all_tags_hint: "커밋에 태그가 여러 개 있을 때 첫 번째 것만이 아니라 전부 표시해요",
  show_all_tags: "커밋의 모든 태그 표시",
  label_priority_desc:
    "커밋의 레이블이 모두 들어가지 않을 때 이 종류를 먼저 보여줘요. 행의 <b>+N</b> 칩을 클릭하면 나머지를 순서대로 볼 수 있어요.",
  label_priority_tags: "태그 우선",
  label_priority_branches: "브랜치 우선",
  label_layout_desc:
    "인라인은 커밋의 ref 칩을 제목 텍스트 바로 앞에 표시하고, 왼쪽 열은 크기를 조절할 수 있는 별도의 열에 따로 모아서 표시해요.",
  label_layout_inline: "인라인(제목 앞)",
  label_layout_column: "왼쪽 열",

  // 체리픽
  cherrypick: "체리픽",
  cherrypick_origin_hint: "생성되는 커밋 메시지에 '(cherry picked from …)'을 추가해요",
  cherrypick_record_origin: "체리픽 시 원본 기록(-x)",

  // 업데이트
  updates: "업데이트",
  auto_check_updates: "실행 시 자동으로 업데이트 확인",
  use_nightly: "나이틀리 빌드 사용",
  nightly_hint:
    "매일 만들어지는 불안정한 빌드로, 디버그 로그를 자세히 남겨요. 언제든 최신 안정 버전으로 다시 전환할 수 있어요.",
  check_updates_now: "지금 업데이트 확인",
  checking_updates: "업데이트 확인하는 중…",
  up_to_date: "최신 버전이에요.",
  up_to_date_ok: "확인",
  update_available: "<b>v{version}</b> 버전을 사용할 수 있어요 <span class=\"mut\">(현재 v{current})</span>",
  not_now: "나중에",
  download_install: "다운로드 및 설치",
  downloading_pct: "다운로드하는 중… {progress}%",
  downloading: "다운로드하는 중…",
  update_downloaded: "업데이트를 다운로드했어요 — 설치를 마치려면 재시작해주세요.",
  restart_now: "지금 재시작",
  dismiss: "닫기",

  // 자동 페치
  autofetch: "자동 페치",
  autofetch_hint:
    "저장소가 열려 있는 동안 타이머로 git fetch --all --prune를 실행해서, 수동으로 풀하지 않아도 앞선/뒤처진 커밋 수와 원격에 새로 올라온 변경사항이 항상 최신 상태로 유지돼요",
  autofetch_toggle: "모든 원격에서 주기적으로 페치",
  autofetch_every: "{m}분마다",

  // 유지 관리
  maintenance: "유지 관리",
  maintenance_hint:
    "GitCat이 유휴 상태일 때 백그라운드에서 'git maintenance run --auto'를 실행해서 저장소의 객체 데이터베이스를 깔끔하게 유지해요(commit-graph, gc, repack) — 그래프와 상태가 계속 빠르게 유지되도록요. --auto는 실제로 필요한 작업만 수행해요. 히스토리나 작업 트리를 절대 바꾸지 않고, 원격도 건드리지 않아요.",
  maintenance_toggle: "유휴 상태일 때 백그라운드에서 git maintenance 실행",
  maintenance_desc:
    "저장소의 객체 데이터베이스를 깔끔하게 유지해서(commit-graph, gc, repack) 일상적인 작업이 계속 빠르게 유지되도록 해요 — 앱이 유휴 상태일 때만, 그리고 git이 실제로 필요하다고 판단한 작업만 수행해요. 기본값은 꺼짐이에요.",

  // 스냅샷
  snapshots: "스냅샷",
  snapshots_desc:
    "히스토리를 바꾸는 모든 작업은 복구 가능한 백업을 고정해둬요 — 이것이 ⌘Z 실행 취소와 스냅샷 리본을 가능하게 해주는 원리예요. 정리하지 않으면 시간이 지나면서 계속 쌓여요. 자동 정리는 저장소를 열 때마다 오래된 것들을 정리하고, 가장 최근 스냅샷 하나는 항상 유지돼요.",
  snapshot_keep_all: "전부 유지(정리 안 함)",
  snapshot_keep_count: "최신 N개 유지",
  snapshot_keep_age: "최근 N일 유지",
  snapshot_keep_hybrid: "혼합 — 최신 N개 또는 최근 N일",
  snapshot_count_before: "최신 스냅샷",
  snapshot_count_after: "개 유지",
  snapshot_days_before: "최근",
  snapshot_days_after: "일 동안의 스냅샷 유지",
  snapshot_hybrid_note: "스냅샷은 최신 {count}개 <b>또는</b> 최근 {days}일 이내에 해당하면 유지돼요.",

  // Tama
  tama: "Tama",
  tama_show_hint:
    "Tama가 나타나는 모든 곳(모서리 마스코트, 빈 상태 인사말, 모달 헤더, 실행 취소 팝오버)에서 초상화를 숨겨서 더 단순하고 집중된 느낌을 줘요. 모서리의 상태/오류 메시지는 캐릭터 없이 계속 표시돼요.",
  tama_show: "Tama 표시",
  sound_hint:
    "Tama의 더 중요한 순간들을 위한 짧은 합성음 몇 가지 — 경고, 위험, 축하, 클립보드 복사 완료음",
  sound_toggle: "음향 효과 재생",
  sound_volume_aria: "음향 효과 볼륨",
  sound_test: "테스트",

  // 스킨
  skin: "스킨",
  skin_desc:
    "Tama의 모습과 목소리를 선택하세요 — 기본 그림 초상화, 내장 캐릭터, 설치된 플러그인이 제공하는 스킨 중에서 고를 수 있어요.",
  skin_default: "기본값(내장)",

  // 움직임
  motion: "움직임",
  motion_desc: "Tama의 대기 동작과 반응이 얼마나 활기차게 느껴지는지예요. <b>기본값</b>은 지금의 동작을 그대로 유지해요.",

  // 표정
  expressions: "표정",
  expressions_desc: "각 순간에 Tama가 지을 표정을 선택하세요. 내장된 모습을 그대로 쓰려면 <b>기본값</b>으로 남겨두세요.",
  expressions_pose_default: "기본값({pose})",
  reset_expressions: "표정 초기화",

  // Git 사용자 정보
  git_identity: "Git 사용자 정보",
  identity_no_repo: "저장소를 열면 그 저장소의 git 사용자 정보를 보거나 수정할 수 있어요.",
  identity_loading: "git 사용자 정보 불러오는 중…",
  identity_global_note:
    "이 저장소에는 따로 설정된 사용자 정보가 없어요 — 아래에는 <b>전역</b> git 사용자 정보를 표시하고 있어요. 저장하면 이 저장소만을 위한 사용자 정보를 대신 설정할 수 있어요.",
  identity_name: "이름",
  identity_email: "이메일",
  identity_local_note:
    "이 저장소의 <code>.git/config</code>에만 기록돼요 — 전역 git 사용자 정보는 절대 건드리지 않아요.",

  // Git 설정
  git_config: "Git 설정",
  config_no_repo: "저장소를 열면 그 저장소의 git 설정을 보거나 수정할 수 있어요.",
  config_scope_local: "이 저장소(.git/config)",
  config_scope_global: "전역(~/.gitconfig — 모든 저장소)",
  config_loading: "git 설정 불러오는 중…",
  show_advanced: "고급 표시(임의의 키)…",
  hide_advanced: "고급 숨기기",
  loading: "불러오는 중…",
  filter_placeholder: "키 또는 값 필터…",
  edit: "편집",
  remove: "제거",
  no_entries_match: "\"{filter}\"에 해당하는 항목이 없어요.",
  no_config_entries: "{scope} 설정 항목이 없어요.",
  advanced_add_hint: "키를 추가하거나, 기존 행의 편집을 클릭해 값을 수정하세요.",
  advanced_key_placeholder: "section.key",
  advanced_value_placeholder: "값",
  set: "적용",

  // 하단
  saving: "저장하는 중…",
  save_identity: "사용자 정보 저장",
};
