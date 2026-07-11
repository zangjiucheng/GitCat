<script lang="ts">
  // .gitignore / .mailmap in-app editors (backlog #14, the FINAL backlog
  // item) — view. Deliberately no bespoke <style> block for the shared
  // chrome: reuses `.scrim`/`.modal`/`.modal-head`/`.modal-body`/
  // `.modal-foot`/`.btn`/`.btn.ghost`/`.spinner`/`.mut`/`.mono` verbatim (same
  // shared chrome every other on-demand modal in this app reuses). The mono
  // textarea mirrors FilterRepo.svelte's own scope-textarea exactly (`rows`,
  // `font-family:var(--mono)`, `spellcheck="false"`) — this is editing exact
  // file bytes verbatim, not writing prose, so it gets that shape rather than
  // Workdir's prose-sized commit-message box. Only the small `.rf-tabs`/
  // `.rf-tab` toggle is new (see index.html's own doc comment on it).
  import { repoFilesCtrl, type RepoFileName } from "./repofiles.svelte.ts";

  const FILES: RepoFileName[] = [".gitignore", ".mailmap"];

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape" || !repoFilesCtrl.open) return;
    repoFilesCtrl.close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={repoFilesCtrl.open}>
  <div class="modal repofiles">
    <div class="modal-head">
      <div>
        <h3>Repo Files &#8212; .gitignore / .mailmap</h3>
        <p>Edit these repo-root text files directly, no external editor needed.</p>
      </div>
    </div>
    <div class="modal-body">
      <div class="rf-tabs" role="tablist">
        {#each FILES as f}
          <button
            class="rf-tab mono"
            class:sel={repoFilesCtrl.file === f}
            role="tab"
            aria-selected={repoFilesCtrl.file === f}
            disabled={repoFilesCtrl.busy}
            onclick={() => repoFilesCtrl.selectFile(f)}
          >
            {f}
          </button>
        {/each}
      </div>

      {#if repoFilesCtrl.loading}
        <div class="log-row"><span class="spinner"></span><span class="msg mut">Loading {repoFilesCtrl.file}&#8230;</span></div>
      {:else if repoFilesCtrl.error}
        <div class="pl-err">{repoFilesCtrl.error}</div>
      {:else}
        <textarea
          class="rf-textarea"
          rows="18"
          style="width:100%;font-family:var(--mono)"
          spellcheck="false"
          disabled={repoFilesCtrl.busy}
          bind:value={repoFilesCtrl.content}
        ></textarea>
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" disabled={repoFilesCtrl.busy} onclick={() => repoFilesCtrl.close()}>Close</button>
      <button
        class="btn"
        disabled={repoFilesCtrl.busy || repoFilesCtrl.loading || !!repoFilesCtrl.error}
        onclick={() => repoFilesCtrl.save()}
      >
        {#if repoFilesCtrl.busy}<span class="spinner"></span> Saving&#8230;{:else}Save {repoFilesCtrl.file}{/if}
      </button>
    </div>
  </div>
</div>
