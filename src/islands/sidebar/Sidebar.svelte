<script lang="ts">
  import { sidebarCtrl } from "./sidebar.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import type { SimpleRef } from "../../ipc/bindings";

  let menuEl: HTMLDivElement | undefined = $state();
  let newBranchEl: HTMLInputElement | undefined = $state();
  let newBranchFormEl: HTMLDivElement | undefined = $state();

  function onWindowPointerdown(e: PointerEvent) {
    if (sidebarCtrl.menu && menuEl && !menuEl.contains(e.target as Node)) sidebarCtrl.closeMenu();
    // Outside-click cancels the New Branch form — NOT onblur on the name
    // input, which would fire (and wrongly cancel everything) the instant
    // focus moves to the "from" <select> sitting right next to it.
    if (sidebarCtrl.newBranchOpen && newBranchFormEl && !newBranchFormEl.contains(e.target as Node)) sidebarCtrl.cancelNewBranch();
  }

  $effect(() => {
    if (sidebarCtrl.newBranchOpen) requestAnimationFrame(() => newBranchEl?.focus());
  });

  function onNewBranchKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") sidebarCtrl.confirmNewBranch();
    else if (e.key === "Escape") sidebarCtrl.cancelNewBranch();
  }

  // Safety Manager snapshots before every mutation, so a long session can
  // realistically accumulate hundreds — cap the rendered rows for a non-
  // virtualized list, but say so (the trailing "+N more" row) rather than
  // silently dropping the tail like the old slice(0, 12) did, which let the
  // count badge and the visible rows quietly disagree.
  const SNAP_CAP = 50;

  function matches(name: string): boolean {
    const q = sidebarCtrl.filter.trim().toLowerCase();
    return !q || name.toLowerCase().includes(q);
  }

  // Group remotes by their prefix before the first "/" (mirrors the legacy
  // remote-head divider: a new header whenever the top-level name changes).
  function remoteGroups(remotes: SimpleRef[]): { head: string; items: SimpleRef[] }[] {
    const out: { head: string; items: SimpleRef[] }[] = [];
    for (const r of remotes) {
      const head = r.name.split("/")[0];
      const last = out[out.length - 1];
      if (last && last.head === head) last.items.push(r);
      else out.push({ head, items: [r] });
    }
    return out;
  }
</script>

<svelte:window onpointerdown={onWindowPointerdown} />

