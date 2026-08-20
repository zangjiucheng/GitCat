// 실시간 git 동기화 진행 모달(fetch/pull/push). 키는 `syncprogress.<key>`가 돼요.
export default {
  title: "동기화하는 중…",
  body: "git의 실시간 출력이에요. 원격이 크거나 WSL 저장소라면 시간이 걸릴 수 있어요 — 창을 닫아도 계속 실행돼요.",
  starting: "시작하는 중…",
  done: "완료됐어요.",
};
