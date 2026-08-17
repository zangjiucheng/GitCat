// Lazy pdf.js bridge for the visual PDF diff preview (issue #37).
//
// The app is fully offline, so pdf.js and its worker are BUNDLED (no CDN):
// `?url` yields Vite's hashed, same-origin asset URL, which the app's CSP
// (`default-src 'self'`, inherited by `worker-src`) permits. The heavy pdf.js
// library itself is pulled in via a dynamic `import()` so it lands in its own
// chunk, loaded only the first time someone actually opens a PDF diff — the
// image path never pays for it.
//
// WORKER: we construct the Worker OURSELVES as an explicit MODULE worker
// (`{ type: "module" }`) and hand it to pdf.js via `workerPort`, instead of
// setting `GlobalWorkerOptions.workerSrc` and letting pdf.js build it. The
// bundled worker is an ES module (`pdf.worker.min.mjs`); if pdf.js constructs
// it as a *classic* worker the `import`/`export` syntax fails to parse and
// `getDocument()` hangs forever with no rejection (a blank canvas, no error).
// Owning the Worker guarantees the module type matches the file.
//
// pdf.js v6 removed all `eval`/`new Function` use, so it runs under our strict
// `script-src 'self'` (no 'unsafe-eval'). The remaining CSP caveat is wasm:
// some image codecs (JBIG2 / JPEG2000) instantiate WebAssembly, which
// `script-src` without 'wasm-unsafe-eval' blocks. Such a page rejects and the
// caller shows the reason + external-tool escape hatch. A `loadPdf` timeout
// turns any *other* hang (a worker that never initializes) into the same
// visible failure rather than a silent blank.

import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";

let libPromise: Promise<typeof import("pdfjs-dist")> | null = null;

async function lib(): Promise<typeof import("pdfjs-dist")> {
  if (!libPromise) libPromise = import("pdfjs-dist");
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

/** A parsed PDF plus its teardown (`destroy` aborts the worker transport —
 * `PDFDocumentProxy` itself only exposes `cleanup()`, so we keep the task). */
export interface LoadedPdf {
  doc: PDFDocumentProxy;
  destroy: () => Promise<void>;
}

/** Parse `bytes` into a pdf.js document. Caller must `.destroy()` when done. */
export async function loadPdf(bytes: Uint8Array, timeoutMs = 20000): Promise<LoadedPdf> {
  const pdfjs = await lib();
  // Our own module worker (see file header) + a per-document PDFWorker so the
  // two diff sides never contend on one port.
  const port = new Worker(workerUrl, { type: "module" });
  // `.create` (not `new`) — its param type carries the proper `port?: Worker`,
  // where the constructor's generated type narrows it to `null`.
  const worker = pdfjs.PDFWorker.create({ port });
  // disableStream/disableAutoFetch: the whole blob is already in memory, so
  // there's nothing to range-fetch — this avoids pdf.js issuing `fetch`es the
  // CSP `connect-src` would block anyway.
  const task = pdfjs.getDocument({ data: bytes, worker, disableStream: true, disableAutoFetch: true });
  const cleanup = async () => {
    try {
      await task.destroy();
    } catch {
      /* already gone */
    }
    try {
      worker.destroy();
    } catch {
      /* already gone */
    }
    port.terminate();
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
