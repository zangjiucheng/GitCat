<script lang="ts">
  import { detailCtrl, type TreeDir } from "./detail.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import { workdirCtrl } from "../workdir/workdir.svelte.ts";
  import Workdir from "../workdir/Workdir.svelte";
  import { resolver } from "../resolver/resolver.svelte.ts";
  import { dashboardCtrl } from "../dashboard/dashboard.svelte.ts";
  import { settingsCtrl } from "../settings/settings.svelte.ts";
  import { fade } from "svelte/transition";
  import Folder from "@lucide/svelte/icons/folder";
  import Eye from "@lucide/svelte/icons/eye";
  import History from "@lucide/svelte/icons/history";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import Maximize2 from "@lucide/svelte/icons/maximize-2";

  // Matches TamaMascot's own `this.reduced` check (src/legacy/main.ts) —
  // Svelte's transition: directives don't honor prefers-reduced-motion on
  // their own (they animate via inline styles, not CSS the reduced-motion
  // media query in index.html can override), so this needs its own check.
  const REDUCE_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // BUG FIX: #diffview is a static element (only its CHILDREN are swapped by
  // the {#if diffLoading}/{#each diffRows} below) — switching to a different
  // file within the SAME commit reuses that same DOM node, so the browser
  // keeps whatever scrollLeft/scrollTop it already had from the PREVIOUS
  // file's diff. A long line you'd scrolled right to read, or a long diff
  // you'd scrolled down into, then silently carried over onto the next
  // file's diff too — hiding its line-number/mark columns and its own
  // topmost rows behind the stale offset, reading as truncated/missing
  // content rather than "just scrolled". (Switching COMMITS doesn't have
  // this problem: the whole block above is wrapped in {#key c.sha}, which
  // destroys and recreates #diffview from scratch on every commit change —
  // this effect only needed for the same-commit, different-file case.)
  let diffviewEl = $state<HTMLDivElement | undefined>(undefined);
  $effect(() => {
    detailCtrl.selectedFile;
    if (diffviewEl) {
      diffviewEl.scrollLeft = 0;
      diffviewEl.scrollTop = 0;
    }
  });

  // Second copy of the same reset, for the expanded-diff modal's own
  // .diffview instance (see the expand button in .diff-file-h below) — a
  // separate DOM node with its own independent scrollLeft/scrollTop, so it
  // needs its own bind:this/effect pair rather than sharing diffviewEl's.
  let diffviewExpandedEl = $state<HTMLDivElement | undefined>(undefined);
  $effect(() => {
    detailCtrl.selectedFile;
    if (diffviewExpandedEl) {
      diffviewExpandedEl.scrollLeft = 0;
      diffviewExpandedEl.scrollTop = 0;
    }
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && detailCtrl.diffExpanded) detailCtrl.collapseDiff();
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if workdirCtrl.selected}
  <Workdir />
{:else if detailCtrl.hero}
  <div class="tama-hero">
    <img class="tama-hero-img" src={bridge.TAMA_IMG.hero} alt={detailCtrl.hero.kind === "empty" ? "Tama" : "Tama, GitCat's guardian"} />
    {#if detailCtrl.hero.kind === "loaded"}
      {#if settingsCtrl.tamaEnabled}
        <div class="hero-bubble">
          はじめまして! I'm <b>Tama</b>, GitCat's guardian. I pin a snapshot before every mutation — so your history is always safe with
          me. <span class="jp">にゃ〜♪</span>
        </div>
      {:else}
        <div class="hero-bubble">A snapshot is taken before every mutation — your history is always safe.</div>
      {/if}
      <div class="hero-stat"><span class="n">{detailCtrl.hero.n.toLocaleString()}</span> commits laid out in <b>{detailCtrl.hero.ms.toFixed(0)} ms</b></div>
      <div class="hero-hint">Click a commit to inspect it &#183; drag a dot onto another to cherry-pick &#183; &#8984;Z to rewind</div>
    {:else}
      {#if settingsCtrl.tamaEnabled}
        <div class="hero-bubble">はじめまして! I'm <b>Tama</b>. Open a Git repository and I'll lay out its whole history in a blink. <span class="jp">にゃ〜♪</span></div>
      {:else}
        <div class="hero-bubble">Open a Git repository to get started.</div>
      {/if}
      <div style="margin-top:2px;display:flex;align-items:center;gap:8px;justify-content:center">
        <!-- Single entry point (was two: a direct native-picker button plus a
             separate "Repositories…" dashboard button) — both behaviors now
             live inside the ONE dashboard modal (recent/tracked repos list +
             its own "+ Add repository…" native picker), so there's one
             consistent "open a repository" action everywhere it's offered,
             not a picker-vs-modal split depending on which button you click.
             See dashboard.svelte.ts's addRepository() for why picking a
             brand-new folder from inside the modal still opens it
             immediately when reached from here (no repo open yet). -->
        <button class="btn" id="openRepoBtn" onclick={() => dashboardCtrl.show()}><Folder class="ico" size={14} aria-hidden="true" /> Open a repository&#8230;</button>
      </div>
      <div class="hero-hint">or click the repo name <b>&#9662;</b> in the top bar</div>
    {/if}
  </div>
{:else if detailCtrl.commit}
  {@const c = detailCtrl.commit}
  {@const gpg = detailCtrl.gpgBadge}
  {@const cov = detailCtrl.coverage}
  <!-- Keyed on sha so switching commits re-mounts (and fades) this wrapper
       instead of every field just snapping to new values in place — a
       plain DOM/opacity transition, no canvas involvement. Scoped to the
       outer wrapper only (not per-diff-line): this island can render a
       large file tree/diff, so re-triggering a transition per-line would
       be wasteful, not just unnecessary. -->
  {#key c.sha}
  <div transition:fade={{ duration: REDUCE_MOTION ? 0 : 120 }}>
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
      <div class="who" class:differ={c.differ}><h4>Author</h4><div class="nm">{c.an.n}</div><div class="em">{c.an.e}</div><div class="dt mono">{c.an.d}</div><div class="dt-abs mono">{c.an.abs}</div></div>
      <div class="who" class:differ={c.differ}><h4>Committer</h4><div class="nm">{c.cm.n}</div><div class="em">{c.cm.e}</div><div class="dt mono">{c.cm.d}</div><div class="dt-abs mono">{c.cm.abs}</div></div>
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
    <div class="diffview" id="diffview" bind:this={diffviewEl}>
      {#if detailCtrl.diffLoading}
        <div class="diff-file-h mut"><span class="spinner"></span> loading diff&#8230;</div>
      {:else}
        <div class="diff-file-h">
          <span class="diff-file-h-name">{detailCtrl.diffHeader}</span>
          <button class="wd-act" title="Expand diff" aria-label="Expand diff to full page" onclick={() => detailCtrl.expandDiff()}>
            <Maximize2 class="ico" size={13} aria-hidden="true" />
          </button>
        </div>
        <div class="diff-rows">{@render diffLineRows()}</div>
      {/if}
    </div>
  </section>
  </div>
  {/key}

  <!-- Full-page diff popup — same detailCtrl.diffHeader/diffRows/tree the
       embedded .diffview above renders, just laid out at near-fullscreen
       size (see .modal.diffx's own doc comment in index.html) so a real
       changeset isn't stuck reading through .diffview's cramped 320px cap. -->
  <div class="scrim" class:on={detailCtrl.diffExpanded}>
    <div class="modal diffx">
      <div class="modal-head">
        <div class="diffx-head-main">
          <h3>{c.subject}</h3>
          <p>commit <span class="mono">{c.sha.slice(0, 7)}</span></p>
        </div>
      </div>
      <div class="modal-body diffx-body">
        <div class="diffx-files tree" data-vimnav-list>
          {#if detailCtrl.treeLoading}
            <div class="mut" style="padding:6px 4px"><span class="spinner"></span> loading files&#8230;</div>
          {:else if !detailCtrl.tree.files.length && !Object.keys(detailCtrl.tree.dirs).length}
            <div class="mut" style="padding:6px 4px">no file changes</div>
          {:else}
            {@render dirNode(detailCtrl.tree)}
          {/if}
        </div>
        <div class="diffview diffx-diff" bind:this={diffviewExpandedEl}>
          {#if detailCtrl.diffLoading}
            <div class="diff-file-h mut"><span class="spinner"></span> loading diff&#8230;</div>
          {:else}
            <div class="diff-file-h"><span class="diff-file-h-name">{detailCtrl.diffHeader}</span></div>
            <div class="diff-rows">{@render diffLineRows()}</div>
          {/if}
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" onclick={() => detailCtrl.collapseDiff()}>Close</button>
      </div>
    </div>
  </div>
{/if}

{#snippet diffLineRows()}
  {#each detailCtrl.diffRows as row}
    {#if row.kind === "hunk"}
      <div class="diff-line hunk"><span class="ln"></span><span class="mk"></span><code>{row.text}</code></div>
    {:else if row.kind === "note"}
      <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut">{row.text}</code></div>
    {:else}
      <div class="diff-line {row.cls}"><span class="ln">{row.ln}</span><span class="mk">{row.mk}</span><code>{@html row.html}</code></div>
    {/if}
  {/each}
{/snippet}

{#snippet dirNode(node: TreeDir)}
  {#each Object.entries(node.dirs) as [name, child]}
    <details class="dir" open>
      <summary><span class="tw">&#9656;</span><Folder class="ico" size={13} aria-hidden="true" /> {name}</summary>
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
      <span class="fname">{f.name}</span>
      <span class="badge"><span class="add">+{f.add}</span> <span class="del">&minus;{f.del}</span></span>
      {#if detailCtrl.resolvingDeletedFileFor === f.p}
        <span class="spinner"></span>
      {:else}
        <button
          class="wd-act"
          title="Blame"
          aria-label="Blame {f.p}"
          onclick={(e) => {
            e.stopPropagation();
            detailCtrl.blameFile(f);
          }}><Eye class="ico" size={14} aria-hidden="true" /></button
        >
        <button
          class="wd-act"
          title="History"
          aria-label="History {f.p}"
          onclick={(e) => {
            e.stopPropagation();
            detailCtrl.historyFile(f);
          }}><History class="ico" size={14} aria-hidden="true" /></button
        >
      {/if}
      <button
        class="wd-act"
        title="Open in external diff"
        aria-label="Open in external diff for {f.p}"
        onclick={(e) => {
          e.stopPropagation();
          detailCtrl.openExternalDiff(f);
        }}><ExternalLink class="ico" size={14} aria-hidden="true" /></button
      >
    </div>
  {/each}
{/snippet}
