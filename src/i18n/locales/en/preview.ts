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
  // PDFs — rasterized in the Rust backend (pdf.js can't run in the webview).
  pdf_page: "Page {n} / {total}",
  pdf_prev: "Previous page",
  pdf_next: "Next page",
  open_external: "Open in external tool",
  download: "Download this version",
  downloaded: "Saved",
  // Zoom lightbox
  expand: "Click to zoom",
  zoom_title: "Zoom preview",
  zoom_in: "Zoom in",
  zoom_out: "Zoom out",
  reset_zoom: "Reset zoom",
};
