<script lang="ts">
  import { remotesCtrl, ADD_REMOTE_MARKER } from "./remotes.svelte.ts";
  import { t } from "@/i18n/i18n.svelte.ts";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && remotesCtrl.open) remotesCtrl.close();
  }

  function onAddKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") void remotesCtrl.addRemote();
  }

  function onRenameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") void remotesCtrl.confirmRename();
    if (e.key === "Escape") {
      e.stopPropagation(); // don't also close the whole modal
      remotesCtrl.cancelRename();
    }
  }

  function onEditUrlKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") void remotesCtrl.confirmEditUrl();
    if (e.key === "Escape") {
      e.stopPropagation();
      remotesCtrl.cancelEditUrl();
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={remotesCtrl.open}>
  <div class="modal remotes">
    <div class="modal-head">
      <div>
        <h3>{t("remotes.title")}</h3>
        <p>{t("remotes.subtitle")}</p>
      </div>
    </div>
    <div class="modal-body">
      {#if remotesCtrl.loading}
        <div class="log-row"><span class="spinner"></span><span class="msg mut">{t("remotes.loading")}</span></div>
      {:else if remotesCtrl.error}
        <div class="log-row"><span class="ic">&#9888;</span><span class="msg mut">{remotesCtrl.error}</span></div>
      {:else if remotesCtrl.remotes.length === 0}
        <div class="log-row"><span class="msg mut">{t("remotes.empty")}</span></div>
      {:else}
        <div class="rm-list">
          {#each remotesCtrl.remotes as r (r.name)}
            {#if remotesCtrl.renamingName === r.name}
              <div class="rm-form" class:busy={remotesCtrl.busy}>
                <input
                  type="text"
                  bind:value={remotesCtrl.renameInput}
                  disabled={remotesCtrl.busy}
                  spellcheck="false"
                  autocomplete="off"
                  onkeydown={onRenameKeydown}
                />
                <div class="nb-row">
                  {#if remotesCtrl.busy && remotesCtrl.busyTarget === r.name}<span class="spinner"></span>{/if}
                  <button class="btn" disabled={remotesCtrl.busy} onclick={() => remotesCtrl.confirmRename()}>{t("common.save")}</button>
                  <button class="btn ghost" disabled={remotesCtrl.busy} onclick={() => remotesCtrl.cancelRename()}>{t("common.cancel")}</button>
                </div>
              </div>
            {:else if remotesCtrl.editingUrlName === r.name}
              <div class="rm-form" class:busy={remotesCtrl.busy}>
                <input
                  type="text"
                  class="mono"
                  bind:value={remotesCtrl.editUrlInput}
                  disabled={remotesCtrl.busy}
                  spellcheck="false"
                  autocomplete="off"
                  onkeydown={onEditUrlKeydown}
                />
                <div class="nb-row">
                  {#if remotesCtrl.busy && remotesCtrl.busyTarget === r.name}<span class="spinner"></span>{/if}
                  <button class="btn" disabled={remotesCtrl.busy} onclick={() => remotesCtrl.confirmEditUrl()}>{t("common.save")}</button>
                  <button class="btn ghost" disabled={remotesCtrl.busy} onclick={() => remotesCtrl.cancelEditUrl()}>{t("common.cancel")}</button>
                </div>
              </div>
            {:else if remotesCtrl.removingName === r.name}
              <div class="rm-item rm-confirm">
                <span class="msg"
                  >{t("remotes.remove_confirm_pre")}<b>{r.name}</b>{t("remotes.remove_confirm_post")}{#if r.pushUrl} {t("remotes.remove_confirm_pushurl", { url: r.pushUrl })}{/if}</span
                >
                {#if remotesCtrl.busy && remotesCtrl.busyTarget === r.name}<span class="spinner"></span>{/if}
                <div class="rm-act">
                  <button class="danger" disabled={remotesCtrl.busy} onclick={() => remotesCtrl.confirmRemove(r.name)}>{t("common.remove")}</button>
                  <button disabled={remotesCtrl.busy} onclick={() => remotesCtrl.cancelRemove()}>{t("common.cancel")}</button>
                </div>
              </div>
            {:else}
              <div class="rm-item">
                <div class="rm-main">
                  <span class="rm-name">{r.name}</span>
                  <span class="rm-url mono mut" title={r.url}>{r.url}</span>
                  {#if r.pushUrl}<span class="row-chip remote" title={t("remotes.pushurl_tooltip", { url: r.pushUrl })}>{t("remotes.pushurl_chip")}</span>{/if}
                </div>
                {#if remotesCtrl.busy && remotesCtrl.busyTarget === r.name}<span class="spinner"></span>{/if}
                <div class="rm-act">
                  <button disabled={remotesCtrl.busy} onclick={() => remotesCtrl.startRename(r.name)}>{t("remotes.rename")}</button>
                  <button disabled={remotesCtrl.busy} onclick={() => remotesCtrl.startEditUrl(r.name, r.url)}>{t("remotes.edit_url")}</button>
                  <button disabled={remotesCtrl.busy} onclick={() => remotesCtrl.startRemove(r.name)}>{t("common.remove")}</button>
                </div>
              </div>
            {/if}
          {/each}
        </div>
      {/if}

      <div class="rm-add">
        <div class="rm-form" class:busy={remotesCtrl.busy}>
          <input
            type="text"
            placeholder={t("remotes.add_name_ph")}
            bind:value={remotesCtrl.newName}
            disabled={remotesCtrl.busy}
            spellcheck="false"
            autocomplete="off"
            onkeydown={onAddKeydown}
          />
          <input
            type="text"
            class="mono"
            placeholder={t("remotes.add_url_ph")}
            bind:value={remotesCtrl.newUrl}
            disabled={remotesCtrl.busy}
            spellcheck="false"
            autocomplete="off"
            onkeydown={onAddKeydown}
          />
          <div class="nb-row">
            {#if remotesCtrl.busy && remotesCtrl.busyTarget === ADD_REMOTE_MARKER}<span class="spinner"></span>{/if}
            <button class="btn" disabled={remotesCtrl.busy} onclick={() => remotesCtrl.addRemote()}>&#65291; {t("remotes.add_btn")}</button>
          </div>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" disabled={remotesCtrl.busy} onclick={() => remotesCtrl.close()}>{t("common.close")}</button>
    </div>
  </div>
</div>
