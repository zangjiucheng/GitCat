<script lang="ts">
  // App Settings modal — view. Deliberately no bespoke <style> block beyond
  // the three small additions index.html's own doc comment on the MODALS
  // section calls out (.settings .modal-head tint, .set-toggle checkbox
  // row, .set-volume slider+Test row) — everything else reuses
  // `.scrim`/`.modal`/`.modal-head`/`.modal-body`/`.modal-foot`/`.btn`/
  // `.btn.ghost`/`.rm-form select`/`.confirm-type`/`.d-lab`/`.mut`/
  // `.spinner`/`.log-row`/`.pl-err`/`.backup-note` verbatim (same shared
  // chrome ExternalTools/SetupWizard reuse). The Git Identity section
  // mirrors SetupWizard's own identity step markup closely — see
  // settings.svelte.ts's header doc for why.
  import { settingsCtrl, CURATED_CONFIG_FIELDS, AUTO_FETCH_INTERVAL_OPTIONS, SETTINGS_TABS } from "./settings.svelte.ts";
  import type { ThemeMode } from "./settings.svelte.ts";
  import type { ConfigScope } from "../../ipc/bindings";
  import { playTamaSound } from "../../legacy/sound.ts";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && settingsCtrl.open) settingsCtrl.close();
  }

  function onThemeChange(e: Event) {
    settingsCtrl.setThemeMode((e.target as HTMLSelectElement).value as ThemeMode);
  }

  // Volume is stored 0-1 (sound.ts's own master-gain range); the slider
  // itself works in whole percent (0-100, step 5) since a 0-1 range input
  // with no step would invite showing users a distracting 17-decimal float.
  function onVolumeInput(e: Event) {
    settingsCtrl.setSoundEffectsVolume(Number((e.target as HTMLInputElement).value) / 100);
  }

  function onConfigScopeChange(e: Event) {
    settingsCtrl.setConfigScope((e.target as HTMLSelectElement).value as ConfigScope);
  }

  function onCuratedFieldChange(key: string, e: Event) {
    const v = (e.target as HTMLInputElement | HTMLSelectElement).value.trim();
    void settingsCtrl.setConfigField(key, v || null);
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
    <div class="rf-tabs" role="tablist" style="padding:10px 20px 0">
      {#each SETTINGS_TABS as t (t.id)}
        <button
          class="rf-tab"
          class:sel={settingsCtrl.activeTab === t.id}
          role="tab"
          aria-selected={settingsCtrl.activeTab === t.id}
          onclick={() => settingsCtrl.setActiveTab(t.id)}
        >
          {t.label}
        </button>
      {/each}
    </div>
    <div class="modal-body">
      {#if settingsCtrl.activeTab === "general"}
      <h4 class="d-lab">Appearance</h4>
      <div class="rm-form" style="margin-bottom:14px">
        <select value={settingsCtrl.themeMode} onchange={onThemeChange}>
          <option value="system">Match system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>

      <h4 class="d-lab">Graph</h4>
      <label class="set-toggle" style="margin-bottom:14px" title="When a commit has more than one tag, draw all of them instead of just the first">
        <input
          type="checkbox"
          checked={settingsCtrl.showAllCommitTags}
          onchange={(e) => settingsCtrl.setShowAllCommitTags((e.target as HTMLInputElement).checked)}
        />
        Show all tags on a commit
      </label>

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

      <h4 class="d-lab">Auto-fetch</h4>
      <label
        class="set-toggle"
        style="margin-bottom:8px"
        title="Runs git fetch --all --prune on a timer while a repo is open, so ahead/behind counts and incoming remote changes stay current without a manual Pull"
      >
        <input
          type="checkbox"
          checked={settingsCtrl.autoFetchEnabled}
          onchange={(e) => settingsCtrl.setAutoFetchEnabled((e.target as HTMLInputElement).checked)}
        />
        Periodically fetch from all remotes
      </label>
      {#if settingsCtrl.autoFetchEnabled}
        <div class="rm-form" style="margin-bottom:14px;max-width:220px">
          <select
            value={String(settingsCtrl.autoFetchIntervalMinutes)}
            onchange={(e) => settingsCtrl.setAutoFetchIntervalMinutes(Number((e.target as HTMLSelectElement).value))}
          >
            {#each AUTO_FETCH_INTERVAL_OPTIONS as m (m)}
              <option value={String(m)}>Every {m} minutes</option>
            {/each}
          </select>
        </div>
      {/if}
      {/if}

      {#if settingsCtrl.activeTab === "tama"}
      <h4 class="d-lab">Tama</h4>
      <label
        class="set-toggle"
        style="margin-bottom:10px"
        title="Hides Tama's portraits everywhere she appears (the corner mascot, the empty-state greeting, modal headers, the undo popover) for a plainer, more focused look. Status/error messages in the corner still show — just without the character."
      >
        <input type="checkbox" checked={settingsCtrl.tamaEnabled} onchange={(e) => settingsCtrl.setTamaEnabled((e.target as HTMLInputElement).checked)} />
        Show Tama
      </label>
      <label class="set-toggle" style="margin-bottom:10px" title="A few short synthesized chimes for her more significant moments — warnings, danger, celebrating, a copy-to-clipboard tick">
        <input
          type="checkbox"
          checked={settingsCtrl.soundEffectsEnabled}
          onchange={(e) => settingsCtrl.setSoundEffectsEnabled((e.target as HTMLInputElement).checked)}
        />
        Play sound effects
      </label>
      <div class="set-volume" style="margin-bottom:14px">
        <input
          type="range"
          min="0"
          max="100"
          step="5"
          value={Math.round(settingsCtrl.soundEffectsVolume * 100)}
          disabled={!settingsCtrl.soundEffectsEnabled}
          oninput={onVolumeInput}
          aria-label="Sound effects volume"
        />
        <button
          class="btn ghost"
          disabled={!settingsCtrl.soundEffectsEnabled}
          onclick={() => playTamaSound("celebrate", { bypassCooldown: true })}>Test</button
        >
      </div>
      {/if}

      {#if settingsCtrl.activeTab === "identity"}
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
      {/if}

      {#if settingsCtrl.activeTab === "gitconfig"}
      <h4 class="d-lab">Git config</h4>
      {#if !settingsCtrl.repo}
        <p class="mut">Open a repository to view or edit its git configuration.</p>
      {:else}
        <div class="rm-form" style="margin-bottom:10px">
          <select value={settingsCtrl.configScope} onchange={onConfigScopeChange}>
            <option value="local">This repository (.git/config)</option>
            <option value="global">Global (~/.gitconfig — every repository)</option>
          </select>
        </div>
        {#if settingsCtrl.configLoading}
          <div class="log-row"><span class="spinner"></span><span class="msg mut">Loading git configuration&#8230;</span></div>
        {:else}
          {#if settingsCtrl.configError}
            <div class="pl-err" style="margin-bottom:8px">{settingsCtrl.configError}</div>
          {/if}
          <div class="rm-form">
            {#each CURATED_CONFIG_FIELDS as field (field.key)}
              <label for={"cfg-" + field.key} style="font-size:12px;color:var(--muted)">{field.label}</label>
              {#if field.kind === "select"}
                <select
                  id={"cfg-" + field.key}
                  value={settingsCtrl.configFieldValue(field.key)}
                  disabled={settingsCtrl.savingConfigKey === field.key}
                  onchange={(e) => onCuratedFieldChange(field.key, e)}
                >
                  {#each field.options ?? [] as opt (opt.value)}
                    <option value={opt.value}>{opt.label}</option>
                  {/each}
                </select>
              {:else}
                <input
                  id={"cfg-" + field.key}
                  autocomplete="off"
                  spellcheck="false"
                  placeholder={field.placeholder}
                  value={settingsCtrl.configFieldValue(field.key)}
                  disabled={settingsCtrl.savingConfigKey === field.key}
                  onchange={(e) => onCuratedFieldChange(field.key, e)}
                />
              {/if}
              {#if settingsCtrl.effectiveConfigHint(field.key)}
                <p class="mut" style="font-size:11px;margin:2px 0 0">{settingsCtrl.effectiveConfigHint(field.key)}</p>
              {/if}
              {#if settingsCtrl.configFieldErrors[field.key]}
                <div class="pl-err" style="font-size:11px;margin:2px 0 0">{settingsCtrl.configFieldErrors[field.key]}</div>
              {/if}
            {/each}
          </div>

          {#if !settingsCtrl.advancedOpen}
            <button class="btn ghost" style="margin-top:10px" onclick={() => settingsCtrl.openAdvanced()}>Show advanced (any key)&#8230;</button>
          {:else}
            <button class="btn ghost" style="margin-top:10px" onclick={() => settingsCtrl.closeAdvanced()}>Hide advanced</button>
            <div style="margin-top:8px">
              {#if settingsCtrl.advancedLoading}
                <div class="log-row"><span class="spinner"></span><span class="msg mut">Loading&#8230;</span></div>
              {:else}
                {#if settingsCtrl.advancedError}
                  <div class="pl-err" style="margin-bottom:6px">{settingsCtrl.advancedError}</div>
                {/if}
                {#if settingsCtrl.advancedEntries.length > 0}
                  <input
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="Filter keys or values&#8230;"
                    bind:value={settingsCtrl.advancedFilter}
                    style="width:100%;box-sizing:border-box;margin-bottom:8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--r-control);color:var(--text);font:inherit;font-size:12px;padding:6px 8px"
                  />
                {/if}
                {#each settingsCtrl.filteredAdvancedEntries as entry (entry.key + " " + entry.value)}
                  <div class="log-row" style="justify-content:space-between;gap:8px">
                    <span class="msg" style="font-family:monospace;font-size:11.5px;overflow-wrap:anywhere">{entry.key} = {entry.value}</span>
                    <button
                      class="btn ghost"
                      style="flex:0 0 auto"
                      disabled={settingsCtrl.savingConfigKey === entry.key}
                      onclick={() => settingsCtrl.editAdvancedEntry(entry)}
                    >
                      Edit
                    </button>
                    <button
                      class="btn ghost"
                      style="flex:0 0 auto"
                      disabled={settingsCtrl.savingConfigKey === entry.key}
                      onclick={() => settingsCtrl.removeAdvancedEntry(entry.key)}
                    >
                      Remove
                    </button>
                  </div>
                {:else}
                  <p class="mut" style="font-size:11.5px">
                    {#if settingsCtrl.advancedFilter.trim()}No entries match &quot;{settingsCtrl.advancedFilter.trim()}&quot;.{:else}No {settingsCtrl.configScope}
                      config entries.{/if}
                  </p>
                {/each}
                <p class="mut" style="font-size:11px;margin:8px 0 4px">
                  Add a key, or click Edit on an existing row to update its value.
                </p>
                <div style="display:flex;gap:6px;align-items:center">
                  <input
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="section.key"
                    bind:value={settingsCtrl.newAdvancedKey}
                    disabled={settingsCtrl.savingConfigKey !== null}
                    style="flex:1;min-width:0;background:var(--bg);border:1px solid var(--border);border-radius:var(--r-control);color:var(--text);font:inherit;font-size:12px;padding:6px 8px"
                  />
                  <input
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="value"
                    bind:value={settingsCtrl.newAdvancedValue}
                    disabled={settingsCtrl.savingConfigKey !== null}
                    style="flex:1;min-width:0;background:var(--bg);border:1px solid var(--border);border-radius:var(--r-control);color:var(--text);font:inherit;font-size:12px;padding:6px 8px"
                  />
                  <button
                    class="btn ghost"
                    style="flex:0 0 auto"
                    disabled={!settingsCtrl.newAdvancedKey.trim() || settingsCtrl.savingConfigKey !== null}
                    onclick={() => settingsCtrl.addAdvancedEntry()}
                  >
                    Set
                  </button>
                </div>
              {/if}
            </div>
          {/if}
        {/if}
      {/if}
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" disabled={settingsCtrl.identitySaving} onclick={() => settingsCtrl.close()}>Close</button>
      {#if settingsCtrl.activeTab === "identity" && settingsCtrl.repo && !settingsCtrl.identityLoading}
        <button class="btn" disabled={!settingsCtrl.canSaveIdentity} onclick={() => settingsCtrl.saveIdentity()}>
          {#if settingsCtrl.identitySaving}<span class="spinner"></span> Saving&#8230;{:else}Save Identity{/if}
        </button>
      {/if}
    </div>
  </div>
</div>
