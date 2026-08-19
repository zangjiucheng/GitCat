// 이미지 / PDF 시각적 diff 미리보기(issue #37)의 한국어 번역. 영어가 SOURCE OF
// TRUTH이며, 여기 없는 키는 자동으로 영어로 폴백돼요.
export default {
  before: "변경 전",
  after: "변경 후",
  added: "추가됨",
  deleted: "삭제됨",
  loading: "미리보기 불러오는 중…",
  // `unavailable` / `too_large` / `browser_demo`는 미리보기 자리에 그대로 놓이는
  // 상태 문구(`.bd-mut`)라 명사형으로 두되, `browser_demo`는 영어가 완결된
  // 문장이라 해요체로 맞춰요.
  unavailable: "미리보기할 수 없음",
  too_large: "너무 커서 미리보기할 수 없음({size})",
  no_before: "이전 버전 없음",
  no_after: "현재 버전 없음",
  browser_demo: "브라우저 데모에서는 미리보기를 쓸 수 없어요.",
  // 이미지
  dimensions: "{w}×{h}",
  // PDF — pdf.js를 웹뷰에서 돌릴 수 없어 Rust 백엔드에서 래스터화해요.
  pdf_page: "{n} / {total} 페이지",
  pdf_prev: "이전 페이지",
  pdf_next: "다음 페이지",
  open_external: "외부 도구로 열기",
  download: "이 버전 다운로드",
  // 저장이 끝난 뒤 타마가 말해요.
  downloaded: "저장했어요",
  // 확대 라이트박스
  expand: "클릭해서 확대",
  zoom_title: "확대 미리보기",
  zoom_in: "확대",
  zoom_out: "축소",
  reset_zoom: "확대 초기화",
};
