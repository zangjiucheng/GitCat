// 병합 커밋을 체리픽할 때 쓰는 메인라인 부모 선택기. 키는 `mainlinepicker.<key>`가 돼요.
export default {
  title: "병합 커밋 체리픽",
  merge_desc:
    " 커밋은 병합 커밋이라, git이 어느 부모가 메인라인인지 알아야 해요 — 이 커밋이 가져오는 변경사항은 그 부모를 기준으로 계산되거든요.",
  role_mainline: "병합 대상 브랜치(메인라인 — 보통 이쪽)",
  role_merged_in: "병합되어 들어오는 브랜치",
  role_parent: "부모 {n}",
  tama_alt: "궁금해하는 Tama",
};
