// Plumbing 살펴보기 화면 문자열. 키는 `plumbing.<key>`가 돼요. 원본 git 객체
// 필드 이름(tree/parents/target)은 화면에서 문자 그대로 남아 있어요 — git
// 객체 모델 자체를 가리키는 이름이라 번역 대상이 아니에요.
export default {
  tama_alt: "궁금해하는 Tama",
  title: "Plumbing — 원본 객체 살펴보기",
  subtitle: "rev, sha, branch, tag 중 하나를 입력하면 그것이 가리키는 원본 커밋, tree, blob, 태그 객체를 볼 수 있어요.",
  input_placeholder: "rev, sha, branch, tag… 예: HEAD~2, HEAD:path/to/file, a1b2c3d",
  inspect_btn: "살펴보기",
  inspecting: "살펴보는 중…",
  author: "작성자",
  committer: "커미터",
  tagger: "태거",
  no_tagger: "(기록된 태거 없음)",
  root_commit: "(루트 커밋 — 부모 커밋 없음)",
  empty_tree: "빈 tree",
  size: "크기",
  binary: "바이너리",
  yes: "예",
  no: "아니요",
  binary_not_shown: "바이너리 내용은 표시하지 않아요.",
  truncated: "(잘림)",
  empty_hint: "위에 rev, sha, branch, tag 중 하나를 입력하고 살펴보기를 누르면 그것이 가리키는 원본 커밋, tree, blob, 태그 객체를 볼 수 있어요.",
  err_enter_rev: "살펴볼 rev, sha, ref를 입력해주세요.",
  open_repo_first: "먼저 저장소를 열어주세요.",
};
