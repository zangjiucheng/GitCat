// 저장소 요약 문자열. 키는 `reposummary.<key>`가 돼요.
export default {
  title: "저장소 요약",
  subtitle_pre: "이 화면은 ",
  subtitle_post:
    " 자체만으로 빠르게 파악할 수 있게 해줘요: 어떤 파일이 가장 자주 바뀌는지, 실제로 누가 이 저장소를 관리하고 있는지, 시간이 지나며 얼마나 활발했는지, 그리고 반복되는 문제 영역이 어디인지.",
  loading: "git log를 읽는 중이에요… 저장소가 크면 시간이 걸릴 수 있어요.",
  none: "최근 {days}일 동안 커밋이 없어요 — 아직 요약할 게 없어요.",
  churn_title: "변경 핫스팟",
  churn_sub: "변경이 가장 많은 파일, 최근 {days}일",
  churn_empty: "이 기간에는 파일 변경이 없어요.",
  contributors_title: "기여자",
  bus_factor: "버스 팩터: {n}",
  contributors_empty: "이 기간에는 기여자가 없어요.",
  monthly_title: "월별 활동",
  monthly_empty: "이 기간에는 커밋이 없어요.",
  month_tooltip: "{month}: 커밋 {n}개",
  problem_title: "문제 영역",
  problem_caveat: "정밀한 분류기가 아닌 휴리스틱",
  problem_caveat_title:
    "커밋 제목(fix/bug/hotfix/regression/revert/…)에 대한 키워드 기반 휴리스틱이에요 — 분류기가 아니에요. 실제로 오탐과 누락이 발생할 수 있어요.",
  problem_reverts: "커밋 {total}개 중 {n}개({pct}%)가 되돌리기 또는 핫픽스였어요.",
  problem_empty: "반복되는 문제 파일이 없어요.",
  truncated: "…잘림(제한) — 매우 큰 히스토리의 일부만 보여주고 있어요.",
  err_summarize: "이 저장소를 요약하지 못했어요.",
  err_summarize_e: "이 저장소를 요약하지 못했어요 — {e}",
};
