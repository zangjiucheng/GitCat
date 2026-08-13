// HEAD를 커밋으로 리셋해요. 키는 `resethead.<key>`가 돼요.
export default {
  open_repo_first: "먼저 저장소를 열어주세요.",
  reset_mode_head: "리셋 모드",
  mode_soft: "<b>Soft</b> — HEAD만 옮기고, 인덱스와 작업 트리의 모든 변경사항은 그대로 유지해요.",
  mode_mixed:
    "<b>Mixed</b> — HEAD를 옮기고 스테이징을 해제하지만, 작업 트리 파일은 그대로 유지해요 <em>(git의 기본값)</em>.",
  mode_hard:
    "<b>Hard</b> — HEAD를 옮기고 <b>스테이징된 변경사항과 스테이징 안 된 변경사항을 모두 버려요</b>. 커밋 안 된 작업은 실행 취소 없이 사라져요.",
  note_snapshot:
    "먼저 지금 HEAD가 있는 위치를 스냅샷으로 찍어둬요 — 그래야 작업 트리가 깨끗할 때 ⌘Z/실행 취소로 다시 되돌릴 수 있어요.",
  note_hard:
    "<b>hard</b> 리셋은 커밋 안 된 변경사항까지 추가로 버리는데, 이 변경사항은 스냅샷으로 전혀 보호되지 않아요.",
  // 확인 창이 열리기 전에 나오는 안내라 `-는 중이에요`를 쓰면 안 돼요 — ko/sidebar.ts의
  // `*_arm` 주석 참고. `arm_say_hash`는 영어가 명령형이라 이미 이 형태예요.
  arm_say_known: "HEAD를 {sha} 커밋으로 리셋하려고 해요 — 확인하려면 짧은 sha를 입력해주세요.",
  title_known: "HEAD를 {sha} 커밋으로 리셋",
  desc_known:
    "현재 브랜치(HEAD)를 {sha}{subject} 시점으로 옮겨요. 지금 그보다 앞서 있는 커밋들은 브랜치에서 벗어나요(git이 결국 정리하기 전까지는 복구 가능한 상태로 남아요). 아래에서 작업 상태를 얼마나 유지할지 선택해주세요.",
  confirm: "HEAD 리셋",
  arm_say_hash:
    'HEAD를 원하는 커밋으로 리셋해요 — 해시를 붙여넣고 모드를 고른 뒤, 확인하려면 "reset"이라고 입력해주세요.',
  title_hash: "HEAD를 커밋으로 리셋",
  desc_hash:
    "현재 브랜치(HEAD)를 아래에서 지정한 커밋으로 옮겨요. 전체 해시나 축약한 해시, 또는 HEAD~2·origin/main 같은 ref를 모두 받아요 — 직접 확인해보고, 커밋이 아닌 것은 거부해요.",
  commit_to_reset: "리셋할 커밋",
  hash_placeholder: "커밋 해시 또는 ref — a1b2c3d, HEAD~2, origin/main",
  enter_hash: "리셋할 커밋 해시나 ref를 입력해주세요.",
  demo_reset: "HEAD를 {label}(으)로 리셋했어요 ({mode}, demo).",
  resetting: "HEAD를 {label}(으)로 리셋하는 중…",
  reset_done: "HEAD를 {label}(으)로 리셋했어요.",
  reset_failed: "{label}(으)로 리셋하지 못했어요.",
  reset_failed_e: "리셋에 실패했어요 — {error}",
};
