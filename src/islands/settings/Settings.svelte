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
  import {
    settingsCtrl,
    CURATED_CONFIG_FIELDS,
    AUTO_FETCH_INTERVAL_OPTIONS,
    SETTINGS_TABS,
    TAMA_MOTION_PRESETS,
    TAMA_POSE_OPTIONS,
    TAMA_MOMENT_FIELDS,
    tamaPoseLabel,
  } from "./settings.svelte.ts";
  import type { ThemeMode, SnapshotRetentionMode, GraphLabelPriority, GraphLabelLayout, TamaMotionPreset } from "./settings.svelte.ts";
  import type { ConfigScope } from "../../ipc/bindings";
  import { playTamaSound } from "../../legacy/sound.ts";
  import { updaterCtrl } from "../updater/updater.svelte.ts";
  import { aboutCtrl } from "../about/about.svelte.ts";
  import { t, locale, setLocale, LOCALES } from "@/i18n/i18n.svelte.ts";
  import type { Locale } from "@/i18n/i18n.svelte.ts";
  import { IN_TAURI } from "../../ipc/env";

  // Switching update channel: persist the choice, then immediately surface what's
  // available on the NEWLY-selected channel — turning nightly ON offers the
  // latest nightly; turning it OFF offers the latest STABLE (a "downgrade" back
  // from a running nightly, see updater.rs). Open About so the outcome is visible
  // and the explicit "Install" click there is the confirmation.
  function onNightlyToggle(e: Event) {
    settingsCtrl.setUseNightlyChannel((e.target as HTMLInputElement).checked);
    aboutCtrl.show();
    void updaterCtrl.check(false);
  }

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
        <h3>{t("settings.title")}</h3>
        <p>{t("settings.subtitle")}</p>
      </div>
    </div>
    <div class="rf-tabs" role="tablist" style="padding:10px 20px 0">
      {#each SETTINGS_TABS as tab (tab.id)}
        <button
          class="rf-tab"
          class:sel={settingsCtrl.activeTab === tab.id}
          role="tab"
          aria-selected={settingsCtrl.activeTab === tab.id}
          onclick={() => settingsCtrl.setActiveTab(tab.id)}
        >
          {t("settings.tab_" + tab.id)}
        </button>
      {/each}
    </div>
    <div class="modal-body">
      {#if settingsCtrl.activeTab === "general"}
      <h4 class="d-lab">{t("settings.language")}</h4>
      <div class="rm-form" style="margin-bottom:4px;max-width:220px">
        <select value={locale()} onchange={(e) => setLocale((e.target as HTMLSelectElement).value as Locale)}>
          {#each LOCALES as l (l.id)}
            <option value={l.id}>{l.label}</option>
          {/each}
        </select>
      </div>
      <div class="mut" style="font-size:11.5px;margin:0 0 14px">{t("settings.language_hint")}</div>

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

      <p class="mut" style="font-size:11.5px;margin:0 0 8px">
        When a commit's labels don't all fit, show this kind first. Click a row's <b>+N</b> chip to cycle the rest into view.
      </p>
      <div class="rm-form" style="margin-bottom:14px;max-width:220px">
        <select
          value={settingsCtrl.graphLabelPriority}
          onchange={(e) => settingsCtrl.setGraphLabelPriority((e.target as HTMLSelectElement).value as GraphLabelPriority)}
        >
          <option value="tag">Tags first</option>
          <option value="branch">Branches first</option>
        </select>
      </div>

      <p class="mut" style="font-size:11.5px;margin:0 0 8px">
        Inline draws a commit's ref chips right before its subject text; Left column keeps them in a separate, resizable column.
      </p>
      <div class="rm-form" style="margin-bottom:14px;max-width:220px">
        <select
          value={settingsCtrl.graphLabelLayout}
          onchange={(e) => settingsCtrl.setGraphLabelLayout((e.target as HTMLSelectElement).value as GraphLabelLayout)}
        >
          <option value="inline">Inline (before the subject)</option>
          <option value="column">Left column</option>
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
      <label class="set-toggle" style="margin-bottom:4px">
        <input type="checkbox" checked={settingsCtrl.useNightlyChannel} onchange={onNightlyToggle} />
        Use nightly builds
      </label>
      <div class="mut" style="font-size:11.5px;margin:0 0 10px 26px;line-height:1.5">
        Unstable daily builds with verbose debug logging. You can switch back to the latest stable release at any time.
      </div>
      <!-- Manual update: the same updaterCtrl state machine the About panel and
           the Help ▸ Check for Updates item drive, inline here so an update can
           be checked, downloaded, and installed without leaving Settings. -->
      <div style="margin:0 0 14px">
        {#if updaterCtrl.phase === "idle"}
          <button class="btn ghost" onclick={() => updaterCtrl.check()}>Check for updates now</button>
        {:else if updaterCtrl.phase === "checking"}
          <span class="mut" style="font-size:12.5px"><span class="spinner"></span> Checking for updates&#8230;</span>
        {:else if updaterCtrl.phase === "up-to-date"}
          <span class="mut" style="font-size:12.5px">
            You're up to date. <button class="btn ghost" style="padding:2px 8px;font-size:11px" onclick={() => updaterCtrl.dismiss()}>OK</button>
          </span>
        {:else if updaterCtrl.phase === "available"}
          <div style="border:1px solid var(--border);border-radius:var(--r-control);padding:10px 12px;max-width:340px">
            <div style="font-size:12.5px"><b>v{updaterCtrl.version}</b> is available <span class="mut">(you have v{updaterCtrl.currentVersion})</span></div>
            {#if updaterCtrl.notes}
              <p class="mut" style="font-size:11.5px;white-space:pre-wrap;margin:6px 0 0;max-height:120px;overflow:auto">{updaterCtrl.notes}</p>
            {/if}
            <div style="display:flex;gap:8px;margin-top:10px">
              <button class="btn ghost" onclick={() => updaterCtrl.dismiss()}>Not now</button>
              <button class="btn" onclick={() => updaterCtrl.downloadAndInstall()}>Download &amp; Install</button>
            </div>
          </div>
        {:else if updaterCtrl.phase === "downloading"}
          <div style="border:1px solid var(--border);border-radius:var(--r-control);padding:10px 12px;max-width:340px">
            {#if updaterCtrl.progress != null}
              <div style="height:6px;border-radius:3px;background:var(--elevated);overflow:hidden">
                <div style="height:100%;width:{updaterCtrl.progress}%;background:var(--accent);transition:width .15s"></div>
              </div>
              <span class="mut" style="font-size:11.5px">Downloading&#8230; {updaterCtrl.progress}%</span>
            {:else}
              <span class="mut" style="font-size:12.5px"><span class="spinner"></span> Downloading&#8230;</span>
            {/if}
          </div>
        {:else if updaterCtrl.phase === "ready"}
          <div style="border:1px solid var(--border);border-radius:var(--r-control);padding:10px 12px;max-width:340px">
            <div style="font-size:12.5px">Update downloaded &#8212; restart to finish installing.</div>
            <div style="margin-top:10px"><button class="btn" onclick={() => updaterCtrl.restart()}>Restart Now</button></div>
          </div>
        {:else if updaterCtrl.phase === "error"}
          <span class="mut" style="font-size:12.5px">
            {updaterCtrl.error} <button class="btn ghost" style="padding:2px 8px;font-size:11px" onclick={() => updaterCtrl.dismiss()}>Dismiss</button>
          </span>
        {/if}
      </div>

      {#if IN_TAURI}
        <!-- Command line: adds a `gitcat` launcher to a folder on PATH so a repo
             can be opened from any terminal, VS Code's `code .` style. Works on
             macOS, Linux, and Windows (see cli_shim.rs / install_cli_shim). -->
        <h4 class="d-lab">{t("settings.cli_h4")}</h4>
        <p class="mut" style="font-size:11.5px;margin:0 0 8px">
          {@html t("settings.cli_desc")}
        </p>
        <div style="margin:0 0 14px">
          <button class="btn ghost" disabled={settingsCtrl.cliInstalling} onclick={() => settingsCtrl.installCliCommand()}>
            {#if settingsCtrl.cliInstalling}<span class="spinner"></span> {t("settings.cli_installing")}{:else}{t("settings.cli_install_btn")}{/if}
          </button>
          {#if settingsCtrl.cliInstallOk}
            <div class="mut" style="font-size:11.5px;margin-top:8px">{settingsCtrl.cliInstallOk}</div>
          {/if}
          {#if settingsCtrl.cliInstallError}
            <div class="pl-err" style="margin-top:8px">{settingsCtrl.cliInstallError}</div>
          {/if}
        </div>
      {/if}

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

      <h4 class="d-lab">Maintenance</h4>
      <label
        class="set-toggle"
        style="margin-bottom:8px"
        title="Runs 'git maintenance run --auto' in the background while GitCat is idle, keeping the repo's object database tidy (commit-graph, gc, repack) so the graph and status stay fast. --auto only does work that's actually due; it never changes history, the working tree, or touches a remote."
      >
        <input
          type="checkbox"
          checked={settingsCtrl.autoMaintenanceEnabled}
          onchange={(e) => settingsCtrl.setAutoMaintenanceEnabled((e.target as HTMLInputElement).checked)}
        />
        Run git maintenance in the background when idle
      </label>
      <div class="mut" style="font-size:11.5px;margin:0 0 14px 26px;line-height:1.5">
        Keeps the repository's object database tidy (commit-graph, gc, repack) so everyday operations stay fast — only while the app sits idle, and only the work git decides is actually due. Off by default.
      </div>

      <h4 class="d-lab">Snapshots</h4>
      <p class="mut" style="font-size:11.5px;margin:0 0 8px">
        Every history-changing action pins a recoverable backup — this is what powers &#8984;Z Undo and the Snapshots ribbon. Without cleanup they build up over time. Auto-cleanup prunes old ones each time a repo opens; the single most recent snapshot is always kept.
      </p>
      <div class="rm-form" style="margin-bottom:8px;max-width:300px">
        <select
          value={settingsCtrl.snapshotRetentionMode}
          onchange={(e) => settingsCtrl.setSnapshotRetentionMode((e.target as HTMLSelectElement).value as SnapshotRetentionMode)}
        >
          <option value="off">Keep everything (no cleanup)</option>
          <option value="count">Keep the newest N</option>
          <option value="age">Keep the last N days</option>
          <option value="hybrid">Hybrid — newest N or last N days</option>
        </select>
      </div>
      {#if settingsCtrl.snapshotRetentionMode === "count" || settingsCtrl.snapshotRetentionMode === "hybrid"}
        <label style="display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:13px">
          Keep the newest
          <input
            type="number"
            min="1"
            step="1"
            style="width:64px"
            value={settingsCtrl.snapshotRetentionCount}
            onchange={(e) => settingsCtrl.setSnapshotRetentionCount(Number((e.target as HTMLInputElement).value))}
          />
          snapshots
        </label>
      {/if}
      {#if settingsCtrl.snapshotRetentionMode === "age" || settingsCtrl.snapshotRetentionMode === "hybrid"}
        <label style="display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:13px">
          Keep snapshots from the last
          <input
            type="number"
            min="1"
            step="1"
            style="width:64px"
            value={settingsCtrl.snapshotRetentionDays}
            onchange={(e) => settingsCtrl.setSnapshotRetentionDays(Number((e.target as HTMLInputElement).value))}
          />
          days
        </label>
      {/if}
      {#if settingsCtrl.snapshotRetentionMode === "hybrid"}
        <p class="mut" style="font-size:11px;margin:2px 0 14px">
          A snapshot survives if it's among the newest {settingsCtrl.snapshotRetentionCount} <b>or</b> from the last {settingsCtrl.snapshotRetentionDays} days.
        </p>
      {:else}
        <div style="margin-bottom:14px"></div>
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

      <h4 class="d-lab">Skin</h4>
      <p class="mut" style="font-size:11.5px;margin:0 0 8px">
        Choose a look &#8212; and voice &#8212; for Tama: her default painted portraits, one of the bundled characters, or a skin shipped by an installed plugin.
      </p>
      <div class="rm-form" style="margin-bottom:6px;max-width:260px">
        <select
          value={settingsCtrl.tamaSkinPluginId ?? ""}
          disabled={settingsCtrl.tamaSkinBusy}
          onchange={(e) => settingsCtrl.setTamaSkin((e.target as HTMLSelectElement).value || null)}
        >
          <option value="">Default (built-in)</option>
          {#each settingsCtrl.builtinSkins as s (s.id)}
            <option value={s.id}>{s.name}</option>
          {/each}
          {#each settingsCtrl.skinnablePlugins as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
      </div>
      {#if settingsCtrl.tamaSkinError}
        <div class="pl-err" style="margin-bottom:8px">{settingsCtrl.tamaSkinError}</div>
      {/if}
      <div style="margin-bottom:8px"></div>

      <h4 class="d-lab">Motion</h4>
      <p class="mut" style="font-size:11.5px;margin:0 0 8px">
        How lively Tama's idle motion and reactions feel. <b>Default</b> keeps her current behavior.
      </p>
      <div class="rm-form" style="margin-bottom:14px;max-width:220px">
        <select
          value={settingsCtrl.tamaMotionPreset}
          onchange={(e) => settingsCtrl.setTamaMotionPreset((e.target as HTMLSelectElement).value as TamaMotionPreset)}
        >
          {#each TAMA_MOTION_PRESETS as p (p.value)}
            <option value={p.value}>{p.label}</option>
          {/each}
        </select>
      </div>

      <h4 class="d-lab">Expressions</h4>
      <p class="mut" style="font-size:11.5px;margin:0 0 8px">
        Pick which face Tama makes for each moment. Leave one on <b>Default</b> to keep her built-in look.
      </p>
      <div class="rm-form">
        {#each TAMA_MOMENT_FIELDS as m (m.state)}
          <label for={"tama-mood-" + m.state} style="font-size:12px;color:var(--muted)" title={m.hint}>{m.label}</label>
          <select
            id={"tama-mood-" + m.state}
            value={settingsCtrl.tamaPoseOverride(m.state)}
            onchange={(e) => settingsCtrl.setTamaPoseOverride(m.state, (e.target as HTMLSelectElement).value)}
          >
            <option value="">Default ({tamaPoseLabel(m.pose)})</option>
            {#each TAMA_POSE_OPTIONS as pose (pose.value)}
              <option value={pose.value}>{pose.label}</option>
            {/each}
          </select>
        {/each}
      </div>
      <div style="margin-top:10px;margin-bottom:8px">
        <button class="btn ghost" disabled={!settingsCtrl.hasTamaPoseOverrides} onclick={() => settingsCtrl.resetTamaPoseOverrides()}>
          Reset expressions
        </button>
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
      <button class="btn ghost" disabled={settingsCtrl.identitySaving} onclick={() => settingsCtrl.close()}>{t("common.close")}</button>
      {#if settingsCtrl.activeTab === "identity" && settingsCtrl.repo && !settingsCtrl.identityLoading}
        <button class="btn" disabled={!settingsCtrl.canSaveIdentity} onclick={() => settingsCtrl.saveIdentity()}>
          {#if settingsCtrl.identitySaving}<span class="spinner"></span> Saving&#8230;{:else}Save Identity{/if}
        </button>
      {/if}
    </div>
  </div>
</div>
