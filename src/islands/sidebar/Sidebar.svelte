<script lang="ts">
  import { sidebarCtrl } from "./sidebar.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import type { SimpleRef } from "../../ipc/bindings";

  let menuEl: HTMLDivElement | undefined = $state();
  let newBranchEl: HTMLInputElement | undefined = $state();

  function onWindowPointerdown(e: PointerEvent) {
    if (!sidebarCtrl.menu) return;
    if (menuEl && !menuEl.contains(e.target as Node)) sidebarCtrl.closeMenu();
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
        <div class="ref-item new-branch">
          <input
            class="nb-input"
            bind:this={newBranchEl}
            bind:value={sidebarCtrl.newBranchInput}
            placeholder="branch name&#8230;"
            spellcheck="false"
            autocomplete="off"
            onkeydown={onNewBranchKeydown}
            onblur={() => sidebarCtrl.cancelNewBranch()}
          />
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
          <div class="ref-item"><span class="dot" style="background:var(--l{gi % 7})"></span><span class="rname">{r.name}</span></div>
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
          <div class="ref-item">
            <span class="dot" style="background:var(--accent)"></span>
            <span class="rname mono">{(s.sha || "").slice(0, 7) || "snapshot"}</span>
            <span class="ab">{bridge.relTime(s.ts).replace(" ago", "")}</span>
          </div>
        {/each}
        {#if sidebarCtrl.snapshots.length > SNAP_CAP}
          <div class="ref-item"><span class="rname mut">+{sidebarCtrl.snapshots.length - SNAP_CAP} more &#183; newest shown first</span></div>
        {/if}
      {/if}
    </div>
  </details>
</div>

{#if sidebarCtrl.menu}
  {@const menu = sidebarCtrl.menu}
  <div class="ref-pop" bind:this={menuEl} style="left:{menu.x}px;top:{menu.y}px">
    <button disabled={menu.isCurrent} onclick={() => { sidebarCtrl.closeMenu(); sidebarCtrl.checkout(menu.name); }}>Checkout</button>
    {#if !menu.isCurrent}
      <button onclick={() => { sidebarCtrl.closeMenu(); sidebarCtrl.rebaseOnto(menu.name); }}>Rebase current branch onto here</button>
    {/if}
    <button class="danger" disabled={menu.isCurrent} onclick={() => { sidebarCtrl.closeMenu(); sidebarCtrl.deleteBranch(menu.name); }}>Delete&#8230;</button>
  </div>
{/if}
