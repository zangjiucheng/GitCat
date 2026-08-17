<script lang="ts">
  // Visual before/after diff preview for images and PDFs (issue #37). Shared by
  // the commit-detail diff and the working-tree diff: both drop this in where
  // they used to render the "binary file — not shown" placeholder.
  //
  // Side-addressed: the caller passes the two diff sides as `rev` tokens the
  // backend `preview_blob` understands (a commit rev-spec, `:index`, or
  // `:workdir`) plus the file path (and old path for a rename). This component
  // owns ALL the fetching and rendering, so the two islands stay thin.
  //
  // IMAGES render inline via `data:` URIs (CSP already allows `img-src data:`).
  // PDFs do NOT render inline: pdf.js is unusable in the Tauri WKWebView (a Web
  // Worker never completes its handshake -> getDocument hangs; on the main
  // thread it freezes the UI, doubly so under the dev webview's software
  // rasterizer). So a PDF shows its before/after size comparison plus the
  // external-tool escape hatch — informative and, crucially, non-blocking.
  import { commands, type BlobPreview } from "@/ipc/bindings";
  import { t } from "@/i18n/i18n.svelte.ts";
  import { IN_TAURI } from "@/ipc/env";
  import { externalToolsCtrl } from "../externaltools/externaltools.svelte.ts";
  import { previewKind, formatBytes } from "./preview-kind";
  import FileText from "@lucide/svelte/icons/file-text";
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
    /** For the external-diff button (mirrors each island's own openDiff call):
     * commit-detail passes staged=false + fromRev/toRev; the working tree passes
     * its staged flag and no revs (its own index/workdir diff). */
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

  // For PDFs we only need the byte size, not the payload — fetch it cheaply and
  // skip base64 by asking for the size via a HEAD-ish call. `preview_blob`
  // always returns the bytes, so just read `.size` and drop `.data`.
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

  function openExternal() {
    if (!IN_TAURI) return;
    // Mirrors each island's own openDiff call: commit-detail passes fromRev/
    // toRev (staged=false); the working tree passes its staged flag, no revs.
    void externalToolsCtrl.openDiff(repo, path, externalStaged, externalFromRev, externalToRev);
  }
</script>

{#snippet imageSide(which: "before" | "after", label: string, side: Side, dim: { w: number; h: number } | null)}
  <div class="bd-panel">
    <div class="bd-cap">
      <span class="bd-lab">{label}</span>
      {#if side.st === "ready"}
        <span class="bd-meta">
          {#if dim}{t("preview.dimensions", { w: dim.w, h: dim.h })} · {/if}{formatBytes(side.size)}
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
      {:else}
        <img class="bd-img" src={dataUri(side)} alt={label} onload={(e) => onImgLoad(which, e)} />
      {/if}
    </div>
  </div>
{/snippet}

{#snippet pdfSide(which: "before" | "after", label: string, side: Side)}
  <div class="bd-panel">
    <div class="bd-cap">
      <span class="bd-lab">{label}</span>
      {#if side.st === "ready"}<span class="bd-meta">{formatBytes(side.size)}</span>{/if}
    </div>
    <div class="bd-body bd-body-pdf">
      {#if side.st === "loading"}
        <span class="bd-mut">{t("preview.loading")}</span>
      {:else if side.st === "absent"}
        <span class="bd-badge">{which === "before" ? t("preview.no_before") : t("preview.no_after")}</span>
      {:else if side.st === "error"}
        <span class="bd-mut">{IN_TAURI ? t("preview.unavailable") : t("preview.browser_demo")}</span>
      {:else}
        <FileText class="bd-doc-ico" size={30} aria-hidden="true" />
        <span class="bd-meta">{side.st === "toolarge" ? formatBytes(side.size) : formatBytes((side as Extract<Side, { st: "ready" }>).size)}</span>
      {/if}
    </div>
  </div>
{/snippet}

<div class="bdiff">
  <div class="bd-sides">
    {#if kind === "pdf"}
      {@render pdfSide("before", t("preview.before"), before)}
      {@render pdfSide("after", t("preview.after"), after)}
    {:else}
      {@render imageSide("before", t("preview.before"), before, beforeDim)}
      {@render imageSide("after", t("preview.after"), after, afterDim)}
    {/if}
  </div>
  {#if kind === "pdf"}
    <div class="bd-pdfnote">
      <span>{t("preview.pdf_no_inline")}</span>
      {#if IN_TAURI}
        <button class="bd-extbtn" onclick={openExternal}>
          <ExternalLink size={12} aria-hidden="true" />
          {t("preview.open_external")}
        </button>
      {/if}
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
  .bd-body-pdf {
    flex-direction: column;
    gap: 8px;
    background-image: none;
    color: var(--muted);
  }
  :global(.bd-doc-ico) {
    color: var(--muted);
    opacity: 0.8;
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
  .bd-pdfnote {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 10px;
    color: var(--muted);
    font-size: 11px;
    text-align: center;
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
