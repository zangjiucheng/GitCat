<script lang="ts">
  import { dashboardCtrl, repoBasename, isWslPath } from "./dashboard.svelte.ts";
  import * as bridge from "../../legacy/bridge";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && dashboardCtrl.open) dashboardCtrl.close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={dashboardCtrl.open}>
  <div class="modal dashboard">
    <div class="modal-head">
      <div>
        <h3>Repositories</h3>
        <p>Every repository you've tracked, at a glance &#8212; branch, sync state, and whether it's dirty.</p>
      </div>
    </div>
    <div class="modal-body">
      {#if dashboardCtrl.loading}
        <div class="log-row"><span class="spinner"></span><span class="msg mut">Loading tracked repositories&#8230;</span></div>
      {:else if dashboardCtrl.error}
        <div class="log-row"><span class="ic">&#9888;</span><span class="msg mut">{dashboardCtrl.error}</span></div>
      {:else if dashboardCtrl.rows.length === 0}
        <div class="log-row"><span class="msg mut">Nothing tracked yet &#8212; open a repository, or add one below.</span></div>
      {:else}
        <div class="db-list">
          {#each dashboardCtrl.rows as r (r.path)}
            <div class="db-item" class:broken={!!r.error}>
              <div class="db-main">
                <div class="db-name-row">
                  <span class="db-name" title={r.path}>{repoBasename(r.path)}</span>
                  {#if isWslPath(r.path)}
                    <span class="row-chip wsl" title="This repository lives inside WSL — network commands route through wsl.exe for credential resolution">WSL</span>
                  {/if}
                  {#if r.status?.branch}
                    <span class="row-chip head">{r.status.branch}</span>
                  {:else if r.status?.detached}
                    <span class="row-chip">detached</span>
                  {/if}
                  {#if r.status && (r.status.ahead || r.status.behind)}
                    <span class="db-ab mono"
                      >{#if r.status.ahead}<b>&#8593;{r.status.ahead}</b>{/if}{#if r.status.ahead && r.status.behind}&#183;{/if}{#if r.status
                        .behind}<b>&#8595;{r.status.behind}</b>{/if}</span
                    >
                  {/if}
                  {#if r.status?.dirty}<span class="row-chip dirty" title="Uncommitted changes">dirty</span>{/if}
                  {#if r.status && r.status.conflicted > 0}
                    <span class="row-chip dirty" title="{r.status.conflicted} conflicted file(s)">&#9888; conflicted</span>
                  {/if}
                </div>
                <div class="db-path mut mono" title={r.path}>{r.path}</div>
                {#if r.status?.lastSubject}
                  <div class="db-sub mut">
                    {r.status.lastSubject} &#183; {bridge.relTime(r.status.lastCommitTime ?? 0)}{#if r.loading}
                      <span class="spinner"></span>{/if}
                  </div>
                {:else if r.loading}
                  <div class="db-sub mut"><span class="spinner"></span> reading status&#8230;</div>
                {:else if r.error}
                  <div class="db-sub db-broken">&#9888; {r.error}</div>
                {/if}
              </div>
              <div class="db-act">
                <button class="btn" disabled={!!r.error} onclick={() => dashboardCtrl.openRepository(r.path)}>Open</button>
                <button
                  disabled={!!r.error}
                  title="Open this repository in a separate window, keeping whatever's open here"
                  onclick={() => dashboardCtrl.openRepositoryInNewWindow(r.path)}>New Window</button
                >
                <button disabled={dashboardCtrl.removingPath === r.path} onclick={() => dashboardCtrl.removeRepository(r.path)}>
                  {#if dashboardCtrl.removingPath === r.path}<span class="spinner"></span>{:else}Remove{/if}
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn db-add" disabled={dashboardCtrl.addBusy} onclick={() => dashboardCtrl.addRepository()}>
        {#if dashboardCtrl.addBusy}<span class="spinner"></span>{/if} &#65291; Add repository&#8230;
      </button>
      <button class="btn ghost" onclick={() => dashboardCtrl.close()}>Close</button>
    </div>
  </div>
</div>
