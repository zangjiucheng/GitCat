// Visual image/PDF diff preview (issue #37). English is the source of truth;
// zh is best-effort (see i18n.svelte.ts CONTRIBUTOR POLICY).
export default {
  before: "Before",
  after: "After",
  added: "added",
  deleted: "deleted",
  loading: "Loading preview…",
  unavailable: "Preview unavailable",
  too_large: "Too large to preview ({size})",
  no_before: "No previous version",
  no_after: "No current version",
  browser_demo: "Preview isn't available in the browser demo.",
  // Images
  dimensions: "{w}×{h}",
  // PDFs
  pdf_page: "Page {n} / {total}",
  pdf_prev: "Previous page",
  pdf_next: "Next page",
  pdf_failed: "Couldn't render the PDF preview.",
};
