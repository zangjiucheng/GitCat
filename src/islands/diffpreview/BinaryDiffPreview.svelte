<script lang="ts">
  // Visual before/after diff preview for images and PDFs (issue #37). Shared by
  // the commit-detail diff and the working-tree diff: both drop this in where
  // they used to render the "binary file — not shown" placeholder.
  //
  // Side-addressed: the caller passes the two diff sides as `rev` tokens the
  // backend `preview_blob` understands (a commit rev-spec, `:index`, or
  // `:workdir`) plus the file path (and old path for a rename). This component
  // owns ALL the fetching and rendering, so the two islands stay thin.
  import { onDestroy } from "svelte";
  import { commands, type BlobPreview } from "@/ipc/bindings";
  import { t } from "@/i18n/i18n.svelte.ts";
  import { IN_TAURI } from "@/ipc/env";
  import { previewKind, formatBytes } from "./preview-kind";
  import { loadPdf, renderPdfPage, type LoadedPdf } from "./pdf";

  type Props = {
    repo: string;
    /** New-side path (also the old path for a pure delete row). */
    path: string;
    /** Old-side path — set only for a rename/copy. */
    oldPath?: string | null;
    /** `rev` token for the "after" side (e.g. `<sha>`, `:index`, `:workdir`). */
    newRev: string;
    /** `rev` token for the "before" side (e.g. `<sha>^`, `HEAD`, `:index`). */
    oldRev: string;
  };
  let { repo, path, oldPath = null, newRev, oldRev }: Props = $props();

  type Side =
    | { st: "loading" }
    | { st: "absent" }
    | { st: "toolarge"; size: number }
    | { st: "error" }
    | { st: "ready"; mime: string; size: number; data: string };

  const kind = $derived(previewKind(path));

  let before = $state<Side>({ st: "loading" });
  let after = $state<Side>({ st: "loading" });
  let fetchToken = 0;

  async function fetchSide(rev: string, filePath: string): Promise<Side> {
    try {
      const r = await commands.previewBlob(repo, rev, filePath);
      if (r.status !== "ok") return { st: "error" };
      const p: BlobPreview | null = r.data;
      if (!p) return { st: "absent" }; // path not present on this side
      if (p.data == null) return { st: "toolarge", size: p.size }; // over the cap
      return { st: "ready", mime: p.mime, size: p.size, data: p.data };
    } catch {
      return { st: "error" };
    }
  }

  // Refetch whenever the file/sides change. A monotonic token drops results
  // from a superseded selection (the diff panel reuses this instance across
  // files). Browser demo mode has no backend, so it degrades to a note.
  $effect(() => {
    const r = repo,
      np = path,
      op = oldPath,
      nr = newRev,
      or = oldRev;
    void r;
    const my = ++fetchToken;
    before = { st: "loading" };
    after = { st: "loading" };
    beforeDim = null;
    afterDim = null;
    if (!IN_TAURI) {
      before = { st: "error" };
      after = { st: "error" };
      return;
    }
    void fetchSide(or, op ?? np).then((s) => {
      if (my === fetchToken) before = s;
    });
    void fetchSide(nr, np).then((s) => {
      if (my === fetchToken) after = s;
    });
  });

  function dataUri(s: Extract<Side, { st: "ready" }>): string {
    return `data:${s.mime};base64,${s.data}`;
  }

  // ── images: intrinsic dimensions read off the loaded <img> ──
  let beforeDim = $state<{ w: number; h: number } | null>(null);
  let afterDim = $state<{ w: number; h: number } | null>(null);
  function onImgLoad(which: "before" | "after", e: Event) {
    const img = e.currentTarget as HTMLImageElement;
    const d = { w: img.naturalWidth, h: img.naturalHeight };
    if (which === "before") beforeDim = d;
    else afterDim = d;
  }

  // ── PDFs: lazy pdf.js, page-1 default with shared prev/next nav ──
  function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  let beforeDoc = $state<LoadedPdf | null>(null);
  let afterDoc = $state<LoadedPdf | null>(null);
  let beforePages = $state(0);
  let afterPages = $state(0);
  let pageNum = $state(1);
  let pdfError = $state(false);
  let pdfToken = 0;
  let beforeCanvas = $state<HTMLCanvasElement>();
  let afterCanvas = $state<HTMLCanvasElement>();

  const totalPages = $derived(Math.max(beforePages, afterPages));

  function destroyDocs() {
    void beforeDoc?.destroy();
    void afterDoc?.destroy();
    beforeDoc = null;
    afterDoc = null;
    beforePages = 0;
    afterPages = 0;
  }

  // Parse each ready side into a pdf.js document. Any failure (including a CSP
  // wasm block on an exotic codec) flips to the graceful fallback note.
  $effect(() => {
    if (kind !== "pdf") return;
    const b = before,
      a = after;
    const my = ++pdfToken;
    pdfError = false;
    pageNum = 1;
    destroyDocs();
    void (async () => {
      try {
        if (b.st === "ready") {
          const doc = await loadPdf(b64ToBytes(b.data));
          if (my !== pdfToken) return void doc.destroy();
          beforeDoc = doc;
          beforePages = doc.doc.numPages;
        }
        if (a.st === "ready") {
          const doc = await loadPdf(b64ToBytes(a.data));
          if (my !== pdfToken) return void doc.destroy();
          afterDoc = doc;
          afterPages = doc.doc.numPages;
        }
      } catch {
        if (my === pdfToken) pdfError = true;
      }
    })();
  });

  // Render the current page into each side's canvas.
  $effect(() => {
    if (kind !== "pdf") return;
    const p = pageNum;
    const bd = beforeDoc,
      ad = afterDoc;
    const bc = beforeCanvas,
      ac = afterCanvas;
    void (async () => {
      try {
        if (bd && bc && p <= beforePages) await renderPdfPage(bd.doc, p, bc, 360);
        if (ad && ac && p <= afterPages) await renderPdfPage(ad.doc, p, ac, 360);
      } catch {
        pdfError = true;
      }
    })();
  });

  onDestroy(() => {
    pdfToken++;
    destroyDocs();
  });

  function prevPage() {
    if (pageNum > 1) pageNum--;
  }
  function nextPage() {
    if (pageNum < totalPages) pageNum++;
  }
