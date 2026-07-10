<script lang="ts">
  import { remotesCtrl, ADD_REMOTE_MARKER } from "./remotes.svelte.ts";

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
        <h3>Manage Remotes</h3>
        <p>Add, rename, edit the URL, or remove a configured remote.</p>
      </div>
    </div>
    <div class="modal-body">
      {#if remotesCtrl.loading}
        <div class="log-row"><span class="spinner"></span><span class="msg mut">Loading remotes&#8230;</span></div>
      {:else if remotesCtrl.error}
        <div class="log-row"><span class="ic">&#9888;</span><span class="msg mut">{remotesCtrl.error}</span></div>
      {:else if remotesCtrl.remotes.length === 0}
        <div class="log-row"><span class="msg mut">No remotes configured yet.</span></div>
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
                  <button class="btn" disabled={remotesCtrl.busy} onclick={() => remotesCtrl.confirmRename()}>Save</button>
                  <button class="btn ghost" disabled={remotesCtrl.busy} onclick={() => remotesCtrl.cancelRename()}>Cancel</button>
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
                  <button class="btn" disabled={remotesCtrl.busy} onclick={() => remotesCtrl.confirmEditUrl()}>Save</button>
                  <button class="btn ghost" disabled={remotesCtrl.busy} onclick={() => remotesCtrl.cancelEditUrl()}>Cancel</button>
                </div>
              </div>
            {:else if remotesCtrl.removingName === r.name}
              <div class="rm-item rm-confirm">
                <span class="msg"
                  >Remove <b>{r.name}</b> and its remote-tracking branches?{#if r.pushUrl} Its separate push URL ({r.pushUrl}) will be
                  permanently lost — there's no undo for this.{/if}</span
                >
                {#if remotesCtrl.busy && remotesCtrl.busyTarget === r.name}<span class="spinner"></span>{/if}
                <div class="rm-act">
                  <button class="danger" disabled={remotesCtrl.busy} onclick={() => remotesCtrl.confirmRemove(r.name)}>Remove</button>
                  <button disabled={remotesCtrl.busy} onclick={() => remotesCtrl.cancelRemove()}>Cancel</button>
                </div>
              </div>
            {:else}
              <div class="rm-item">
                <div class="rm-main">
                  <span class="rm-name">{r.name}</span>
                  <span class="rm-url mono mut" title={r.url}>{r.url}</span>
                  {#if r.pushUrl}<span class="row-chip remote" title="Distinct push URL: {r.pushUrl}">push url</span>{/if}
                </div>
                {#if remotesCtrl.busy && remotesCtrl.busyTarget === r.name}<span class="spinner"></span>{/if}
                <div class="rm-act">
                  <button disabled={remotesCtrl.busy} onclick={() => remotesCtrl.startRename(r.name)}>Rename</button>
                  <button disabled={remotesCtrl.busy} onclick={() => remotesCtrl.startEditUrl(r.name, r.url)}>Edit URL</button>
                  <button disabled={remotesCtrl.busy} onclick={() => remotesCtrl.startRemove(r.name)}>Remove</button>
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
            placeholder="name&#8230; e.g. origin"
            bind:value={remotesCtrl.newName}
            disabled={remotesCtrl.busy}
            spellcheck="false"
            autocomplete="off"
            onkeydown={onAddKeydown}
          />
          <input
            type="text"
            class="mono"
            placeholder="URL&#8230;"
            bind:value={remotesCtrl.newUrl}
            disabled={remotesCtrl.busy}
            spellcheck="false"
            autocomplete="off"
            onkeydown={onAddKeydown}
          />
          <div class="nb-row">
            {#if remotesCtrl.busy && remotesCtrl.busyTarget === ADD_REMOTE_MARKER}<span class="spinner"></span>{/if}
            <button class="btn" disabled={remotesCtrl.busy} onclick={() => remotesCtrl.addRemote()}>&#65291; Add remote</button>
          </div>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" disabled={remotesCtrl.busy} onclick={() => remotesCtrl.close()}>Close</button>
    </div>
  </div>
</div>
