<script lang="ts">
  // Visual before/after diff preview for images and PDFs (issue #37). Shared by
  // the commit-detail diff and the working-tree diff: both drop this in where
  // they used to render the "binary file — not shown" placeholder.
  //
  // Side-addressed: the caller passes the two diff sides as `rev` tokens the
  // backend understands (a commit rev-spec, `:index`, or `:workdir`) plus the
  // file path (and old path for a rename). This component owns ALL the fetching
  // and rendering, so the two islands stay thin.
  //
  // IMAGES: fetched as bytes (`preview_blob`) and shown via a `data:` URI.
  // PDFs: rasterized in the RUST BACKEND (`render_pdf_page`, PDFium off the UI
  // thread) to a PNG that's shown the same way — pdf.js can't run in the Tauri
  // WKWebView. Both paths end at an <img>; a PDF adds page navigation.
  import { commands, type BlobPreview } from "@/ipc/bindings";
  import { t } from "@/i18n/i18n.svelte.ts";
  import { IN_TAURI } from "@/ipc/env";
  import { externalToolsCtrl } from "../externaltools/externaltools.svelte.ts";
  import { previewKind, formatBytes } from "./preview-kind";
  import PreviewLightbox from "./PreviewLightbox.svelte";
  import ExternalLink from "@lucide/svelte/icons/external-link";

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
    /** External-diff fallback (mirrors each island's own openDiff call). */
    externalStaged?: boolean;
    externalFromRev?: string | null;
    externalToRev?: string | null;
  };
  let {
    repo,
    path,
    oldPath = null,
    newRev,
    oldRev,
    externalStaged = false,
    externalFromRev = null,
    externalToRev = null,
  }: Props = $props();

  type Side =
    | { st: "loading" }
    | { st: "absent" }
    | { st: "toolarge"; size: number }
    | { st: "error"; msg: string }
    | { st: "image"; uri: string; size: number; dim?: { w: number; h: number } }
    | { st: "pdf"; uri: string; pageCount: number; dim: { w: number; h: number } };

  const kind = $derived(previewKind(path));

  let before = $state<Side>({ st: "loading" });
  let after = $state<Side>({ st: "loading" });
  let pageNum = $state(1);
  let fetchToken = 0;

  const totalPages = $derived(
    Math.max(before.st === "pdf" ? before.pageCount : 0, after.st === "pdf" ? after.pageCount : 0),
  );

  async function fetchImage(rev: string, file: string): Promise<Side> {
    try {
      const r = await commands.previewBlob(repo, rev, file);
      if (r.status !== "ok") return { st: "error", msg: r.error };
      const p: BlobPreview | null = r.data;
      if (!p) return { st: "absent" };
      if (p.data == null) return { st: "toolarge", size: p.size };
      return { st: "image", uri: `data:${p.mime};base64,${p.data}`, size: p.size };
    } catch (e) {
      return { st: "error", msg: String(e) };
    }
  }

  // Inline panels are small, so ~1240px keeps the payload modest; the zoom
  // lightbox re-renders at higher resolution on its own.
  const PDF_INLINE_WIDTH = 1240;

  async function fetchPdf(rev: string, file: string, page: number): Promise<Side> {
    try {
      const r = await commands.renderPdfPage(repo, rev, file, page, PDF_INLINE_WIDTH);
      if (r.status !== "ok") return { st: "error", msg: r.error };
      const p = r.data;
      if (!p) return { st: "absent" };
      return {
        st: "pdf",
        uri: `data:image/png;base64,${p.data}`,
        pageCount: p.pageCount,
        dim: { w: p.width, h: p.height },
      };
    } catch (e) {
      return { st: "error", msg: String(e) };
    }
  }

  // Refetch whenever the file/sides/page change. A monotonic token drops results
  // from a superseded selection. Browser demo mode has no backend.
  $effect(() => {
    const r = repo,
      np = path,
      op = oldPath,
      nr = newRev,
      or = oldRev,
      k = kind,
      pg = pageNum;
    void r;
    const my = ++fetchToken;
    before = { st: "loading" };
    after = { st: "loading" };
    if (!IN_TAURI) {
      before = { st: "error", msg: "" };
      after = { st: "error", msg: "" };
      return;
    }
    const oldFile = op ?? np;
    const load = k === "pdf" ? (rev: string, f: string) => fetchPdf(rev, f, pg) : fetchImage;
    void load(or, oldFile).then((s) => {
      if (my === fetchToken) before = s;
    });
    void load(nr, np).then((s) => {
      if (my === fetchToken) after = s;
    });
  });

  // Images report their intrinsic size via the loaded <img>; PDFs already carry
  // pixel dims from the backend.
  function onImgLoad(which: "before" | "after", e: Event) {
    const img = e.currentTarget as HTMLImageElement;
    const dim = { w: img.naturalWidth, h: img.naturalHeight };
    const patch = (s: Side): Side => (s.st === "image" ? { ...s, dim } : s);
    if (which === "before") before = patch(before);
    else after = patch(after);
  }

  function metaOf(s: Side): string {
    if (s.st === "image") {
      const d = s.dim ? t("preview.dimensions", { w: s.dim.w, h: s.dim.h }) + " · " : "";
      return d + formatBytes(s.size);
    }
    return "";
  }

  function openExternal() {
    if (!IN_TAURI) return;
    void externalToolsCtrl.openDiff(repo, path, externalStaged, externalFromRev, externalToRev);
  }

  // ── zoom lightbox ──
  let zoomOpen = $state(false);
  let zoomSide = $state<"before" | "after">("after");
  function displayable(s: Side): boolean {
    return s.st === "image" || s.st === "pdf";
  }
  function openZoom(which: "before" | "after") {
    if (!displayable(which === "before" ? before : after)) return;
    zoomSide = which;
    zoomOpen = true;
  }

  function prevPage() {
    if (pageNum > 1) pageNum--;
  }
  function nextPage() {
    if (pageNum < totalPages) pageNum++;
  }