{#if !sidebarCtrl.hasRepo}
  <div class="sidebar-empty">
    <div class="ic">&#128193;</div>
    <div class="t">No repository open</div>
    <div class="sub">Branches, remotes, and snapshots will show up here once you open one.</div>
    <button class="btn" onclick={() => bridge.pickRepo()}>&#128193; Open a repository&#8230;</button>
  </div>
{:else}
<div class="ref-filter">
  <span class="mag">&#9906;</span>
  <input id="refFilter" placeholder="Filter refs&#8230;" spellcheck="false" bind:value={sidebarCtrl.filter} />
</div>
<div class="ref-scroll" id="refScroll">
  <details class="ref-group" open>
    <summary><span class="tw">&#9656;</span>Local<span class="count" id="cntLocal">{sidebarCtrl.locals.length}</span></summary>
    <div class="ref-list" id="refLocal">
      {#each sidebarCtrl.locals.filter((b) => matches(b.name)) as b (b.name)}
        {@const isCur = b.name === sidebarCtrl.head}
        <div
          class="ref-item"
          class:current={isCur}
          data-branch={b.name}
          role="button"
          tabindex="0"
          onclick={(e) => {
            if ((e.target as HTMLElement).closest(".ref-menu") || isCur) return;
            sidebarCtrl.checkout(b.name);
          }}
          onkeydown={(e) => (e.key === "Enter" || e.key === " ") && !isCur && sidebarCtrl.checkout(b.name)}
          oncontextmenu={(e) => {
            e.preventDefault();
            sidebarCtrl.openMenu(b.name, isCur, e.currentTarget as HTMLElement);
          }}
        >
          <span class="rname">{b.name}</span>
          {#if b.ahead || b.behind}
            <span class="ab">
              {#if b.ahead}<span class="up">&#8593;{b.ahead}</span>{/if}
              {#if b.behind}<span class="dn">&#8595;{b.behind}</span>{/if}
            </span>
          {/if}
          <button
            class="ref-menu"
            title="Branch actions"
            aria-label="Branch actions"
            onclick={(e) => {
              e.stopPropagation();
              sidebarCtrl.openMenu(b.name, isCur, e.currentTarget as HTMLElement);
            }}>&#8942;</button
          >
        </div>
      {/each}
      {#if sidebarCtrl.newBranchOpen}
        <div class="nb-form" bind:this={newBranchFormEl}>
          <input
            class="nb-input"
            bind:this={newBranchEl}
            bind:value={sidebarCtrl.newBranchInput}
            placeholder="branch name&#8230;"
            spellcheck="false"
            autocomplete="off"
            onkeydown={onNewBranchKeydown}
          />
          <select class="nb-from" bind:value={sidebarCtrl.newBranchFrom} title="Branch from" onkeydown={onNewBranchKeydown}>
            <option value="">from HEAD (current)</option>
            {#if sidebarCtrl.locals.length}
              <optgroup label="Local">
                {#each sidebarCtrl.locals as b (b.name)}
                  <option value={b.name}>{b.name}</option>
                {/each}
              </optgroup>
            {/if}
            {#if sidebarCtrl.remotes.length}
              <optgroup label="Remote">
                {#each sidebarCtrl.remotes as r (r.name)}
                  <option value={r.name}>{r.name}</option>
                {/each}
              </optgroup>
            {/if}
          </select>
        </div>
      {:else}
        <div class="ref-item new-branch" role="button" tabindex="0" onclick={() => sidebarCtrl.startNewBranch()} onkeydown={(e) => (e.key === "Enter" || e.key === " ") && sidebarCtrl.startNewBranch()}>
          <span class="rname nb">&#65291; New branch&#8230;</span>
        </div>
      {/if}
    </div>
  </details>
  <details class="ref-group" open>
    <summary><span class="tw">&#9656;</span>Remote<span class="count" id="cntRemote">{sidebarCtrl.remotes.length}</span></summary>
    <div class="ref-list" id="refRemote">
      {#each remoteGroups(sidebarCtrl.remotes.filter((r) => matches(r.name))) as g, gi (g.head + gi)}
        <div class="remote-head">&#9729; {g.head}</div>
        {#each g.items as r (r.name)}
          <div
            class="ref-item"
            role="button"
            tabindex="0"
            data-tip={r.name}
            onclick={() => sidebarCtrl.checkoutRemote(r.name)}
            onkeydown={(e) => (e.key === "Enter" || e.key === " ") && sidebarCtrl.checkoutRemote(r.name)}
          >
            <span class="dot" style="background:var(--l{gi % 7})"></span><span class="rname">{r.name}</span>
          </div>
        {/each}
      {/each}
    </div>
  </details>
  <details class="ref-group">
    <summary><span class="tw">&#9656;</span>Tags<span class="count" id="cntTags">{sidebarCtrl.tags.length}</span></summary>
    <div class="ref-list" id="refTags">
      {#each sidebarCtrl.tags.filter((t) => matches(t.name)) as t (t.name)}
        <div class="ref-item"><span class="rname">{t.name}</span></div>
      {/each}
    </div>
  </details>
  <details class="ref-group">
    <summary><span class="tw">&#9656;</span>Stashes<span class="count">2</span></summary>
    <div class="ref-item"><span class="rname mono">stash@{"{0}"}</span></div>
    <div class="ref-item"><span class="rname mono">stash@{"{1}"}</span></div>
  </details>
  <details class="ref-group">
    <summary><span class="tw">&#9656;</span>Snapshots<span class="count" id="snapCount">{sidebarCtrl.snapshots.length || "—"}</span></summary>
    <div class="ref-list" id="refSnaps">
      {#if !sidebarCtrl.snapshots.length}
        <div class="ref-item"><span class="rname mut">no snapshots yet</span></div>
      {:else}
        {#each sidebarCtrl.snapshots.slice(0, SNAP_CAP) as s (s.ref)}
          {@const sha7 = (s.sha || "").slice(0, 7) || "snapshot"}
          <div class="snap-item" data-tip={new Date(s.ts * 1000).toLocaleString()}>
            <span class="dot" style="background:var(--accent)"></span>
            <div class="snap-main">
              <span class="snap-subject">{s.subject || "(no message)"}</span>
              <span class="snap-meta">
                <button class="snap-sha" onclick={() => sidebarCtrl.copySnapshotSha(s.sha)}>{sidebarCtrl.copiedSnapshotSha === s.sha ? "copied ✓" : sha7}</button>
                <span class="mut">&#183; {bridge.relTime(s.ts).replace(" ago", "")}</span>
              </span>
            </div>
          </div>
        {/each}
        {#if sidebarCtrl.snapshots.length > SNAP_CAP}
          <div class="ref-item"><span class="rname mut">+{sidebarCtrl.snapshots.length - SNAP_CAP} more &#183; newest shown first</span></div>
        {/if}
      {/if}
    </div>
  </details>
</div>
{/if}

{#if sidebarCtrl.menu}
  {@const menu = sidebarCtrl.menu}
  <div class="ref-pop" bind:this={menuEl} style="left:{menu.x}px;top:{menu.y}px">
    <!-- Capture menu.name into a local BEFORE closeMenu() — closeMenu() nulls
         sidebarCtrl.menu, and reading menu.name afterward (closeMenu() first,
         action call second) threw "Cannot read properties of null" on every
         one of these three actions since the very first version of this
         island: `menu` above isn't a frozen snapshot, it re-derives from the
         live sidebarCtrl.menu state on each read. -->
    <button disabled={menu.isCurrent} onclick={() => { const name = menu.name; sidebarCtrl.closeMenu(); sidebarCtrl.checkout(name); }}>Checkout</button>
    {#if !menu.isCurrent}
      <button onclick={() => { const name = menu.name; sidebarCtrl.closeMenu(); sidebarCtrl.rebaseOnto(name); }}>Rebase current branch onto here</button>
    {/if}
    <button class="danger" disabled={menu.isCurrent} onclick={() => { const name = menu.name; sidebarCtrl.closeMenu(); sidebarCtrl.deleteBranch(name); }}>Delete&#8230;</button>
  </div>
{/if}
