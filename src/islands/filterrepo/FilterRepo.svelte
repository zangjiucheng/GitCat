<script lang="ts">
  // Filter-repo wizard — view. Deliberately NO <style> block: reuses the
  // existing global .scrim/.modal.danger/.msteps/.will-lose/.backup-note/
  // .confirm-type/.pl-* classes (see index.html) so the wizard looks and
  // feels like the danger modal it replaces, and consistent with the rest
  // of the app's chrome. Mounted straight to document.body (like Resolver/
  // Bisect), NOT the generic #dangerScrim/armDanger flow.
  import { filterRepoCtrl, REWRITE_PHRASE, RESTORE_PHRASE } from "./filterrepo.svelte.ts";
  import { IN_TAURI } from "../../ipc/env";
  import { t } from "@/i18n/i18n.svelte.ts";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";

  const STEP_ORDER = ["scope", "preview", "confirm", "result"] as const;

  function stepIndex(): number {
    return STEP_ORDER.indexOf(filterRepoCtrl.step as (typeof STEP_ORDER)[number]);
  }

  function fmtTs(ts: number): string {
    if (!ts) return "—";
    try {
      return new Date(ts * 1000).toLocaleString();
    } catch {
      return String(ts);
    }
  }

  function shortSha(sha: string): string {
    return (sha || "").slice(0, 10);
  }

  // Escape closes only a design-mode (browser) wizard — never strand a real,
  // in-flight rewrite OR restore; use the explicit buttons for that.
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape" || !filterRepoCtrl.open) return;
    if (IN_TAURI && (filterRepoCtrl.busy || filterRepoCtrl.restoreBusy)) return;
    filterRepoCtrl.close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" id="filterRepoScrim" class:on={filterRepoCtrl.open}>
  <div class="modal danger">
    <div class="modal-head">
      <div class="modal-tama"><img class="tama-pic" src={filterRepoCtrl.tamaImg} alt="Tama, alarmed" /></div>
      <div>
        <h3>{t("filterrepo.title")}</h3>
        <p>
          {#if filterRepoCtrl.step === "restore"}
            {t("filterrepo.sub_restore")}
          {:else}
            {t("filterrepo.sub_default")}
          {/if}
        </p>
      </div>
    </div>

    {#if filterRepoCtrl.step !== "restore"}
      <div class="msteps" id="filterRepoSteps">
        {#each STEP_ORDER as _s, i}
          <span class="s" class:done={i < stepIndex()} class:now={i === stepIndex()}></span>
        {/each}
      </div>
    {/if}

    <div class="modal-body">
      {#if filterRepoCtrl.step === "scope"}
        <div class="confirm-type">
          <label for="filterRepoPaths">{t("filterrepo.scope_label")}</label>
          <textarea
            id="filterRepoPaths"
            rows="6"
            style="width:100%;font-family:var(--mono)"
            placeholder={"secrets.env\nbuild/\nvendor/"}
            spellcheck="false"
            bind:value={filterRepoCtrl.pathsText}
          ></textarea>
        </div>
        <label class="cp-x" style="margin-top:10px" title={filterRepoCtrl.invert ? t("filterrepo.invert_title_on") : t("filterrepo.invert_title_off")}>
          <input type="checkbox" bind:checked={filterRepoCtrl.invert} />
          {#if filterRepoCtrl.invert}
            {t("filterrepo.invert_label_on")}
          {:else}
            {t("filterrepo.invert_label_off")}
          {/if}
        </label>
        {#if filterRepoCtrl.previewError}
          <div class="pl-err" style="margin-top:10px">{filterRepoCtrl.previewError}</div>
        {/if}
      {:else if filterRepoCtrl.step === "preview"}
        {#if filterRepoCtrl.preview}
          <div class="pl-kv">
            <div><span class="mut">{t("filterrepo.pv_current_branch")}</span> <span class="mono">{filterRepoCtrl.preview.currentBranch || "(detached)"}</span></div>
            <div><span class="mut">{t("filterrepo.pv_total_commits")}</span> {filterRepoCtrl.preview.totalCommits}</div>
            <div><span class="mut">{t("filterrepo.pv_touched")}</span> {filterRepoCtrl.preview.touchedCommits}</div>
            <div><span class="mut">{t("filterrepo.pv_scope")}</span> <span class="mono">{filterRepoCtrl.pathList.join(", ")}</span> — {filterRepoCtrl.invert ? t("filterrepo.scope_removed") : t("filterrepo.scope_kept")}</div>
          </div>
          {#if !filterRepoCtrl.preview.available}
            <div class="pl-err">
              {t("filterrepo.not_installed_pre")}<code>pip install git-filter-repo</code>{t("filterrepo.not_installed_post")}
            </div>
          {:else}
            <div class="will-lose">
              <h5>{t("filterrepo.will_rewrite")}</h5>
              <ul>
                <li>{t("filterrepo.pv_li_rewrites", { touched: filterRepoCtrl.preview.touchedCommits, total: filterRepoCtrl.preview.totalCommits, branch: filterRepoCtrl.preview.currentBranch || "(detached)" })}</li>
                <li>{t("filterrepo.pv_li_hashes")}</li>
                <li>{t("filterrepo.pv_li_shas")}</li>
              </ul>
            </div>
            <div class="backup-note">
              <RotateCcw class="ico" size={14} aria-hidden="true" /> {t("filterrepo.backup_note_pre")}<b>{t("filterrepo.backup_note_bold")}</b>{t("filterrepo.backup_note_post")}
            </div>
          {/if}
        {/if}
      {:else if filterRepoCtrl.step === "confirm"}
        {#if filterRepoCtrl.busy}
          <div class="backup-note" style="display:flex;align-items:center;gap:8px">
            <span class="spinner"></span> {t("filterrepo.confirm_rewriting")}
          </div>
        {:else}
          <div class="will-lose">
            <h5>{t("filterrepo.will_rewrite")}</h5>
            <ul>
              <li>{t("filterrepo.cf_li_rewrites", { touched: filterRepoCtrl.preview?.touchedCommits ?? 0, branch: filterRepoCtrl.preview?.currentBranch || "(detached)" })}</li>
              <li>{t("filterrepo.cf_li_scope", { scope: filterRepoCtrl.pathList.join(", "), outcome: filterRepoCtrl.invert ? t("filterrepo.cf_scope_removed") : t("filterrepo.cf_scope_kept") })}</li>
            </ul>
          </div>
          <div class="backup-note"><RotateCcw class="ico" size={14} aria-hidden="true" /> {t("filterrepo.cf_backup_note")}</div>
          <div class="confirm-type">
            <label for="filterRepoConfirm">{t("filterrepo.confirm_type_pre")}<b class="mono">{REWRITE_PHRASE}</b>{t("filterrepo.confirm_type_post")}</label>
            <input
              id="filterRepoConfirm"
              placeholder={REWRITE_PHRASE}
              spellcheck="false"
              autocomplete="off"
              bind:value={filterRepoCtrl.confirmText}
            />
          </div>
        {/if}
      {:else if filterRepoCtrl.step === "result"}
        {#if filterRepoCtrl.result}
          <div class={filterRepoCtrl.result.ok ? "backup-note" : "pl-err"}>
            {filterRepoCtrl.result.message}
          </div>
          {#if filterRepoCtrl.result.backupBundle}
            <div class="pl-kv">
              <div><span class="mut">{t("filterrepo.res_backup_bundle")}</span> <span class="mono">{filterRepoCtrl.result.backupBundle}</span></div>
              {#if filterRepoCtrl.result.commitsBefore != null}
                <div><span class="mut">{t("filterrepo.res_commits_before")}</span> {filterRepoCtrl.result.commitsBefore}</div>
              {/if}
              {#if filterRepoCtrl.result.commitsAfter != null}
                <div><span class="mut">{t("filterrepo.res_commits_after")}</span> {filterRepoCtrl.result.commitsAfter}</div>
              {/if}
            </div>
          {/if}
        {/if}
      {:else if filterRepoCtrl.step === "restore"}
        {#if filterRepoCtrl.backupsLoading}
          <div class="mut pl-empty"><span class="spinner"></span> {t("filterrepo.restore_loading")}</div>
        {:else if filterRepoCtrl.backupsError}
          <div class="pl-err">{filterRepoCtrl.backupsError}</div>
        {:else if filterRepoCtrl.backups.length === 0}
          <div class="mut pl-empty">{t("filterrepo.restore_none")}</div>
        {:else}
          <div class="cf-files" id="filterRepoBackupList" class:busy={filterRepoCtrl.restoreBusy} data-vimnav-list>
            {#each filterRepoCtrl.backups as b (b.id)}
              <div
                class="cf-file"
                class:sel={b.id === filterRepoCtrl.selectedBackupId}
                role="button"
                tabindex="0"
                onclick={() => filterRepoCtrl.selectBackup(b.id)}
                onkeydown={(e) => (e.key === "Enter" || e.key === " ") && filterRepoCtrl.selectBackup(b.id)}
              >
                <span class="cf-name">{fmtTs(b.ts)} &#183; {b.headBranch || "(detached)"} @ {shortSha(b.headSha)} &#183; {t("filterrepo.restore_row_refs", { n: b.refCount })}</span>
              </div>
            {/each}
          </div>
          {#if filterRepoCtrl.selectedBackup}
            <div class="pl-kv">
              <div><span class="mut">{t("filterrepo.restore_bundle")}</span> <span class="mono">{filterRepoCtrl.selectedBackup.bundlePath}</span></div>
              <div><span class="mut">{t("filterrepo.restore_description")}</span> {filterRepoCtrl.selectedBackup.description}</div>
            </div>
            <div class="confirm-type">
              <label for="filterRepoRestoreConfirm">{t("filterrepo.confirm_type_pre")}<b class="mono">{RESTORE_PHRASE}</b>{t("filterrepo.restore_type_post")}</label>
              <input
                id="filterRepoRestoreConfirm"
                placeholder={RESTORE_PHRASE}
                spellcheck="false"
                autocomplete="off"
                disabled={filterRepoCtrl.restoreBusy}
                bind:value={filterRepoCtrl.restoreConfirmText}
              />
            </div>
          {/if}
        {/if}
        {#if filterRepoCtrl.restoreBusy}
          <div class="backup-note" style="margin-top:10px;display:flex;align-items:center;gap:8px">
            <span class="spinner"></span> {t("filterrepo.restore_busy")}
          </div>
        {/if}
        {#if filterRepoCtrl.restoreResult}
          <div class={filterRepoCtrl.restoreResult.ok ? "backup-note" : "pl-err"} style="margin-top:10px">
            {filterRepoCtrl.restoreResult.message}
          </div>
        {/if}
      {/if}
    </div>

    <div class="modal-foot">
      {#if filterRepoCtrl.step === "scope"}
        <button class="btn ghost" onclick={() => filterRepoCtrl.close()}>{t("common.cancel")}</button>
        <button class="btn ghost" onclick={() => (filterRepoCtrl.demo ? filterRepoCtrl.openRestoreDemo() : filterRepoCtrl.openRestore())}>{t("filterrepo.restore_from_backup")}</button>
        <button class="btn" disabled={!filterRepoCtrl.canPreview} onclick={() => filterRepoCtrl.runPreview()}
          >{#if filterRepoCtrl.busy}<span class="spinner"></span> {t("filterrepo.previewing")}{:else}{t("filterrepo.next_preview")}{/if}</button
        >
      {:else if filterRepoCtrl.step === "preview"}
        <button class="btn ghost" onclick={() => filterRepoCtrl.backToScope()}>{t("filterrepo.back")}</button>
        <button class="btn" disabled={!filterRepoCtrl.canProceedToConfirm} onclick={() => filterRepoCtrl.proceedToConfirm()}>{t("filterrepo.next_confirm")}</button>
      {:else if filterRepoCtrl.step === "confirm"}
        <button class="btn ghost" disabled={filterRepoCtrl.busy} onclick={() => filterRepoCtrl.backToPreview()}>{t("filterrepo.back")}</button>
        <button class="btn danger" disabled={!filterRepoCtrl.canRun} onclick={() => filterRepoCtrl.runFilterRepo()}
          >{#if filterRepoCtrl.busy}<span class="spinner"></span> {t("filterrepo.rewriting")}{:else}{t("filterrepo.rewrite_history")}{/if}</button
        >
      {:else if filterRepoCtrl.step === "result"}
        {#if filterRepoCtrl.result && !filterRepoCtrl.result.ok}
          <button class="btn ghost" onclick={() => (filterRepoCtrl.demo ? filterRepoCtrl.openRestoreDemo() : filterRepoCtrl.openRestore())}>{t("filterrepo.restore_from_backup")}</button>
        {/if}
        <button class="btn" onclick={() => filterRepoCtrl.close()}>{t("common.close")}</button>
      {:else if filterRepoCtrl.step === "restore"}
        <button class="btn ghost" disabled={filterRepoCtrl.restoreBusy} onclick={() => filterRepoCtrl.close()}>{t("common.close")}</button>
        <button class="btn danger" disabled={!filterRepoCtrl.canRestore} onclick={() => filterRepoCtrl.runRestore()}
          >{#if filterRepoCtrl.restoreBusy}<span class="spinner"></span> {t("filterrepo.restoring")}{:else}{t("filterrepo.restore_backup")}{/if}</button
        >
      {/if}
    </div>
  </div>
</div>
