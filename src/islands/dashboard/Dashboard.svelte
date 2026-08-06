<script lang="ts">
  import { dashboardCtrl, repoBasename, isWslPath } from "./dashboard.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import { t } from "../../i18n/i18n.svelte.ts";

  // The search box, focused once per open (see the effect) so typing narrows
  // the list immediately — reset to undefined between opens by Svelte itself.
  let searchEl: HTMLInputElement | undefined = $state();
  let focusedForOpen = false;
  $effect(() => {
    if (!dashboardCtrl.open) {
      focusedForOpen = false;
      return;
    }
    // The input only exists once rows have loaded (search is hidden while
    // loading/empty), so this runs when searchEl first mounts, not at open.
    if (!focusedForOpen && searchEl) {
      focusedForOpen = true;
      const el = searchEl;
      requestAnimationFrame(() => el.focus());
    }
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && dashboardCtrl.open) dashboardCtrl.close();
  }

  // Enter in the search box opens the top hit — "type a few letters, hit Enter".
  function onSearchKey(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    const first = dashboardCtrl.filteredRows[0];
    if (first && !first.error) {
      e.preventDefault();
      dashboardCtrl.openRepository(first.path);
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={dashboardCtrl.open}>
  <div class="modal dashboard">
    <div class="modal-head">
      <div>
        <h3>{t("dashboard.title")}</h3>
        <p>{t("dashboard.subtitle")}</p>
      </div>
    </div>
    <div class="modal-body">
      {#if dashboardCtrl.loading}
        <div class="log-row"><span class="spinner"></span><span class="msg mut">{t("dashboard.loading_repos")}</span></div>
      {:else if dashboardCtrl.error}
        <div class="log-row"><span class="ic">&#9888;</span><span class="msg mut">{dashboardCtrl.error}</span></div>
      {:else if dashboardCtrl.rows.length === 0}
        <div class="log-row"><span class="msg mut">{t("dashboard.empty")}</span></div>
      {:else}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="db-search mono"
          type="text"
          placeholder={t("dashboard.search_ph")}
          bind:value={dashboardCtrl.query}
          bind:this={searchEl}
          onkeydown={onSearchKey}
          spellcheck="false"
          autocomplete="off"
        />
        {#if dashboardCtrl.filteredRows.length === 0}
          <div class="log-row"><span class="msg mut">{t("dashboard.no_match", { q: dashboardCtrl.query })}</span></div>
        {:else}
        <div class="db-list">
          {#each dashboardCtrl.filteredRows as r (r.path)}
            <div class="db-item" class:broken={!!r.error}>
              <div class="db-main">
                <div class="db-name-row">
                  <span class="db-name" title={r.path}>{repoBasename(r.path)}</span>
                  {#if isWslPath(r.path)}
                    <span class="row-chip wsl" title={t("dashboard.wsl_tip")}>WSL</span>
                  {/if}
                  {#if r.status?.branch}
                    <span class="row-chip head">{r.status.branch}</span>
                  {:else if r.status?.detached}
                    <span class="row-chip">{t("dashboard.detached")}</span>
                  {/if}
                  {#if r.status && (r.status.ahead || r.status.behind)}
                    <span class="db-ab mono"
                      >{#if r.status.ahead}<b>&#8593;{r.status.ahead}</b>{/if}{#if r.status.ahead && r.status.behind}&#183;{/if}{#if r.status
                        .behind}<b>&#8595;{r.status.behind}</b>{/if}</span
                    >
                  {/if}
                  {#if r.status?.dirty}<span class="row-chip dirty" title={t("dashboard.dirty_tip")}>{t("dashboard.dirty")}</span>{/if}
                  {#if r.status && r.status.conflicted > 0}
                    <span class="row-chip dirty" title={t("dashboard.conflicted_tip", { n: r.status.conflicted })}>&#9888; {t("dashboard.conflicted")}</span>
                  {/if}
                </div>
                <div class="db-path mut mono" title={r.path}>{r.path}</div>
                {#if r.status?.lastSubject}
                  <div class="db-sub mut">
                    {r.status.lastSubject} &#183; {bridge.relTime(r.status.lastCommitTime ?? 0)}{#if r.loading}
                      <span class="spinner"></span>{/if}
                  </div>
                {:else if r.loading}
                  <div class="db-sub mut"><span class="spinner"></span> {t("dashboard.reading_status")}</div>
                {:else if r.error}
                  <div class="db-sub db-broken">&#9888; {r.error}</div>
                {/if}
              </div>
              <div class="db-act">
                <button class="btn" disabled={!!r.error} onclick={() => dashboardCtrl.openRepository(r.path)}>{t("dashboard.open")}</button>
                <button
                  disabled={!!r.error}
                  title={t("dashboard.new_window_tip")}
                  onclick={() => dashboardCtrl.openRepositoryInNewWindow(r.path)}>{t("dashboard.new_window")}</button
                >
                <button disabled={dashboardCtrl.removingPath === r.path} onclick={() => dashboardCtrl.removeRepository(r.path)}>
                  {#if dashboardCtrl.removingPath === r.path}<span class="spinner"></span>{:else}{t("common.remove")}{/if}
                </button>
              </div>
            </div>
          {/each}
        </div>
        {/if}
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn db-add" disabled={dashboardCtrl.addBusy} onclick={() => dashboardCtrl.addRepository()}>
        {#if dashboardCtrl.addBusy}<span class="spinner"></span>{/if} &#65291; {t("dashboard.add")}
      </button>
      <button class="btn ghost" onclick={() => dashboardCtrl.close()}>{t("common.close")}</button>
    </div>
  </div>
</div>
