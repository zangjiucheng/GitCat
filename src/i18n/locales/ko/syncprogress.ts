// 실시간 git 동기화 진행 모달(fetch/pull/push). 키는 `syncprogress.<key>`가 돼요.
export default {
  title: "동기화하는 중…",
  body: "git의 실시간 출력이에요. 원격이 크거나 WSL 저장소라면 시간이 걸릴 수 있어요. '숨기기'는 백그라운드에서 계속 실행하고, '취소'는 작업을 중단해요.",
  starting: "시작하는 중…",
  done: "완료됐어요.",
  hide: "숨기기",
  cancelling: "취소하는 중…",
  cancelled: "취소됐어요.",
  stalled: "git에서 {secs}초 넘게 진행 상황이 없어요. 멈춘 것 같아요. 취소할까요?",
};