</script>

{#snippet sidePanel(which: "before" | "after", label: string, side: Side, dim: { w: number; h: number } | null)}
  <div class="bd-panel">
    <div class="bd-cap">
      <span class="bd-lab">{label}</span>
      {#if side.st === "ready"}
        <span class="bd-meta">
          {#if kind === "image" && dim}{t("preview.dimensions", { w: dim.w, h: dim.h })} · {/if}{formatBytes(side.size)}
        </span>
      {/if}
    </div>
    <div class="bd-body">
      {#if side.st === "loading"}
        <span class="bd-mut">{t("preview.loading")}</span>
      {:else if side.st === "absent"}
        <span class="bd-badge">{which === "before" ? t("preview.no_before") : t("preview.no_after")}</span>
      {:else if side.st === "toolarge"}
        <span class="bd-mut">{t("preview.too_large", { size: formatBytes(side.size) })}</span>
      {:else if side.st === "error"}
        <span class="bd-mut">{IN_TAURI ? t("preview.unavailable") : t("preview.browser_demo")}</span>
      {:else if kind === "image"}
        <img class="bd-img" src={dataUri(side)} alt={label} onload={(e) => onImgLoad(which, e)} />
      {:else if kind === "pdf"}
        {#if which === "before"}
          <canvas class="bd-canvas" bind:this={beforeCanvas}></canvas>
        {:else}
          <canvas class="bd-canvas" bind:this={afterCanvas}></canvas>
        {/if}
      {/if}
    </div>
  </div>
{/snippet}

<div class="bdiff">
  {#if kind === "pdf" && pdfError}
    <div class="bd-fail">{t("preview.pdf_failed")}</div>
  {:else}
    {#if kind === "pdf" && totalPages > 0}
      <div class="bd-nav">
        <button class="bd-navbtn" onclick={prevPage} disabled={pageNum <= 1} aria-label={t("preview.pdf_prev")}>‹</button>
        <span class="bd-navlab">{t("preview.pdf_page", { n: pageNum, total: totalPages })}</span>
        <button class="bd-navbtn" onclick={nextPage} disabled={pageNum >= totalPages} aria-label={t("preview.pdf_next")}>›</button>
      </div>
    {/if}
    <div class="bd-sides">
      {@render sidePanel("before", t("preview.before"), before, beforeDim)}
      {@render sidePanel("after", t("preview.after"), after, afterDim)}
    </div>
  {/if}
</div>

<style>
  .bdiff {
    padding: 10px;
    font: 12px/1.4 var(--ui);
    color: var(--text);
  }
  .bd-sides {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: flex-start;
  }
  .bd-panel {
    flex: 1 1 240px;
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: var(--r-card, 8px);
    background: var(--panel);
    overflow: hidden;
  }
  .bd-cap {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--elevated, var(--panel));
  }
  .bd-lab {
    font-weight: 600;
  }
  .bd-meta {
    color: var(--muted);
    font: 11px/1 var(--mono, monospace);
    white-space: nowrap;
  }
  .bd-body {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 64px;
    padding: 10px;
    /* Checkerboard so transparent PNGs/icons read clearly against any theme. */
    background-color: var(--bg);
    background-image:
      linear-gradient(45deg, var(--border) 25%, transparent 25%),
      linear-gradient(-45deg, var(--border) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, var(--border) 75%),
      linear-gradient(-45deg, transparent 75%, var(--border) 75%);
    background-size: 16px 16px;
    background-position:
      0 0,
      0 8px,
      8px -8px,
      -8px 0;
  }
  .bd-img,
  .bd-canvas {
    max-width: 100%;
    height: auto;
    display: block;
    box-shadow: var(--shadow, 0 1px 4px rgba(0, 0, 0, 0.25));
  }
  .bd-mut,
  .bd-badge {
    color: var(--muted);
    font-size: 11px;
    text-align: center;
  }
  .bd-badge {
    padding: 2px 8px;
    border: 1px dashed var(--border);
    border-radius: var(--r-pill, 999px);
  }
  .bd-nav {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .bd-navbtn {
    width: 24px;
    height: 24px;
    line-height: 1;
    font-size: 15px;
    border: 1px solid var(--border);
    border-radius: var(--r-control, 6px);
    background: var(--panel);
    color: var(--text);
    cursor: pointer;
  }
  .bd-navbtn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .bd-navlab {
    color: var(--muted);
    font: 11px/1 var(--mono, monospace);
    min-width: 96px;
    text-align: center;
  }
  .bd-fail {
    padding: 12px;
    color: var(--muted);
    text-align: center;
  }
</style>
