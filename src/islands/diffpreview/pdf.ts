// Lazy pdf.js bridge for the visual PDF diff preview (issue #37).
//
// MAIN-THREAD, NO WEB WORKER. In the Tauri WKWebView a pdf.js module worker
// constructs but never completes pdf.js's internal "test" handshake, so
// `getDocument()` hangs forever with no error (a blank canvas). pdf.js has a
// built-in escape hatch: if `globalThis.pdfjsWorker.WorkerMessageHandler`
// exists, `PDFWorker.#initialize` takes the fake-worker path and runs the
// worker's message handler INLINE on the main thread, never creating a Worker.
// The worker module sets `globalThis.pdfjsWorker` unconditionally at its top
// level, so importing it here (main thread) flips pdf.js onto that path.
// Parsing + rendering one preview page on the main thread is cheap.
//
// Everything is BUNDLED (the app is offline, no CDN) and pulled in via dynamic
// `import()`, so pdf.js lands in its own lazy chunk — loaded only the first
// time someone opens a PDF diff; the image path and main bundle never pay for
// it. pdf.js v6 uses no `eval`, so it runs under our strict `script-src 'self'`.
// The one remaining CSP caveat is wasm image codecs (JBIG2/JPEG2000), which
// `script-src` without 'wasm-unsafe-eval' blocks; such a page rejects and the
// caller shows the reason + external-tool escape hatch. A load timeout turns
// any other stall into the same visible failure.

import type { PDFDocumentProxy } from "pdfjs-dist";

let libPromise: Promise<typeof import("pdfjs-dist")> | null = null;

async function lib(): Promise<typeof import("pdfjs-dist")> {
  if (!libPromise) {
    libPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      // Side-effect import: sets globalThis.pdfjsWorker -> main-thread path.
      // @ts-expect-error — the worker build ships no type declarations.
      await import("pdfjs-dist/build/pdf.worker.min.mjs");
      return pdfjs;
    })();
  }
  return libPromise;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** A parsed PDF plus its teardown (`destroy` aborts the transport —
 * `PDFDocumentProxy` itself only exposes `cleanup()`, so we keep the task). */
export interface LoadedPdf {
  doc: PDFDocumentProxy;
  destroy: () => Promise<void>;
}

/** Parse `bytes` into a pdf.js document. Caller must `.destroy()` when done. */
export async function loadPdf(bytes: Uint8Array, timeoutMs = 20000): Promise<LoadedPdf> {
  const pdfjs = await lib();
  // disableStream/disableAutoFetch: the whole blob is already in memory, so
  // there's nothing to range-fetch — this avoids pdf.js issuing `fetch`es the
  // CSP `connect-src` would block anyway.
  const task = pdfjs.getDocument({ data: bytes, disableStream: true, disableAutoFetch: true });
  const cleanup = async () => {
    try {
      await task.destroy();
    } catch {
      /* already gone */
    }
  };
  try {
    const doc = await withTimeout(task.promise, timeoutMs, "PDF load");
    return { doc, destroy: cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
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
