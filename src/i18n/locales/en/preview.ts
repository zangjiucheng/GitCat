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
  // PDFs — inline rendering isn't available in the app's webview (pdf.js can't
  // run there), so we show the size comparison + the external-tool handoff.
  pdf_no_inline: "Inline PDF preview isn't available.",
  open_external: "Open in external tool",
};
