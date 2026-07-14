<script lang="ts">
  // Repository Summary — view. Deliberately no bespoke <style> block for the
  // shared chrome: reuses `.scrim`/`.modal`/`.modal-head`/`.modal-body`/
  // `.modal-foot`/`.btn.ghost`/`.log-row`/`.mono`/`.mut`/`.spinner`/
  // `.stat-bar`/`.fh-caveat` verbatim (see index.html's own REPOSITORY
  // SUMMARY doc comment) — only the 4-section layout itself (`.rs-*`) is new.
  import { repoSummaryCtrl } from "./reposummary.svelte.ts";

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
        <h3>Repository Summary</h3>
        <p>
          A quick orientation from <code>git log</code> itself: which files see the most churn, who's actually maintaining this repo,
          how active it's been over time, and where the recurring trouble spots are.
        </p>
      </div>
    </div>
    <div class="modal-body">
      {#if repoSummaryCtrl.loading}
        <div class="log-row"><span class="spinner"></span><span class="msg mut">Reading git log&#8230; this can take a moment on a large repo.</span></div>
      {:else if repoSummaryCtrl.error}
        <div class="log-row"><span class="ic">&#9888;</span><span class="msg mut">{repoSummaryCtrl.error}</span></div>
      {:else if !repoSummaryCtrl.summary || repoSummaryCtrl.summary.totalCommits === 0}
        <div class="log-row">
          <span class="msg mut">No commits in the last {repoSummaryCtrl.summary?.windowDays ?? 365} days &#8212; nothing to summarize yet.</span>
        </div>
      {:else}
        {@const s = repoSummaryCtrl.summary}
        <section class="rs-section">
          <h4>Churn Hotspots <span class="mut" style="font-weight:400;font-size:11px">most-changed files, last {s.windowDays} days</span></h4>
          {#if s.churn.length === 0}
            <p class="mut">No file changes in this window.</p>
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
          <h4>Contributors <span class="rs-chip">Bus factor: {s.busFactor}</span></h4>
          {#if s.contributors.length === 0}
            <p class="mut">No contributors in this window.</p>
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
          <h4>Monthly Activity</h4>
          {#if s.monthly.length === 0}
            <p class="mut">No commits in this window.</p>
          {:else}
            {@const maxMonthly = Math.max(1, ...s.monthly.map((m) => m.commits))}
            <div class="rs-months">
              {#each s.monthly as m (m.month)}
                <div class="rs-month">
                  <div class="rs-month-bar" style="height:{pct(m.commits, maxMonthly)}%" title="{m.month}: {m.commits} commit{m.commits === 1 ? '' : 's'}"></div>
                  <span class="rs-month-label mut">{m.month}</span>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="rs-section">
          <h4>Problem Areas</h4>
          <p class="mut fh-caveat" title="Keyword-based heuristic over commit subjects (fix/bug/hotfix/regression/revert/…) — not a classifier. Real false positives and false negatives are expected.">
            &#9432; heuristic, not a precise classifier
          </p>
          {#if s.problemAreas.revertOrHotfixCommits > 0}
            <p class="mut">
              {s.problemAreas.revertOrHotfixCommits} of {s.problemAreas.totalCommits} commits ({pct(s.problemAreas.revertOrHotfixCommits, s.problemAreas.totalCommits)}%)
              were reverts or hotfixes.
            </p>
          {/if}
          {#if s.problemAreas.files.length === 0}
            <p class="mut">No recurring problem files found.</p>
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
          <p class="mut">&#8230; truncated (capped) &#8212; showing a partial picture of a very large history.</p>
        {/if}
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" onclick={() => repoSummaryCtrl.close()}>Close</button>
    </div>
  </div>
</div>