</script>

{#snippet sidePanel(which: "before" | "after", label: string, side: Side)}
  <div class="bd-panel">
    <div class="bd-cap">
      <span class="bd-lab">{label}</span>
      {#if metaOf(side)}<span class="bd-meta">{metaOf(side)}</span>{/if}
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
      {:else}
        <button class="bd-imgbtn" onclick={() => openZoom(which)} title={t("preview.expand")} aria-label={t("preview.expand")}>
          <img class="bd-img" src={side.uri} alt={label} onload={(e) => onImgLoad(which, e)} />
        </button>
      {/if}
    </div>
  </div>
{/snippet}

<div class="bdiff">
  {#if kind === "pdf" && totalPages > 1}
    <div class="bd-nav">
      <button class="bd-navbtn" onclick={prevPage} disabled={pageNum <= 1} aria-label={t("preview.pdf_prev")}>‹</button>
      <span class="bd-navlab">{t("preview.pdf_page", { n: pageNum, total: totalPages })}</span>
      <button class="bd-navbtn" onclick={nextPage} disabled={pageNum >= totalPages} aria-label={t("preview.pdf_next")}>›</button>
    </div>
  {/if}
  <div class="bd-sides">
    {@render sidePanel("before", t("preview.before"), before)}
    {@render sidePanel("after", t("preview.after"), after)}
  </div>
  {#if kind === "pdf" && IN_TAURI}
    <div class="bd-pdfnote">
      <button class="bd-extbtn" onclick={openExternal}>
        <ExternalLink size={12} aria-hidden="true" />
        {t("preview.open_external")}
      </button>
    </div>
  {/if}
</div>

{#if zoomOpen && kind}
  <PreviewLightbox
    onClose={() => (zoomOpen = false)}
    {kind}
    side={zoomSide}
    hasBefore={displayable(before)}
    hasAfter={displayable(after)}
    beforeUri={before.st === "image" ? before.uri : null}
    afterUri={after.st === "image" ? after.uri : null}
    {repo}
    {oldRev}
    {newRev}
    {path}
    {oldPath}
    page={pageNum}
    {totalPages}
  />
{/if}

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
  .bd-imgbtn {
    display: block;
    max-width: 100%;
    padding: 0;
    border: 0;
    background: none;
    cursor: zoom-in;
    line-height: 0;
  }
  .bd-img {
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
  .bd-pdfnote {
    display: flex;
    justify-content: center;
    margin-top: 10px;
  }
  .bd-extbtn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 9px;
    border: 1px solid var(--border);
    border-radius: var(--r-control, 6px);
    background: var(--panel);
    color: var(--text);
    cursor: pointer;
    font-size: 11px;
  }
  .bd-extbtn:hover {
    background: var(--elevated, var(--panel));
  }
</style>
