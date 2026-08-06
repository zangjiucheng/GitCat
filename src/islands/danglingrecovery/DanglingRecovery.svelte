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
  import { t } from "../../i18n/i18n.svelte.ts";

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
      <div class="modal-tama"><img class="tama-pic" src={danglingRecoveryCtrl.tamaImg} alt={t("danglingrecovery.tama_alt")} /></div>
      <div>
        <h3>{t("danglingrecovery.title")}</h3>
        <p>
          {@html t("danglingrecovery.subtitle")}
        </p>
      </div>
    </div>
    <div class="modal-body">
      {#if danglingRecoveryCtrl.loading}
        <div class="log-row"><span class="spinner"></span><span class="msg mut">{t("danglingrecovery.loading_fsck")}</span></div>
      {:else if danglingRecoveryCtrl.error}
        <div class="log-row"><span class="ic">&#9888;</span><span class="msg mut">{danglingRecoveryCtrl.error}</span></div>
      {:else if danglingRecoveryCtrl.commits.length === 0}
        <div class="log-row"><span class="msg mut">{t("danglingrecovery.empty")}</span></div>
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
                  <span class="mut">{t("danglingrecovery.recovering_hint", { sha: c.shortSha })}</span>
                  {#if danglingRecoveryCtrl.busy && danglingRecoveryCtrl.busyTarget === c.sha}<span class="spinner"></span>{/if}
                  <button class="btn" disabled={danglingRecoveryCtrl.busy} onclick={() => danglingRecoveryCtrl.confirmRecover()}>{t("danglingrecovery.create_branch")}</button>
                  <button class="btn ghost" disabled={danglingRecoveryCtrl.busy} onclick={() => danglingRecoveryCtrl.cancelRecover()}>{t("common.cancel")}</button>
                </div>
              </div>
            {:else}
              <div class="dr-row">
                <span class="dr-sha mono">{c.shortSha}</span>
                <span class="dr-main">
                  <span class="dr-subject">{c.subject || t("danglingrecovery.no_message")}</span>
                  <span class="dr-meta mut">{c.an.n} &#183; {bridge.relTime(c.an.t)}</span>
                </span>
                <button
                  class="dr-act"
                  disabled={danglingRecoveryCtrl.busy}
                  onclick={() => danglingRecoveryCtrl.startRecover(c)}
                >
                  {t("danglingrecovery.recover_as_branch")}
                </button>
              </div>
            {/if}
          {/each}
          {#if danglingRecoveryCtrl.truncated}
            <div class="dr-row mut" style="cursor:default">{t("danglingrecovery.truncated")}</div>
          {/if}
        </div>
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" disabled={danglingRecoveryCtrl.busy} onclick={() => danglingRecoveryCtrl.close()}>{t("common.close")}</button>
    </div>
  </div>
</div>
