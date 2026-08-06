<script lang="ts">
  // Repository Summary — view. Deliberately no bespoke <style> block for the
  // shared chrome: reuses `.scrim`/`.modal`/`.modal-head`/`.modal-body`/
  // `.modal-foot`/`.btn.ghost`/`.log-row`/`.mono`/`.mut`/`.spinner`/
  // `.stat-bar`/`.fh-caveat` verbatim (see index.html's own REPOSITORY
  // SUMMARY doc comment) — only the 4-section layout itself (`.rs-*`) is new.
  import { repoSummaryCtrl } from "./reposummary.svelte.ts";
  import { t } from "../../i18n/i18n.svelte.ts";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && repoSummaryCtrl.open) repoSummaryCtrl.close();
  }

  function pct(n: number, total: number): number {
    return Math.round((100 * n) / (total || 1));
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={repoSummaryCtrl.open}>
  <div class="modal reposummary">
    <div class="modal-head">
      <div class="modal-tama"><img class="tama-pic" src={repoSummaryCtrl.tamaImg} alt="Tama, curious" /></div>
      <div>
        <h3>{t("reposummary.title")}</h3>
        <p>
          {t("reposummary.subtitle_pre")}<code>git log</code>{t("reposummary.subtitle_post")}
        </p>
      </div>
    </div>
    <div class="modal-body">
      {#if repoSummaryCtrl.loading}
        <div class="log-row"><span class="spinner"></span><span class="msg mut">{t("reposummary.loading")}</span></div>
      {:else if repoSummaryCtrl.error}
        <div class="log-row"><span class="ic">&#9888;</span><span class="msg mut">{repoSummaryCtrl.error}</span></div>
      {:else if !repoSummaryCtrl.summary || repoSummaryCtrl.summary.totalCommits === 0}
        <div class="log-row">
          <span class="msg mut">{t("reposummary.none", { days: repoSummaryCtrl.summary?.windowDays ?? 365 })}</span>
        </div>
      {:else}
        {@const s = repoSummaryCtrl.summary}
        <section class="rs-section">
          <h4>{t("reposummary.churn_title")} <span class="mut" style="font-weight:400;font-size:11px">{t("reposummary.churn_sub", { days: s.windowDays })}</span></h4>
          {#if s.churn.length === 0}
            <p class="mut">{t("reposummary.churn_empty")}</p>
          {:else}
            <div class="rs-list">
              {#each s.churn as f (f.path)}
                <div class="rs-row">
                  <span class="rs-path mono">{f.path}</span>
                  <div class="stat-bar"><i class="a" style="width:{pct(f.touches, s.churn[0].touches)}%"></i></div>
                  <span class="rs-count mono mut">{f.touches}</span>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="rs-section">
          <h4>{t("reposummary.contributors_title")} <span class="rs-chip">{t("reposummary.bus_factor", { n: s.busFactor })}</span></h4>
          {#if s.contributors.length === 0}
            <p class="mut">{t("reposummary.contributors_empty")}</p>
          {:else}
            <div class="rs-list">
              {#each s.contributors as c (c.name + c.email)}
                <div class="rs-row">
                  <span class="rs-path">{c.name} <span class="mut">&lt;{c.email}&gt;</span></span>
                  <div class="stat-bar"><i class="a" style="width:{pct(c.commits, s.contributors[0].commits)}%"></i></div>
                  <span class="rs-count mono mut">{c.commits}</span>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="rs-section">
          <h4>{t("reposummary.monthly_title")}</h4>
          {#if s.monthly.length === 0}
            <p class="mut">{t("reposummary.monthly_empty")}</p>
          {:else}
            {@const maxMonthly = Math.max(1, ...s.monthly.map((m) => m.commits))}
            <div class="rs-months">
              {#each s.monthly as m (m.month)}
                <div class="rs-month">
                  <div class="rs-month-bar" style="height:{pct(m.commits, maxMonthly)}%" title={t("reposummary.month_tooltip", { month: m.month, n: m.commits })}></div>
                  <span class="rs-month-label mut">{m.month}</span>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="rs-section">
          <h4>{t("reposummary.problem_title")}</h4>
          <p class="mut fh-caveat" title={t("reposummary.problem_caveat_title")}>
            &#9432; {t("reposummary.problem_caveat")}
          </p>
          {#if s.problemAreas.revertOrHotfixCommits > 0}
            <p class="mut">
              {t("reposummary.problem_reverts", {
                n: s.problemAreas.revertOrHotfixCommits,
                total: s.problemAreas.totalCommits,
                pct: pct(s.problemAreas.revertOrHotfixCommits, s.problemAreas.totalCommits),
              })}
            </p>
          {/if}
          {#if s.problemAreas.files.length === 0}
            <p class="mut">{t("reposummary.problem_empty")}</p>
          {:else}
            <div class="rs-list">
              {#each s.problemAreas.files as f (f.path)}
                <div class="rs-row">
                  <span class="rs-path mono">{f.path}</span>
                  <div class="stat-bar"><i class="d" style="width:{pct(f.bugfixTouches, s.problemAreas.files[0].bugfixTouches)}%"></i></div>
                  <span class="rs-count mono mut">{f.bugfixTouches}/{f.totalTouches}</span>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        {#if s.truncated}
          <p class="mut">{t("reposummary.truncated")}</p>
        {/if}
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" onclick={() => repoSummaryCtrl.close()}>{t("common.close")}</button>
    </div>
  </div>
</div>
