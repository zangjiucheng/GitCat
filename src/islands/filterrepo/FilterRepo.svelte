<script lang="ts">
  // Filter-repo wizard — view. Deliberately NO <style> block: reuses the
  // existing global .scrim/.modal.danger/.msteps/.will-lose/.backup-note/
  // .confirm-type/.pl-* classes (see index.html) so the wizard looks and
  // feels like the danger modal it replaces, and consistent with the rest
  // of the app's chrome. Mounted straight to document.body (like Resolver/
  // Bisect), NOT the generic #dangerScrim/armDanger flow.
  import { filterRepoCtrl, REWRITE_PHRASE, RESTORE_PHRASE } from "./filterrepo.svelte.ts";
  import { IN_TAURI } from "../../ipc/env";

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
        <h3>Rewrite history &#8212; filter-repo</h3>
        <p>
          {#if filterRepoCtrl.step === "restore"}
            Restore a previous pre-rewrite backup.
          {:else}
            This rewrites every commit touching the selected paths. It cannot be undone with a normal Undo.
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
          <label for="filterRepoPaths">Path(s) to filter (one per line, or comma-separated):</label>
          <textarea
            id="filterRepoPaths"
            rows="6"
            style="width:100%;font-family:var(--mono)"
            placeholder={"secrets.env\nbuild/\nvendor/"}
            spellcheck="false"
            bind:value={filterRepoCtrl.pathsText}
          ></textarea>
        </div>
        <label class="cp-x" style="margin-top:10px" title={filterRepoCtrl.invert ? "Remove the listed paths from history, keep everything else (e.g. purge a leaked secret file)" : "Keep ONLY the listed paths — deletes everything else in history"}>
          <input type="checkbox" bind:checked={filterRepoCtrl.invert} />
          {#if filterRepoCtrl.invert}
            Remove these paths, keep everything else (e.g. purge a secret file)
          {:else}
            Keep ONLY these paths — deletes everything else in history
          {/if}
        </label>
        {#if filterRepoCtrl.previewError}
          <div class="pl-err" style="margin-top:10px">{filterRepoCtrl.previewError}</div>
        {/if}
      {:else if filterRepoCtrl.step === "preview"}
        {#if filterRepoCtrl.preview}
          <div class="pl-kv">
            <div><span class="mut">current branch</span> <span class="mono">{filterRepoCtrl.preview.currentBranch || "(detached)"}</span></div>
            <div><span class="mut">total commits</span> {filterRepoCtrl.preview.totalCommits}</div>
            <div><span class="mut">commits touching scope</span> {filterRepoCtrl.preview.touchedCommits}</div>
            <div><span class="mut">scope</span> <span class="mono">{filterRepoCtrl.pathList.join(", ")}</span> — {filterRepoCtrl.invert ? "will be removed, everything else kept" : "will be KEPT, everything else removed"}</div>
          </div>
          {#if !filterRepoCtrl.preview.available}
            <div class="pl-err">
              git-filter-repo is not installed — install it (<code>pip install git-filter-repo</code>) before continuing. The wizard cannot proceed past this step.
            </div>
          {:else}
            <div class="will-lose">
              <h5>What this will rewrite</h5>
              <ul>
                <li>Rewrites <code>{filterRepoCtrl.preview.touchedCommits}</code> of <code>{filterRepoCtrl.preview.totalCommits}</code> commits on <code>{filterRepoCtrl.preview.currentBranch || "(detached)"}</code></li>
                <li>Every commit hash after the earliest touched commit changes</li>
                <li>Original SHAs become unreachable once the backup expires</li>
              </ul>
            </div>
            <div class="backup-note">
              &#128257; A verified backup bundle is saved <b>before</b> filter-repo ever runs &#8594; full pre-rewrite state stays recoverable via Restore.
            </div>
          {/if}
        {/if}
      {:else if filterRepoCtrl.step === "confirm"}
        {#if filterRepoCtrl.busy}
          <div class="backup-note" style="display:flex;align-items:center;gap:8px">
            <span class="spinner"></span> Rewriting history&#8230; this can take a while for large repos. Don&#8217;t close GitCat.
          </div>
        {:else}
          <div class="will-lose">
            <h5>What this will rewrite</h5>
            <ul>
              <li>Rewrites <code>{filterRepoCtrl.preview?.touchedCommits ?? 0}</code> commits on <code>{filterRepoCtrl.preview?.currentBranch || "(detached)"}</code></li>
              <li>Scope: <code>{filterRepoCtrl.pathList.join(", ")}</code> — {filterRepoCtrl.invert ? "removed, everything else kept" : "KEPT, everything else removed"}</li>
            </ul>
          </div>
          <div class="backup-note">&#128257; Pre-op backup is saved and verified first &#8594; full pre-rewrite state stays recoverable.</div>
          <div class="confirm-type">
            <label for="filterRepoConfirm">Type <b class="mono">{REWRITE_PHRASE}</b> to arm the rewrite:</label>
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
              <div><span class="mut">backup bundle</span> <span class="mono">{filterRepoCtrl.result.backupBundle}</span></div>
              {#if filterRepoCtrl.result.commitsBefore != null}
                <div><span class="mut">commits before</span> {filterRepoCtrl.result.commitsBefore}</div>
              {/if}
              {#if filterRepoCtrl.result.commitsAfter != null}
                <div><span class="mut">commits after</span> {filterRepoCtrl.result.commitsAfter}</div>
              {/if}
            </div>
          {/if}
        {/if}
      {:else if filterRepoCtrl.step === "restore"}
        {#if filterRepoCtrl.backupsLoading}
          <div class="mut pl-empty"><span class="spinner"></span> Loading backups&#8230;</div>
        {:else if filterRepoCtrl.backupsError}
          <div class="pl-err">{filterRepoCtrl.backupsError}</div>
        {:else if filterRepoCtrl.backups.length === 0}
          <div class="mut pl-empty">No backups recorded yet — a backup is created automatically the first time you run filter-repo.</div>
        {:else}
          <div class="cf-files" id="filterRepoBackupList" class:busy={filterRepoCtrl.restoreBusy}>
            {#each filterRepoCtrl.backups as b (b.id)}
              <div
                class="cf-file"
                class:sel={b.id === filterRepoCtrl.selectedBackupId}
                role="button"
                tabindex="0"
                onclick={() => filterRepoCtrl.selectBackup(b.id)}
                onkeydown={(e) => (e.key === "Enter" || e.key === " ") && filterRepoCtrl.selectBackup(b.id)}
              >
                <span class="cf-name">{fmtTs(b.ts)} &#183; {b.headBranch || "(detached)"} @ {shortSha(b.headSha)} &#183; {b.refCount} ref(s)</span>
              </div>
            {/each}
          </div>
          {#if filterRepoCtrl.selectedBackup}
            <div class="pl-kv">
              <div><span class="mut">bundle</span> <span class="mono">{filterRepoCtrl.selectedBackup.bundlePath}</span></div>
              <div><span class="mut">description</span> {filterRepoCtrl.selectedBackup.description}</div>
            </div>
            <div class="confirm-type">
              <label for="filterRepoRestoreConfirm">Type <b class="mono">{RESTORE_PHRASE}</b> to restore this backup (this discards the current state):</label>
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
            <span class="spinner"></span> Restoring backup&#8230; don&#8217;t close GitCat.
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
        <button class="btn ghost" onclick={() => filterRepoCtrl.close()}>Cancel</button>
        <button class="btn ghost" onclick={() => (filterRepoCtrl.demo ? filterRepoCtrl.openRestoreDemo() : filterRepoCtrl.openRestore())}>Restore from backup&#8230;</button>
        <button class="btn" disabled={!filterRepoCtrl.canPreview} onclick={() => filterRepoCtrl.runPreview()}
          >{#if filterRepoCtrl.busy}<span class="spinner"></span> Previewing…{:else}Next: Preview{/if}</button
        >
      {:else if filterRepoCtrl.step === "preview"}
        <button class="btn ghost" onclick={() => filterRepoCtrl.backToScope()}>Back</button>
        <button class="btn" disabled={!filterRepoCtrl.canProceedToConfirm} onclick={() => filterRepoCtrl.proceedToConfirm()}>Next: Confirm</button>
      {:else if filterRepoCtrl.step === "confirm"}
        <button class="btn ghost" disabled={filterRepoCtrl.busy} onclick={() => filterRepoCtrl.backToPreview()}>Back</button>
        <button class="btn danger" disabled={!filterRepoCtrl.canRun} onclick={() => filterRepoCtrl.runFilterRepo()}
          >{#if filterRepoCtrl.busy}<span class="spinner"></span> Rewriting…{:else}Rewrite history{/if}</button
        >
      {:else if filterRepoCtrl.step === "result"}
        {#if filterRepoCtrl.result && !filterRepoCtrl.result.ok}
          <button class="btn ghost" onclick={() => (filterRepoCtrl.demo ? filterRepoCtrl.openRestoreDemo() : filterRepoCtrl.openRestore())}>Restore from backup&#8230;</button>
        {/if}
        <button class="btn" onclick={() => filterRepoCtrl.close()}>Close</button>
      {:else if filterRepoCtrl.step === "restore"}
        <button class="btn ghost" disabled={filterRepoCtrl.restoreBusy} onclick={() => filterRepoCtrl.close()}>Close</button>
        <button class="btn danger" disabled={!filterRepoCtrl.canRestore} onclick={() => filterRepoCtrl.runRestore()}
          >{#if filterRepoCtrl.restoreBusy}<span class="spinner"></span> Restoring…{:else}Restore backup{/if}</button
        >
      {/if}
    </div>
  </div>
</div>
