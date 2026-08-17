<script lang="ts">
  // Pop-out zoom viewer for an image/PDF diff side (issue #37). Full-viewport
  // overlay: scroll-wheel zoom (anchored at the cursor), drag to pan, and a
  // before⇄after toggle that KEEPS the current zoom/pan so you can zoom into a
  // region and flip sides to compare exactly that spot. PDFs re-render at a
  // higher resolution here than the inline panel so magnifying stays crisp.
  import { untrack } from "svelte";
  import { commands } from "@/ipc/bindings";
  import { t } from "@/i18n/i18n.svelte.ts";
  import X from "@lucide/svelte/icons/x";
  import ZoomIn from "@lucide/svelte/icons/zoom-in";
  import ZoomOut from "@lucide/svelte/icons/zoom-out";
  import Maximize from "@lucide/svelte/icons/maximize";

  type Props = {
    onClose: () => void;
    kind: "image" | "pdf";
    side: "before" | "after";
    hasBefore: boolean;
    hasAfter: boolean;
    // image kind: full-res data URIs the parent already fetched.
    beforeUri?: string | null;
    afterUri?: string | null;
    // pdf kind: re-rendered here at high resolution.
    repo: string;
    oldRev: string;
    newRev: string;
    path: string;
    oldPath?: string | null;
    page?: number;
    totalPages?: number;
  };
  let {
    onClose,
    kind,
    side,
    hasBefore,
    hasAfter,
    beforeUri = null,
    afterUri = null,
    repo,
    oldRev,
    newRev,
    path,
    oldPath = null,
    page = 1,
    totalPages = 1,
  }: Props = $props();

  // Device-px width the lightbox asks the backend to rasterize a PDF page at —
  // generous so it stays sharp when magnified.
  const PDF_HIRES = 2480;

  // Seeded once from the props (the lightbox remounts fresh each open);
  // `untrack` captures the initial value without a reactive dependency.
  let curSide = $state<"before" | "after">(untrack(() => side));
  let curPage = $state(untrack(() => page));
  let uri = $state<string | null>(null);
  let loading = $state(false);
  let err = $state("");
  let token = 0;

  // zoom/pan (kept across side/page changes on purpose)
  let scale = $state(1);
  let ox = $state(0);
  let oy = $state(0);
  let bodyEl = $state<HTMLDivElement>();

  const sideRev = $derived(curSide === "before" ? oldRev : newRev);
  const sideFile = $derived(curSide === "before" ? (oldPath ?? path) : path);

  $effect(() => {
    const k = kind,
      s = curSide,
      pg = curPage;
    const my = ++token;
    err = "";
    if (k === "image") {
      uri = s === "before" ? beforeUri : afterUri;
      return;
    }
    // pdf: high-res render for this side/page
    loading = true;
    void commands
      .renderPdfPage(repo, sideRev, sideFile, pg, PDF_HIRES)
      .then((r) => {
        if (my !== token) return;
        loading = false;
        if (r.status !== "ok") {
          err = r.error;
          uri = null;
        } else if (!r.data) {
          uri = null;
        } else {
          uri = `data:image/png;base64,${r.data.data}`;
        }
      })
      .catch((e) => {
        if (my !== token) return;
        loading = false;
        err = String(e);
        uri = null;
      });
  });

  function clamp(v: number, lo: number, hi: number) {
    return Math.min(hi, Math.max(lo, v));
  }
  function resetView() {
    scale = 1;
    ox = 0;
    oy = 0;
  }
  function zoomBy(factor: number, cx = 0, cy = 0) {
    const ns = clamp(scale * factor, 1, 12);
    if (ns === 1) {
      resetView();
      return;
    }
    ox = cx - (cx - ox) * (ns / scale);
    oy = cy - (cy - oy) * (ns / scale);
    scale = ns;
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = bodyEl?.getBoundingClientRect();
    const cx = rect ? e.clientX - rect.left - rect.width / 2 : 0;
    const cy = rect ? e.clientY - rect.top - rect.height / 2 : 0;
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, cx, cy);
  }

  // drag-to-pan
  let drag: { x: number; y: number; ox: number; oy: number } | null = null;
  function onPointerDown(e: PointerEvent) {
    if (scale <= 1) return;
    drag = { x: e.clientX, y: e.clientY, ox, oy };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) {
    if (!drag) return;
    ox = drag.ox + (e.clientX - drag.x);
    oy = drag.oy + (e.clientY - drag.y);
  }
  function onPointerUp(e: PointerEvent) {
    drag = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }

  function setSide(s: "before" | "after") {
    curSide = s; // keep zoom/pan — the whole point of the compare toggle
  }
  function prevPage() {
    if (curPage > 1) curPage--;
  }
  function nextPage() {
    if (curPage < totalPages) curPage++;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
    else if (e.key === "+" || e.key === "=") zoomBy(1.2);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.2);
    else if (e.key === "0") resetView();
    else if (kind === "pdf" && (e.key === "PageDown" || e.key === "]")) nextPage();
    else if (kind === "pdf" && (e.key === "PageUp" || e.key === "[")) prevPage();
    else if ((hasBefore && hasAfter) && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      setSide(curSide === "before" ? "after" : "before");
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="lb-scrim" role="dialog" aria-modal="true" tabindex="-1" aria-label={t("preview.zoom_title")} onclick={onClose}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="lb-panel" onclick={(e) => e.stopPropagation()}>
    <div class="lb-head">
      <div class="lb-head-l">
        {#if hasBefore && hasAfter}
          <div class="lb-seg">
            <button class="lb-segbtn" class:on={curSide === "before"} onclick={() => setSide("before")}>{t("preview.before")}</button>
            <button class="lb-segbtn" class:on={curSide === "after"} onclick={() => setSide("after")}>{t("preview.after")}</button>
          </div>
        {:else}
          <span class="lb-lab">{curSide === "before" ? t("preview.before") : t("preview.after")}</span>
        {/if}
        <span class="lb-name">{path}</span>
      </div>
      <div class="lb-head-r">
        {#if kind === "pdf" && totalPages > 1}
          <button class="lb-btn" onclick={prevPage} disabled={curPage <= 1} aria-label={t("preview.pdf_prev")}>‹</button>
          <span class="lb-page">{t("preview.pdf_page", { n: curPage, total: totalPages })}</span>
          <button class="lb-btn" onclick={nextPage} disabled={curPage >= totalPages} aria-label={t("preview.pdf_next")}>›</button>
          <span class="lb-div"></span>
        {/if}
        <button class="lb-btn" onclick={() => zoomBy(1 / 1.2)} aria-label={t("preview.zoom_out")}><ZoomOut size={15} /></button>
        <span class="lb-zoom">{Math.round(scale * 100)}%</span>
        <button class="lb-btn" onclick={() => zoomBy(1.2)} aria-label={t("preview.zoom_in")}><ZoomIn size={15} /></button>
        <button class="lb-btn" onclick={resetView} aria-label={t("preview.reset_zoom")}><Maximize size={15} /></button>
        <span class="lb-div"></span>
        <button class="lb-btn" onclick={onClose} aria-label={t("common.close")}><X size={16} /></button>
      </div>
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="lb-body"
      class:grabbing={scale > 1}
      bind:this={bodyEl}
      onwheel={onWheel}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      ondblclick={() => (scale > 1 ? resetView() : zoomBy(2.5))}
    >
      {#if loading}
        <span class="lb-mut">{t("preview.loading")}</span>
      {:else if err}
        <span class="lb-mut">{t("preview.unavailable")}</span>
      {:else if uri}
        <img
          class="lb-img"
          src={uri}
          alt={path}
          draggable="false"
          style="transform: translate({ox}px, {oy}px) scale({scale});"
        />
      {/if}
    </div>
  </div>
</div>

<style>
  .lb-scrim {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: rgba(0, 0, 0, 0.72);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .lb-panel {
    display: flex;
    flex-direction: column;
    width: min(1400px, 96vw);
    height: min(96vh, 100%);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--r-panel, 12px);
    overflow: hidden;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }
  .lb-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--elevated, var(--panel));
    font: 12px/1.3 var(--ui);
    color: var(--text);
  }
  .lb-head-l,
  .lb-head-r {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .lb-name {
    color: var(--muted);
    font: 11px/1 var(--mono, monospace);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .lb-lab {
    font-weight: 600;
  }
  .lb-seg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: var(--r-control, 6px);
    overflow: hidden;
  }
  .lb-segbtn {
    padding: 3px 10px;
    background: var(--panel);
    color: var(--muted);
    border: 0;
    cursor: pointer;
    font: 11px/1.2 var(--ui);
  }
  .lb-segbtn.on {
    background: var(--accent, #6b8afd);
    color: #fff;
  }
  .lb-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: 1px solid var(--border);
    border-radius: var(--r-control, 6px);
    background: var(--panel);
    color: var(--text);
    cursor: pointer;
  }
  .lb-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .lb-zoom,
  .lb-page {
    color: var(--muted);
    font: 11px/1 var(--mono, monospace);
    min-width: 42px;
    text-align: center;
  }
  .lb-div {
    width: 1px;
    height: 18px;
    background: var(--border);
  }
  .lb-body {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: var(--bg);
    cursor: zoom-in;
    touch-action: none;
  }
  .lb-body.grabbing {
    cursor: grab;
  }
  .lb-img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    user-select: none;
    will-change: transform;
  }
  .lb-mut {
    color: var(--muted);
    font-size: 12px;
  }
</style>
