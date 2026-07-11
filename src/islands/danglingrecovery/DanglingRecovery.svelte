<script lang="ts">
  // fsck-based dangling-object recovery (backlog #13) — view. Deliberately no
  // bespoke <style> block for the shared chrome: reuses `.scrim`/`.modal`/
  // `.modal-head`/`.modal-body`/`.modal-foot`/`.btn`/`.btn.ghost`/`.log-row`/
  // `.rm-form`/`.nb-row`/`.mono`/`.mut`/`.spinner` verbatim (same shared
  // chrome Remotes/Reflog/ExternalTools reuse — see index.html's own doc
  // comment on the MODALS section) — only the list-row layout itself
  // (`.dr-*`) is new, and even that is index.html's documented per-owning-
  // island near-identical copy of `.fh-row`/`.rm-item`'s own shape (see
  // index.html's FILE HISTORY block doc comment for that convention).
  import { danglingRecoveryCtrl } from "./danglingrecovery.svelte.ts";
  import * as bridge from "../../legacy/bridge";

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape" || !danglingRecoveryCtrl.open) return;
    if (danglingRecoveryCtrl.recoveringSha) {
      e.stopPropagation(); // don't also close the whole modal
      danglingRecoveryCtrl.cancelRecover();
    } else {
      danglingRecoveryCtrl.close();
    }
  }

  function onNameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") void danglingRecoveryCtrl.confirmRecover();
    if (e.key === "Escape") {
      e.stopPropagation();
      danglingRecoveryCtrl.cancelRecover();
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={danglingRecoveryCtrl.open}>
  <div class="modal danglingrecovery">
    <div class="modal-head">
      <div class="modal-tama"><img class="tama-pic" src={danglingRecoveryCtrl.tamaImg} alt="Tama, curious" /></div>
      <div>
        <h3>Dangling Commits &#8212; recover a lost commit</h3>
        <p>
          Commits <code>git fsck</code> finds with no branch or tag pointing at them anymore &#8212; after a hard reset, an amend, a
          dropped rebase commit, a deleted branch, &#8230; &#8212; until garbage collected. Most of these still have a trace in some
          reflog (often worth checking Reflog Rescue too, especially right after a mistake); this list also catches commits a reflog
          never recorded at all, like ones made with raw plumbing commands. Recovering one creates a brand-new branch at it; your
          current branch and HEAD are never touched.
        </p>
      </div>
    </div>
    <div class="modal-body">
      {#if danglingRecoveryCtrl.loading}
        <div class="log-row"><span class="spinner"></span><span class="msg mut">Running git fsck&#8230; this can take a moment on a large repo.</span></div>
      {:else if danglingRecoveryCtrl.error}
        <div class="log-row"><span class="ic">&#9888;</span><span class="msg mut">{danglingRecoveryCtrl.error}</span></div>
      {:else if danglingRecoveryCtrl.commits.length === 0}
        <div class="log-row"><span class="msg mut">No dangling commits found &#8212; nothing to recover.</span></div>
      {:else}
        <div class="dr-list">
          {#each danglingRecoveryCtrl.commits as c (c.sha)}
            {#if danglingRecoveryCtrl.recoveringSha === c.sha}
              <div class="rm-form" class:busy={danglingRecoveryCtrl.busy}>
                <input
                  type="text"
                  class="mono"
                  bind:value={danglingRecoveryCtrl.branchName}
                  disabled={danglingRecoveryCtrl.busy}
                  spellcheck="false"
                  autocomplete="off"
                  onkeydown={onNameKeydown}
                />
                <div class="nb-row">
                  <span class="mut">recovering {c.shortSha} &#183; Enter to create, Esc to cancel</span>
                  {#if danglingRecoveryCtrl.busy && danglingRecoveryCtrl.busyTarget === c.sha}<span class="spinner"></span>{/if}
                  <button class="btn" disabled={danglingRecoveryCtrl.busy} onclick={() => danglingRecoveryCtrl.confirmRecover()}>Create branch</button>
                  <button class="btn ghost" disabled={danglingRecoveryCtrl.busy} onclick={() => danglingRecoveryCtrl.cancelRecover()}>Cancel</button>
                </div>
              </div>
            {:else}
              <div class="dr-row">
                <span class="dr-sha mono">{c.shortSha}</span>
                <span class="dr-main">
                  <span class="dr-subject">{c.subject || "(no message)"}</span>
                  <span class="dr-meta mut">{c.an.n} &#183; {bridge.relTime(c.an.t)}</span>
                </span>
                <button
                  class="dr-act"
                  disabled={danglingRecoveryCtrl.busy}
                  onclick={() => danglingRecoveryCtrl.startRecover(c)}
                >
                  Recover as new branch&#8230;
                </button>
              </div>
            {/if}
          {/each}
          {#if danglingRecoveryCtrl.truncated}
            <div class="dr-row mut" style="cursor:default">&#8230; truncated (capped)</div>
          {/if}
        </div>
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" disabled={danglingRecoveryCtrl.busy} onclick={() => danglingRecoveryCtrl.close()}>Close</button>
    </div>
  </div>
</div>
