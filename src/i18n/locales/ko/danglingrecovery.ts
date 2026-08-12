// 고립된 커밋 복구 문자열. 키는 `danglingrecovery.<key>`가 돼요.
export default {
  tama_alt: "궁금해하는 Tama",
  title: "고립된 커밋 — 잃어버린 커밋 복구",
  subtitle:
    "<code>git fsck</code>가 찾아내는, 더 이상 어떤 브랜치나 태그도 가리키지 않는 커밋이에요 — hard 리셋, 수정(amend), 버려진 리베이스 커밋, 삭제된 브랜치 등을 거친 뒤 가비지 컬렉션되기 전까지 남아 있어요. 이 중 대부분은 어딘가의 reflog에 흔적이 남아 있어요(특히 실수한 직후라면 Reflog도 확인해볼 만해요); 이 목록은 raw plumbing 명령으로 만든 것처럼 reflog가 전혀 기록하지 않은 커밋도 찾아내요. 하나를 복구하면 그 위치에 완전히 새로운 브랜치가 만들어져요 — 현재 브랜치와 HEAD는 절대 건드리지 않아요.",
  loading_fsck: "git fsck를 실행하는 중이에요… 저장소가 크면 시간이 걸릴 수 있어요.",
  empty: "고립된 커밋을 찾지 못했어요 — 복구할 것이 없어요.",
  recovering_hint: "{sha} 복구하는 중 · Enter로 만들기, Esc로 취소",
  create_branch: "브랜치 만들기",
  no_message: "(메시지 없음)",
  recover_as_branch: "새 브랜치로 복구…",
  truncated: "…잘림(제한)",
  err_fsck: "git fsck를 실행하지 못했어요.",
  err_fsck_reason: "git fsck를 실행하지 못했어요 — {reason}",
  recovered_demo: "{sha}을(를) {name} 브랜치로 복구했어요 (demo).",
  open_repo_first: "먼저 저장소를 열어주세요.",
  say_recovering: "{sha}을(를) {name} 브랜치로 복구하는 중…",
  recovered_as: "{name} 브랜치로 복구했어요.",
  err_could_not_recover: "{sha}을(를) 복구하지 못했어요.",
  err_recover_reason: "복구에 실패했어요 — {reason}",
};
