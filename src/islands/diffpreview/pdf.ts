// Lazy pdf.js bridge for the visual PDF diff preview (issue #37).
//
// The app is fully offline, so pdf.js and its worker are BUNDLED (no CDN):
// `?url` yields Vite's hashed, same-origin asset URL, which the app's CSP
// (`default-src 'self'`, inherited by `worker-src`) permits. The heavy pdf.js
// library itself is pulled in via a dynamic `import()` so it lands in its own
// chunk, loaded only the first time someone actually opens a PDF diff — the
// image path never pays for it.
//
// pdf.js v6 removed all `eval`/`new Function` use, so it runs under our strict
// `script-src 'self'` (no 'unsafe-eval'). The remaining CSP caveat is wasm:
// some image codecs (JBIG2 / JPEG2000) instantiate WebAssembly, which
// `script-src` without 'wasm-unsafe-eval' blocks. Such a page fails to render
// and the caller falls back to the placeholder + external-tool escape hatch —
// which is why every entry point here is wrapped in try/catch by the component.

import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";

let libPromise: Promise<typeof import("pdfjs-dist")> | null = null;

async function lib(): Promise<typeof import("pdfjs-dist")> {
  if (!libPromise) {
    libPromise = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    });
  }
  return libPromise;
}

/** A parsed PDF plus its teardown (`destroy` aborts the worker transport —
 * `PDFDocumentProxy` itself only exposes `cleanup()`, so we keep the task). */
export interface LoadedPdf {
  doc: PDFDocumentProxy;
  destroy: () => Promise<void>;
}

/** Parse `bytes` into a pdf.js document. Caller must `.destroy()` when done. */
export async function loadPdf(bytes: Uint8Array): Promise<LoadedPdf> {
  const pdfjs = await lib();
  // disableStream/disableAutoFetch: the whole blob is already in memory, so
  // there's nothing to range-fetch — this avoids pdf.js issuing `fetch`es the
  // CSP `connect-src` would block anyway.
  const task = pdfjs.getDocument({ data: bytes, disableStream: true, disableAutoFetch: true });
  const doc = await task.promise;
  return { doc, destroy: () => task.destroy() };
}

/**
 * Render page `pageNum` (1-based) of `doc` into `canvas`, fit to `maxCssW` CSS
 * px wide and sharp on HiDPI. Returns the CSS width/height actually used.
 */
export async function renderPdfPage(
  doc: PDFDocumentProxy,
  pageNum: number,
  canvas: HTMLCanvasElement,
  maxCssW: number,
): Promise<{ w: number; h: number }> {
  const page = await doc.getPage(pageNum);
  try {
    const unit = page.getViewport({ scale: 1 });
    const cssScale = Math.min(2, Math.max(0.1, maxCssW / unit.width));
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: cssScale * dpr });
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const cssW = Math.ceil(viewport.width / dpr);
    const cssH = Math.ceil(viewport.height / dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    await page.render({ canvas, viewport }).promise;
    return { w: cssW, h: cssH };
  } finally {
    page.cleanup();
  }
}
