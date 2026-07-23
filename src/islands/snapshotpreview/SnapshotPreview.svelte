<script lang="ts">
  // Snapshot preview popover — view. Anchored at the click point (the
  // controller clamps it on-screen); shows the snapshot commit's subject, sha,
  // age, and file-change list. Closes on outside-click / Escape. The graph
  // selection (and the Detail panel's full diff) is driven by the controller's
  // showAt(), not here — this popover is the compact half of the "Both" preview.
  import { snapshotPreviewCtrl } from "./snapshotpreview.svelte.ts";
  import * as bridge from "../../legacy/bridge";

  let popEl: HTMLDivElement | undefined = $state();

  function onWindowPointerdown(e: PointerEvent) {
    if (snapshotPreviewCtrl.open && popEl && !popEl.contains(e.target as Node)) snapshotPreviewCtrl.close();
  }
  function onWindowKeydown(e: KeyboardEvent) {
    if (snapshotPreviewCtrl.open && e.key === "Escape") snapshotPreviewCtrl.close();
  }

  const STATUS_LABEL: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type changed" };
  function statusLetter(s: string): string {
    return (s || "M").slice(0, 1).toUpperCase();
  }

  const FILE_CAP = 8;
</script>

<svelte:window onpointerdown={onWindowPointerdown} onkeydown={onWindowKeydown} />

{#if snapshotPreviewCtrl.open && snapshotPreviewCtrl.snap}
  {@const snap = snapshotPreviewCtrl.snap}
  {@const d = snapshotPreviewCtrl.detail}
  <div
    class="snap-preview"
    bind:this={popEl}
    style="left:{snapshotPreviewCtrl.x}px;top:{snapshotPreviewCtrl.y}px"
    role="dialog"
    aria-label="Snapshot preview"
  >
    <div class="sp-head">
      <div class="sp-title" title={snap.subject}>{snap.subject || "(no message)"}</div>
      <button class="sp-close" aria-label="Close preview" onclick={() => snapshotPreviewCtrl.close()}>&#215;</button>
    </div>
    <div class="sp-meta">
      <span class="sp-sha">{(snap.sha || "").slice(0, 7) || "snapshot"}</span>
      <span class="sp-sep">&#183;</span>
      <span>{bridge.relTime(snap.ts)}</span>
      {#if !snapshotPreviewCtrl.inGraph}
        <span class="sp-sep">&#183;</span>
        <span class="sp-off" title="This snapshot's commit isn't in the current graph view (history was rewritten since it was taken) — previewed here instead.">not in this view</span>
      {/if}
    </div>

    {#if snapshotPreviewCtrl.loading}
      <div class="sp-state"><span class="spinner"></span> Loading diff&#8230;</div>
    {:else if snapshotPreviewCtrl.error}
      <div class="sp-state sp-err">{snapshotPreviewCtrl.error}</div>
    {:else if d}
      {@const shown = Math.min(d.fileTree.length, FILE_CAP)}
      {@const more = d.filesChanged - shown}
      <div class="sp-stat">
        <span class="sp-files">{d.filesChanged} {d.filesChanged === 1 ? "file" : "files"}</span>
        {#if d.additions}<span class="sp-add">+{d.additions}</span>{/if}
        {#if d.deletions}<span class="sp-del">&#8722;{d.deletions}</span>{/if}
      </div>
      {#if d.fileTree.length}
        <div class="sp-files-list">
          {#each d.fileTree.slice(0, FILE_CAP) as f (f.path)}
            <div class="sp-file">
              <span class="sp-badge sp-b-{statusLetter(f.status)}" title={STATUS_LABEL[statusLetter(f.status)] || "changed"}>{statusLetter(f.status)}</span>
              <span class="sp-path" title={f.path}>{f.path}</span>
              <span class="sp-fstat">
                {#if f.additions}<span class="sp-add">+{f.additions}</span>{/if}
                {#if f.deletions}<span class="sp-del">&#8722;{f.deletions}</span>{/if}
              </span>
            </div>
          {/each}
          {#if more > 0}
            <div class="sp-more">+{more} more file{more === 1 ? "" : "s"}&#8230;</div>
          {/if}
        </div>
      {:else}
        <div class="sp-state sp-empty">No file changes in this commit.</div>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .snap-preview {
    position: fixed;
    z-index: 320;
    width: 320px;
    max-height: 300px;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--r-control, 10px);
    box-shadow: var(--shadow, 0 12px 30px -8px rgba(0, 0, 0, 0.35));
    color: var(--text);
    font-size: 12.5px;
    overflow: hidden;
    animation: sp-in 0.12s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @keyframes sp-in {
    from {
      opacity: 0;
      transform: translateY(-4px) scale(0.985);
    }
  }
  .sp-head {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 9px 10px 6px;
  }
  .sp-title {
    flex: 1;
    font-weight: 600;
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .sp-close {
    flex: none;
    border: none;
    background: transparent;
    color: var(--muted);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    padding: 0 2px;
    border-radius: 5px;
  }
  .sp-close:hover {
    color: var(--text);
    background: var(--elevated);
  }
  .sp-meta {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
    padding: 0 10px 8px;
    color: var(--muted);
    font-size: 11.5px;
  }
  .sp-sha {
    font-family: var(--mono);
    color: var(--text);
  }
  .sp-off {
    color: var(--warning, #b9781c);
    cursor: help;
  }
  .sp-state {
    padding: 10px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .sp-err {
    color: var(--danger, #d14343);
  }
  .sp-stat {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-top: 1px solid var(--border);
    font-size: 11.5px;
  }
  .sp-files {
    color: var(--muted);
  }
  .sp-add {
    color: #3fae74;
    font-family: var(--mono);
  }
  .sp-del {
    color: #e0696d;
    font-family: var(--mono);
  }
  .sp-files-list {
    overflow-y: auto;
    padding: 2px 6px 8px;
  }
  .sp-file {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 3px 4px;
    border-radius: 6px;
  }
  .sp-file:hover {
    background: var(--elevated);
  }
  .sp-badge {
    flex: none;
    width: 15px;
    height: 15px;
    display: grid;
    place-items: center;
    border-radius: 4px;
    font-size: 9.5px;
    font-weight: 700;
    font-family: var(--mono);
    color: #fff;
    background: var(--muted);
  }
  .sp-b-A {
    background: #3fae74;
  }
  .sp-b-M {
    background: #c98a2e;
  }
  .sp-b-D {
    background: #d15a5e;
  }
  .sp-b-R,
  .sp-b-C {
    background: #4a86c9;
  }
  .sp-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .sp-fstat {
    flex: none;
    display: flex;
    gap: 5px;
    font-size: 10.5px;
  }
  .sp-more,
  .sp-empty {
    padding: 4px 6px 2px;
    color: var(--muted);
    font-size: 11px;
  }
</style>
