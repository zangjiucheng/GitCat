// Which kind of visual preview a binary diff file gets (issue #37). Kept in
// lockstep with the backend `mime_for_path` allow-list in
// `src-tauri/src/preview.rs` — if you add an extension here, add it there too.

export type PreviewKind = "image" | "pdf";

// Extensions the `<img>`/`data:` URI path can render directly. SVG is included:
// rendered via `<img src="data:image/svg+xml;…">`, which (unlike an inline
// <svg>) cannot execute script, so it's safe to show untrusted repo content.
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"]);

function ext(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** The preview kind for `path`, or null if it isn't an image or PDF. */
export function previewKind(path: string): PreviewKind | null {
  const e = ext(path);
  if (IMAGE_EXTS.has(e)) return "image";
  if (e === "pdf") return "pdf";
  return null;
}

/** Human-readable byte size, e.g. "834 B", "12.4 KB", "3.1 MB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
