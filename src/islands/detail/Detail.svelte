<script lang="ts">
  import { detailCtrl, type TreeDir } from "./detail.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import { workdirCtrl } from "../workdir/workdir.svelte.ts";
  import Workdir from "../workdir/Workdir.svelte";
  import { resolver } from "../resolver/resolver.svelte.ts";
  import { dashboardCtrl } from "../dashboard/dashboard.svelte.ts";
</script>

{#if workdirCtrl.selected}
  <Workdir />
{:else if detailCtrl.hero}
  <div class="tama-hero">
    <img class="tama-hero-img" src={bridge.TAMA_IMG.hero} alt={detailCtrl.hero.kind === "empty" ? "Tama" : "Tama, GitCat's guardian"} />
    {#if detailCtrl.hero.kind === "loaded"}
      <div class="hero-bubble">
        はじめまして! I'm <b>Tama</b>, GitCat's guardian. I pin a snapshot before every mutation — so your history is always safe with
        me. <span class="jp">にゃ〜♪</span>
      </div>
      <div class="hero-stat"><span class="n">{detailCtrl.hero.n.toLocaleString()}</span> commits laid out in <b>{detailCtrl.hero.ms.toFixed(0)} ms</b></div>
      <div class="hero-hint">Click a commit to inspect it &#183; drag a dot onto another to cherry-pick &#183; &#8984;Z to rewind</div>
    {:else}
      <div class="hero-bubble">はじめまして! I'm <b>Tama</b>. Open a Git repository and I'll lay out its whole history in a blink. <span class="jp">にゃ〜♪</span></div>
      <div style="margin-top:2px;display:flex;align-items:center;gap:8px;justify-content:center">
        <button class="btn" id="openRepoBtn" onclick={() => bridge.pickRepo()}>&#128193; Open a repository&#8230;</button>
        <!-- Multi-repo dashboard (backlog #11): the empty-hero card's second
             entry point, alongside the Tools menu/⌘K — reachable here too
             since a fresh/no-repo launch is arguably the MORE useful moment
             to jump straight into a previously tracked repo instead of
             re-browsing for one via the native picker. -->
        <button class="btn ghost" onclick={() => dashboardCtrl.show()}>&#128194; Repositories&#8230;</button>
      </div>
      <div class="hero-hint">or click the repo name <b>&#9662;</b> in the top bar</div>
    {/if}
  </div>
{:else if detailCtrl.commit}
  {@const c = detailCtrl.commit}
  {@const gpg = detailCtrl.gpgBadge}
  {@const cov = detailCtrl.coverage}
  <section>
    <div class="d-subject">{c.subject}</div>
    <div class="d-body" id="dBody">
      {#if detailCtrl.bodyText === "loading…"}
        <span class="mut">loading&#8230;</span>
      {:else}
        {detailCtrl.bodyText}
      {/if}
    </div>
    <div class="id-strip">
      <span
        class="hash"
        id="hashCopy"
        title="Click to copy"
        role="button"
        tabindex="0"
        onclick={() => detailCtrl.copySha()}
        onkeydown={(e) => (e.key === "Enter" || e.key === " ") && detailCtrl.copySha()}
        >{detailCtrl.copied ? "copied ✓" : c.sha}</span
      >
      <span class="gpg {gpg[0]}">{gpg[1]}</span>
      <span class="mut mono" style="font-size:11px">row {c.row.toLocaleString()} / {(bridge.G?.N ?? 0).toLocaleString()}</span>
    </div>
    <button
      class="btn ghost"
      id="revertCommitBtn"
      style="margin-top:8px"
      disabled={detailCtrl.revertDisabled}
      title={c.merge ? "Can't revert a merge commit" : undefined}
      onclick={() => detailCtrl.revertCommit()}
      >{#if resolver.busy}<span class="spinner"></span>{/if}&#8617; Revert commit</button
    >
  </section>
  <section>
    <div class="who-split">
      <div class="who" class:differ={c.differ}><h4>Author</h4><div class="nm">{c.an.n}</div><div class="em">{c.an.e}</div><div class="dt mono">{c.an.d}</div></div>
      <div class="who" class:differ={c.differ}><h4>Committer</h4><div class="nm">{c.cm.n}</div><div class="em">{c.cm.e}</div><div class="dt mono">{c.cm.d}</div></div>
    </div>
    {#if c.differ}
      <div class="mut" style="font-size:11px;margin-top:6px">&#9888; author &ne; committer (patch applied / rebased) &#8212; the teaching point cherry-pick &amp; rebase create.</div>
    {/if}
  </section>
  <section>
    <h4 class="d-lab">Refs pointing here</h4>
    <div class="refs-here">
      {#if c.refs.length}
        {#each c.refs as r}<span class="row-chip {r.t}">{r.n}</span>{/each}
      {:else}
        <span class="mut">no refs point here</span>
      {/if}
    </div>
    {#if cov}
      <div class="covered">
        <span class="ck"></span>
        <div>
          Covered by snapshot <b>backup/&#8230;{cov.ago} ago</b><br /><span class="mut">reachable via a Safety-Manager backup ref &#8212; &#8984;Z can rewind here.</span>
        </div>
      </div>
    {/if}
  </section>
  <section>
    <h4 class="d-lab">Changes</h4>
    <div class="diffstat" id="diffstat">
      {#if detailCtrl.diffLoading}
        <span class="mut mono" style="font-size:11px"><span class="spinner"></span> loading diff&#8230;</span>
      {:else if detailCtrl.diffstat}
        {@const s = detailCtrl.diffstat}
        <span class="nums"><span class="add">+{s.add}</span> <span class="del">&minus;{s.del}</span></span>
        <div class="stat-bar">
          <i class="a" style="width:{Math.round((100 * s.add) / ((s.add + s.del) || 1))}%"></i>
          <i class="d" style="width:{Math.round((100 * s.del) / ((s.add + s.del) || 1))}%"></i>
        </div>
        <span class="mut mono" style="font-size:11px">{s.files} file{s.files === 1 ? "" : "s"}{s.truncated ? " (capped)" : ""}</span>
      {/if}
    </div>
    <div class="tree" id="tree" data-vimnav-list>
      {#if detailCtrl.treeLoading}
        <div class="mut" style="padding:6px 4px"><span class="spinner"></span> loading files&#8230;</div>
      {:else if !detailCtrl.tree.files.length && !Object.keys(detailCtrl.tree.dirs).length}
        <div class="mut" style="padding:6px 4px">no file changes</div>
      {:else}
        {@render dirNode(detailCtrl.tree)}
      {/if}
    </div>
  </section>
  <section>
    <h4 class="d-lab">Diff</h4>
    <div class="diffview" id="diffview">
      {#if detailCtrl.diffLoading}
        <div class="diff-file-h mut"><span class="spinner"></span> loading diff&#8230;</div>
      {:else}
        <div class="diff-file-h">{detailCtrl.diffHeader}</div>
        {#each detailCtrl.diffRows as row}
          {#if row.kind === "hunk"}
            <div class="diff-line hunk"><span class="ln"></span><span class="mk"></span><code>{row.text}</code></div>
          {:else if row.kind === "note"}
            <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut">{row.text}</code></div>
          {:else}
            <div class="diff-line {row.cls}"><span class="ln">{row.ln}</span><span class="mk">{row.mk}</span><code>{@html row.html}</code></div>
          {/if}
        {/each}
      {/if}
    </div>
  </section>
{/if}

{#snippet dirNode(node: TreeDir)}
  {#each Object.entries(node.dirs) as [name, child]}
    <details class="dir" open>
      <summary><span class="tw">&#9656;</span>&#128193; {name}</summary>
      <div class="indent">{@render dirNode(child)}</div>
    </details>
  {/each}
  {#each node.files as f}
    <div
      class="file"
      class:active={f.p === detailCtrl.selectedFile}
      onclick={() => detailCtrl.selectFile(f.p)}
      role="button"
      tabindex="0"
      onkeydown={(e) => (e.key === "Enter" || e.key === " ") && detailCtrl.selectFile(f.p)}
    >
      <span class="st {f.st === 'A' ? 'A' : f.st === 'D' ? 'D' : 'M'}">{f.st}</span>
      <span>{f.name}</span>
      <span class="badge"><span class="add">+{f.add}</span> <span class="del">&minus;{f.del}</span></span>
      <button
        class="wd-act"
        title="Blame"
        aria-label="Blame {f.p}"
        onclick={(e) => {
          e.stopPropagation();
          detailCtrl.blameFile(f);
        }}>&#128065;</button
      >
      <button
        class="wd-act"
        title="History"
        aria-label="History {f.p}"
        onclick={(e) => {
          e.stopPropagation();
          detailCtrl.historyFile(f);
        }}>&#128336;</button
      >
      <button
        class="wd-act"
        title="Open in external diff"
        aria-label="Open in external diff for {f.p}"
        onclick={(e) => {
          e.stopPropagation();
          detailCtrl.openExternalDiff(f);
        }}>&#8646;</button
      >
    </div>
  {/each}
{/snippet}
