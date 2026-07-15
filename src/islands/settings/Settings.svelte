<script lang="ts">
  // App Settings modal — view. Deliberately no bespoke <style> block beyond
  // the two small additions index.html's own doc comment on the MODALS
  // section calls out (.settings .modal-head tint, .set-toggle checkbox
  // row) — everything else reuses `.scrim`/`.modal`/`.modal-head`/
  // `.modal-body`/`.modal-foot`/`.btn`/`.btn.ghost`/`.rm-form select`/
  // `.confirm-type`/`.d-lab`/`.mut`/`.spinner`/`.log-row`/`.pl-err`/
  // `.backup-note` verbatim (same shared chrome ExternalTools/SetupWizard
  // reuse). The Git Identity section mirrors SetupWizard's own identity
  // step markup closely — see settings.svelte.ts's header doc for why.
  import { settingsCtrl } from "./settings.svelte.ts";
  import type { ThemeMode } from "./settings.svelte.ts";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && settingsCtrl.open) settingsCtrl.close();
  }

  function onThemeChange(e: Event) {
    settingsCtrl.setThemeMode((e.target as HTMLSelectElement).value as ThemeMode);
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={settingsCtrl.open}>
  <div class="modal settings">
    <div class="modal-head">
      <div>
        <h3>Settings</h3>
        <p>Theme, cherry-pick defaults, update checks, and this repository's git identity.</p>
      </div>
    </div>
    <div class="modal-body">
      <h4 class="d-lab">Appearance</h4>
      <div class="rm-form" style="margin-bottom:14px">
        <select value={settingsCtrl.themeMode} onchange={onThemeChange}>
          <option value="system">Match system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>

      <h4 class="d-lab">Cherry-pick</h4>
      <label class="set-toggle" style="margin-bottom:14px" title="Append '(cherry picked from …)' to the resulting commit message">
        <input
          type="checkbox"
          checked={settingsCtrl.cherryPickRecordOriginDefault}
          onchange={(e) => settingsCtrl.setCherryPickRecordOriginDefault((e.target as HTMLInputElement).checked)}
        />
        Record origin (-x) on cherry-pick
      </label>

      <h4 class="d-lab">Updates</h4>
      <label class="set-toggle" style="margin-bottom:14px">
        <input
          type="checkbox"
          checked={settingsCtrl.autoCheckUpdates}
          onchange={(e) => settingsCtrl.setAutoCheckUpdates((e.target as HTMLInputElement).checked)}
        />
        Automatically check for updates on launch
      </label>

      <h4 class="d-lab">Git identity</h4>
      {#if !settingsCtrl.repo}
        <p class="mut">Open a repository to view or edit its git identity.</p>
      {:else if settingsCtrl.identityLoading}
        <div class="log-row"><span class="spinner"></span><span class="msg mut">Loading git identity&#8230;</span></div>
      {:else}
        {#if settingsCtrl.identityError}
          <div class="pl-err" style="margin-bottom:8px">{settingsCtrl.identityError}</div>
        {/if}
        {#if settingsCtrl.identity?.configured && !settingsCtrl.identity.local}
          <p class="mut" style="font-size:11.5px;margin:0 0 8px">
            No identity set for this repository specifically — showing your <b>global</b> git identity below. Save to set one just for this repo instead.
          </p>
        {/if}
        <div class="confirm-type">
          <label for="setName">Name</label>
          <input id="setName" autocomplete="off" spellcheck="false" bind:value={settingsCtrl.nameInput} disabled={settingsCtrl.identitySaving} />
          <label for="setEmail" style="margin-top:8px">Email</label>
          <input id="setEmail" autocomplete="off" spellcheck="false" bind:value={settingsCtrl.emailInput} disabled={settingsCtrl.identitySaving} />
        </div>
        <p class="mut" style="font-size:11.5px;margin:8px 0 0">
          Written only to this repository's <code>.git/config</code> — your global git identity is never touched.
        </p>
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" disabled={settingsCtrl.identitySaving} onclick={() => settingsCtrl.close()}>Close</button>
      {#if settingsCtrl.repo && !settingsCtrl.identityLoading}
        <button class="btn" disabled={!settingsCtrl.canSaveIdentity} onclick={() => settingsCtrl.saveIdentity()}>
          {#if settingsCtrl.identitySaving}<span class="spinner"></span> Saving&#8230;{:else}Save Identity{/if}
        </button>
      {/if}
    </div>
  </div>
</div>
