<script lang="ts">
  import { sidebarCtrl, submoduleAction, submoduleCanOpen, SUBMODULES_ALL, SUBMODULES_SYNC_ALL } from "./sidebar.svelte.ts";
  import { remotesCtrl } from "../remotes/remotes.svelte.ts";
  import { dashboardCtrl } from "../dashboard/dashboard.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import type { SimpleRef, SubmoduleInfo } from "../../ipc/bindings";
  import Folder from "@lucide/svelte/icons/folder";
  import Zap from "@lucide/svelte/icons/zap";
  import Clipboard from "@lucide/svelte/icons/clipboard";

  let menuEl: HTMLDivElement | undefined = $state();
  let newBranchEl: HTMLInputElement | undefined = $state();
  let newBranchFormEl: HTMLDivElement | undefined = $state();
  let tagMenuEl: HTMLDivElement | undefined = $state();
  let newTagEl: HTMLInputElement | undefined = $state();
  let newTagFormEl: HTMLDivElement | undefined = $state();
  let newSubmoduleEl: HTMLInputElement | undefined = $state();
  let newSubmoduleFormEl: HTMLDivElement | undefined = $state();
  let submoduleMenuEl: HTMLDivElement | undefined = $state();
  let mergeMenuEl: HTMLDivElement | undefined = $state();
  let dirtyCheckoutMenuEl: HTMLDivElement | undefined = $state();
  let checkoutConfirmEl: HTMLDivElement | undefined = $state();
  let pushMenuEl: HTMLDivElement | undefined = $state();
  let pushBranchInputEl: HTMLInputElement | undefined = $state();

  function onWindowPointerdown(e: PointerEvent) {
    if (sidebarCtrl.menu && menuEl && !menuEl.contains(e.target as Node)) sidebarCtrl.closeMenu();
    // Outside-click cancels the New Branch form — NOT onblur on the name
    // input, which would fire (and wrongly cancel everything) the instant
    // focus moves to the "from" <select> sitting right next to it. Blocked
    // while busy so the form (and its in-flight spinner) can't be dismissed
    // out from under a request that's already been sent.
    if (sidebarCtrl.newBranchOpen && !sidebarCtrl.busy && newBranchFormEl && !newBranchFormEl.contains(e.target as Node)) sidebarCtrl.cancelNewBranch();
    if (sidebarCtrl.tagMenu && tagMenuEl && !tagMenuEl.contains(e.target as Node)) sidebarCtrl.closeTagMenu();
    if (sidebarCtrl.newTagOpen && !sidebarCtrl.busy && newTagFormEl && !newTagFormEl.contains(e.target as Node)) sidebarCtrl.cancelNewTag();
    // Outside-click cancels the Add Submodule form — same busy-blocked
    // rationale as the New Branch/New Tag forms above.
    if (sidebarCtrl.newSubmoduleOpen && !sidebarCtrl.busy && newSubmoduleFormEl && !newSubmoduleFormEl.contains(e.target as Node)) sidebarCtrl.cancelNewSubmodule();
    if (sidebarCtrl.submoduleMenu && submoduleMenuEl && !submoduleMenuEl.contains(e.target as Node)) sidebarCtrl.closeSubmoduleMenu();
    if (sidebarCtrl.mergeMenu && mergeMenuEl && !mergeMenuEl.contains(e.target as Node)) sidebarCtrl.closeMergeMenu();
    if (sidebarCtrl.dirtyCheckoutMenu && dirtyCheckoutMenuEl && !dirtyCheckoutMenuEl.contains(e.target as Node)) sidebarCtrl.closeDirtyCheckoutMenu();
    if (sidebarCtrl.checkoutConfirm && checkoutConfirmEl && !checkoutConfirmEl.contains(e.target as Node)) sidebarCtrl.closeCheckoutConfirm();
    // Outside-click cancels the "Push to…" form — same busy-blocked
    // rationale as the New Branch/New Tag forms above.
    if (sidebarCtrl.pushMenu && !sidebarCtrl.busy && pushMenuEl && !pushMenuEl.contains(e.target as Node)) sidebarCtrl.cancelPushMenu();
  }

  $effect(() => {
    if (sidebarCtrl.newBranchOpen) requestAnimationFrame(() => newBranchEl?.focus());
  });

  $effect(() => {
    if (sidebarCtrl.newTagOpen) requestAnimationFrame(() => newTagEl?.focus());
  });

  $effect(() => {
    if (sidebarCtrl.newSubmoduleOpen) requestAnimationFrame(() => newSubmoduleEl?.focus());
  });

  $effect(() => {
    if (sidebarCtrl.pushMenu) requestAnimationFrame(() => pushBranchInputEl?.focus());
  });

  function onNewBranchKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") sidebarCtrl.confirmNewBranch();
    else if (e.key === "Escape" && !sidebarCtrl.busy) sidebarCtrl.cancelNewBranch();
  }

  function onNewTagKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") sidebarCtrl.confirmNewTag();
    else if (e.key === "Escape" && !sidebarCtrl.busy) sidebarCtrl.cancelNewTag();
  }

  function onNewSubmoduleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") sidebarCtrl.confirmNewSubmodule();
    else if (e.key === "Escape" && !sidebarCtrl.busy) sidebarCtrl.cancelNewSubmodule();
  }

  function onPushBranchKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") sidebarCtrl.confirmPushMenu();
    else if (e.key === "Escape" && !sidebarCtrl.busy) sidebarCtrl.cancelPushMenu();
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

  // "not-initialized" -> "not initialized" — display the raw backend status
  // string (also used verbatim as the CSS [data-status] selector below) with
  // its hyphens turned into spaces, rather than a separate hand-maintained
  // label map that could drift out of sync with submodule.rs's classify_status.
  function subStatusLabel(status: string): string {
    return status.replace(/-/g, " ");
  }

  // Sidebar hover tooltip content (see index.html's [data-tip] rule) — the
  // git-config submodule name when it differs from the on-disk path, the
  // remote URL if known, and the checked-out sha (or "not cloned" for
  // not-initialized, whose workdirSha is always null).
  function subTooltip(s: SubmoduleInfo): string {
    const parts: string[] = [];
    if (s.name !== s.path) parts.push(s.name);
    if (s.url) parts.push(s.url);
    parts.push(s.workdirSha ? "@ " + s.workdirSha.slice(0, 7) : "not cloned");
    return parts.join(" — ");
  }

  // Native `title` on the disabled "blocked" action button (dirty/conflicted
  // rows — see submoduleAction's own doc comment) explaining why there's
  // nothing to click, rather than just a dead-looking disabled button.
  function subBlockedTip(status: string): string {
    return "This submodule is " + subStatusLabel(status) + " — resolve it before updating.";
  }
</script>

<svelte:window onpointerdown={onWindowPointerdown} />

{#if !sidebarCtrl.hasRepo}
  <div class="sidebar-empty">
    <div class="ic"><Folder size={30} strokeWidth={1.3} aria-hidden="true" /></div>
    <div class="t">No repository open</div>
    <div class="sub">Branches, remotes, and snapshots will show up here once you open one.</div>
    <button class="btn" onclick={() => dashboardCtrl.show()}
      ><Folder class="ico" size={14} aria-hidden="true" /> Open a repository&#8230;</button
    >
  </div>
{:else}
<div class="ref-filter">
  <div class="ref-search">
    <span class="mag">&#9906;</span>
    <input id="refFilter" placeholder="Filter refs&#8230;" spellcheck="false" bind:value={sidebarCtrl.filter} />
  </div>
  <div class="ref-filter-actions">
    <button
      class="auto-toggle"
      class:active={sidebarCtrl.autoMode}
      title="Auto: show the current branch plus anything with unpushed or unmerged commits, always up to date"
      onclick={() => sidebarCtrl.toggleAutoMode(bridge.CUR_REPO as unknown as string)}
      >{#if sidebarCtrl.autoMode}<Zap class="ico" size={12} aria-hidden="true" /> {/if}Auto</button
    >
    {#if sidebarCtrl.isFiltering}
      <button class="show-all" onclick={() => sidebarCtrl.showAllBranches(bridge.CUR_REPO as unknown as string)}>Show all branches</button>
    {/if}
    <button class="show-all" title="Hide every branch except the current one, then pick a few back in" onclick={() => sidebarCtrl.hideAllBranches(bridge.CUR_REPO as unknown as string)}>Hide all branches</button>
  </div>
</div>
<div class="ref-scroll" id="refScroll" data-vimnav-list>
  <details class="ref-group" open>
    <summary><span class="tw">&#9656;</span>Local<span class="count" id="cntLocal">{sidebarCtrl.locals.length}</span></summary>
    <div class="ref-list" id="refLocal">
      {#each sidebarCtrl.locals.filter((b) => matches(b.name)) as b (b.name)}
        {@const isCur = b.name === sidebarCtrl.head}
        <div
          class="ref-item"
          class:current={isCur}
          class:busy={sidebarCtrl.busy}
          data-branch={b.name}
          role="button"
          tabindex="0"
          onclick={(e) => {
            if ((e.target as HTMLElement).closest(".ref-menu") || isCur || sidebarCtrl.busy) return;
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            sidebarCtrl.openCheckoutConfirm(b.name, false, r.left, r.bottom + 4);
          }}
          onkeydown={(e) => {
            if ((e.key !== "Enter" && e.key !== " ") || isCur || sidebarCtrl.busy) return;
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            sidebarCtrl.openCheckoutConfirm(b.name, false, r.left, r.bottom + 4);
          }}
          oncontextmenu={(e) => {
            e.preventDefault();
            if (!sidebarCtrl.busy) sidebarCtrl.openMenu(b.name, isCur, e.currentTarget as HTMLElement, b.upstream);
          }}
        >
          <input
            type="checkbox"
            class="rb-check"
            checked={isCur || sidebarCtrl.isBranchVisible("local", b.name)}
            disabled={isCur}
            title={isCur ? "The current branch is always shown in the graph" : "Show/hide this branch in the graph"}
            onclick={(e) => {
              e.stopPropagation();
              sidebarCtrl.toggleBranchVisible(bridge.CUR_REPO as unknown as string, "local", b.name);
            }}
          />
          <span class="rname">{b.name}</span>
          <button
            class="copy-name"
            title={sidebarCtrl.copiedBranch === b.name ? "Copied!" : "Copy branch name"}
            aria-label="Copy branch name {b.name}"
            onclick={(e) => {
              e.stopPropagation();
              sidebarCtrl.copyBranchName(b.name);
            }}>{#if sidebarCtrl.copiedBranch === b.name}✓{:else}<Clipboard class="ico" size={12} aria-hidden="true" />{/if}</button
          >
          {#if sidebarCtrl.busyTarget === b.name}
            <span class="spinner"></span>
          {:else if b.ahead || b.behind}
            <span class="ab">
              {#if b.ahead}<span class="up">&#8593;{b.ahead}</span>{/if}
              {#if b.behind}<span class="dn">&#8595;{b.behind}</span>{/if}
            </span>
          {/if}
          <button
            class="ref-menu"
            title="Branch actions"
            aria-label="Branch actions"
            disabled={sidebarCtrl.busy}
            onclick={(e) => {
              e.stopPropagation();
              sidebarCtrl.openMenu(b.name, isCur, e.currentTarget as HTMLElement, b.upstream);
            }}>&#8942;</button
          >
        </div>
      {/each}
      {#if sidebarCtrl.newBranchOpen}
        <div class="nb-form" class:busy={sidebarCtrl.busy} bind:this={newBranchFormEl}>
          <input
            class="nb-input"
            bind:this={newBranchEl}
            bind:value={sidebarCtrl.newBranchInput}
            placeholder="branch name&#8230;"
            spellcheck="false"
            autocomplete="off"
            disabled={sidebarCtrl.busy}
            onkeydown={onNewBranchKeydown}
          />
          <div class="nb-row">
            <select class="nb-from" bind:value={sidebarCtrl.newBranchFrom} title="Branch from" disabled={sidebarCtrl.busy} onkeydown={onNewBranchKeydown}>
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
            {#if sidebarCtrl.busy}<span class="spinner"></span>{/if}
          </div>
        </div>
      {:else}
        <div class="ref-item new-branch" role="button" tabindex="0" onclick={() => sidebarCtrl.startNewBranch()} onkeydown={(e) => (e.key === "Enter" || e.key === " ") && sidebarCtrl.startNewBranch()}>
          <span class="rname nb">&#65291; New branch&#8230;</span>
        </div>
      {/if}
    </div>
  </details>
  <details class="ref-group" open>
    <summary
      ><span class="tw">&#9656;</span>Remote<span class="count" id="cntRemote">{sidebarCtrl.remotes.length}</span><button
        class="manage-btn"
        title="Manage remotes&#8230;"
        aria-label="Manage remotes"
        onclick={(e) => {
          e.preventDefault(); // don't also toggle this <details> open/closed
          e.stopPropagation();
          remotesCtrl.show(bridge.CUR_REPO as unknown as string);
        }}>&#8942;</button
      ></summary
    >
    <div class="ref-list" id="refRemote">
      {#each remoteGroups(sidebarCtrl.remotes.filter((r) => matches(r.name))) as g, gi (g.head + gi)}
        <div class="remote-head">&#9729; {g.head}</div>
        {#each g.items as r (r.name)}
          <div
            class="ref-item"
            class:busy={sidebarCtrl.busy}
            role="button"
            tabindex="0"
            data-tip={r.name}
            onclick={(e) => {
              if (sidebarCtrl.busy) return;
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              sidebarCtrl.openCheckoutConfirm(r.name, true, rect.left, rect.bottom + 4);
            }}
            onkeydown={(e) => {
              if ((e.key !== "Enter" && e.key !== " ") || sidebarCtrl.busy) return;
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              sidebarCtrl.openCheckoutConfirm(r.name, true, rect.left, rect.bottom + 4);
            }}
          >
            <input
              type="checkbox"
              class="rb-check"
              checked={sidebarCtrl.isBranchVisible("remote", r.name)}
              title="Show/hide this branch in the graph"
              onclick={(e) => {
                e.stopPropagation();
                sidebarCtrl.toggleBranchVisible(bridge.CUR_REPO as unknown as string, "remote", r.name);
              }}
            />
            <span class="dot" style="background:var(--l{gi % 7})"></span><span class="rname">{r.name}</span>
            <button
              class="copy-name"
              title={sidebarCtrl.copiedBranch === r.name ? "Copied!" : "Copy branch name"}
              aria-label="Copy branch name {r.name}"
              onclick={(e) => {
                e.stopPropagation();
                sidebarCtrl.copyBranchName(r.name);
              }}>{#if sidebarCtrl.copiedBranch === r.name}✓{:else}<Clipboard class="ico" size={12} aria-hidden="true" />{/if}</button
            >
            {#if sidebarCtrl.busyTarget === r.name}<span class="spinner"></span>{/if}
          </div>
        {/each}
      {/each}
    </div>
  </details>
  <details class="ref-group">
    <summary><span class="tw">&#9656;</span>Tags<span class="count" id="cntTags">{sidebarCtrl.tags.length}</span></summary>
    <div class="ref-list" id="refTags">
      {#each sidebarCtrl.tags.filter((t) => matches(t.name)) as t (t.name)}
        <div
          class="ref-item"
          class:busy={sidebarCtrl.busy}
          data-tag={t.name}
          role="button"
          tabindex="0"
          onkeydown={(e) => (e.key === "Enter" || e.key === " ") && !sidebarCtrl.busy && sidebarCtrl.openTagMenu(t.name, e.currentTarget as HTMLElement)}
          oncontextmenu={(e) => {
            e.preventDefault();
            if (!sidebarCtrl.busy) sidebarCtrl.openTagMenu(t.name, e.currentTarget as HTMLElement);
          }}
        >
          <span class="rname">{t.name}</span>
          {#if sidebarCtrl.busyTarget === t.name}
            <span class="spinner"></span>
          {/if}
          <button
            class="ref-menu"
            title="Tag actions"
            aria-label="Tag actions"
            disabled={sidebarCtrl.busy}
            onclick={(e) => {
              e.stopPropagation();
              sidebarCtrl.openTagMenu(t.name, e.currentTarget as HTMLElement);
            }}>&#8942;</button
          >
        </div>
      {/each}
      {#if sidebarCtrl.newTagOpen}
        <div class="nb-form" class:busy={sidebarCtrl.busy} bind:this={newTagFormEl}>
          <input
            class="nb-input"
            bind:this={newTagEl}
            bind:value={sidebarCtrl.newTagName}
            placeholder="tag name&#8230;"
            spellcheck="false"
            autocomplete="off"
            disabled={sidebarCtrl.busy}
            onkeydown={onNewTagKeydown}
          />
          <input
            class="nb-input"
            bind:value={sidebarCtrl.newTagMessage}
            placeholder="message (optional &#8212; annotated tag)&#8230;"
            spellcheck="false"
            autocomplete="off"
            disabled={sidebarCtrl.busy}
            onkeydown={onNewTagKeydown}
          />
          <div class="nb-row">
            <select class="nb-from" bind:value={sidebarCtrl.newTagFrom} title="Tag target" disabled={sidebarCtrl.busy} onkeydown={onNewTagKeydown}>
              <option value="">at HEAD (current)</option>
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
            {#if sidebarCtrl.busy}<span class="spinner"></span>{/if}
          </div>
        </div>
      {:else}
        <div class="ref-item new-branch" role="button" tabindex="0" onclick={() => sidebarCtrl.startNewTag()} onkeydown={(e) => (e.key === "Enter" || e.key === " ") && sidebarCtrl.startNewTag()}>
          <span class="rname nb">&#65291; New tag&#8230;</span>
        </div>
      {/if}
    </div>
  </details>
  <details class="ref-group">
    <summary><span class="tw">&#9656;</span>Submodules<span class="count" id="cntSubmodules">{sidebarCtrl.submodules.length || "—"}</span></summary>
    <div class="ref-list" id="refSubmodules">
      {#if !sidebarCtrl.submodules.length}
        <div class="sub-item"><span class="rname mut">no submodules</span></div>
      {:else}
        <!-- Bulk submodule tools — recursive toggle, Sync all/Update all.
             Lives at the top of the list rather than crammed into <summary>
             (clicking inside a <summary> toggles the whole details/open
             state, and no other ref-group section has ever needed an
             interactive control there). Recursive is ONE shared checkbox/
             state (submodulesRecursive), applying to every bulk action
             below it. -->
        <div class="sub-head">
          <label class="sub-recursive"
            ><input type="checkbox" bind:checked={sidebarCtrl.submodulesRecursive} disabled={sidebarCtrl.busy} /> Recursive (nested submodules)</label
          >
          <div class="sub-bulk-row">
            <button
              class="sub-update-all"
              disabled={sidebarCtrl.busy}
              onclick={() => sidebarCtrl.syncAllSubmodules(sidebarCtrl.submodulesRecursive)}
            >
              {#if sidebarCtrl.busy && sidebarCtrl.busyTarget === SUBMODULES_SYNC_ALL}<span class="spinner"></span>{:else}Sync all{/if}
            </button>
            <button
              class="sub-update-all"
              disabled={sidebarCtrl.busy}
              onclick={() => sidebarCtrl.updateAllSubmodules(sidebarCtrl.submodulesRecursive)}
            >
              {#if sidebarCtrl.busy && sidebarCtrl.busyTarget === SUBMODULES_ALL}<span class="spinner"></span>{:else}Update all{/if}
            </button>
          </div>
        </div>
        {#each sidebarCtrl.submodules as s (s.path)}
          {@const canOpen = submoduleCanOpen(s.status)}
          <!-- Collapsed into a single "⋮" popover (see SubmoduleMenu's own
               doc comment in sidebar.svelte.ts for why): up to 5 always-
               visible inline buttons (Open/Sync/Init+update-or-Update/
               Deinit/Remove) plus the status chip and path simply don't fit
               the sidebar's width and were silently getting clipped. Mirrors
               the branch row's own "click the row = primary action, ⋮ =
               everything else" convention exactly — clicking anywhere on an
               openable row (canOpen) calls Open, same as clicking a branch
               row checks it out. -->
          <div
            class="sub-item"
            class:busy={sidebarCtrl.busy}
            data-tip={subTooltip(s)}
            role="button"
            tabindex="0"
            onclick={(e) => {
              if ((e.target as HTMLElement).closest(".ref-menu") || !canOpen || sidebarCtrl.busy) return;
              sidebarCtrl.openSubmodule(s.path, s.absolutePath);
            }}
            onkeydown={(e) => (e.key === "Enter" || e.key === " ") && canOpen && !sidebarCtrl.busy && sidebarCtrl.openSubmodule(s.path, s.absolutePath)}
          >
            <span class="rname">{s.path}</span>
            <span class="sub-status" data-status={s.status}>{subStatusLabel(s.status)}</span>
            {#if sidebarCtrl.busyTarget === s.path}
              <span class="spinner"></span>
            {:else if s.status === "removed"}
              <!-- Bug 6 fix: already staged for removal (submodule_remove
                   ran; nothing committed yet) — there's nothing left to
                   Init/Update/Sync/Deinit/Remove, so NONE of those are
                   offered here (unlike every other status, which always gets
                   Sync at minimum). A muted label instead of a dead-looking
                   menu, distinct from "clean" so it's not mistaken for an
                   ordinary, actionable submodule. -->
              <span class="rname mut">removed (uncommitted) — commit via Workdir</span>
            {:else if s.status === "unreadable"}
              <!-- CRASH FIX (M1): this submodule's own reachable
                   nested-submodule subtree was found cyclic/unresolvable, so
                   the backend never even called submodule_status for it (see
                   check_submodule_safe_for_status in submodule.rs) — there is
                   nothing safe left to Init/Update/Sync/Deinit/Remove, so
                   NONE of those are offered here, same as "removed" above. A
                   clear, muted-but-attention-worthy label instead of a
                   dead-looking menu, and distinct enough from "clean" that it
                   can never be mistaken for an ordinary, actionable
                   submodule. -->
              <span class="rname mut">unreadable — possible cyclic submodule reference</span>
            {:else}
              <button
                class="ref-menu"
                title="Submodule actions"
                aria-label="Submodule actions"
                disabled={sidebarCtrl.busy}
                onclick={(e) => {
                  e.stopPropagation();
                  sidebarCtrl.openSubmoduleMenu(s.path, s.status, s.absolutePath, e.currentTarget as HTMLElement);
                }}>&#8942;</button
              >
            {/if}
          </div>
        {/each}
      {/if}
      {#if sidebarCtrl.newSubmoduleOpen}
        <div class="nb-form" class:busy={sidebarCtrl.busy} bind:this={newSubmoduleFormEl}>
          <input
            class="nb-input"
            bind:this={newSubmoduleEl}
            bind:value={sidebarCtrl.newSubmoduleUrl}
            placeholder="repository URL&#8230;"
            spellcheck="false"
            autocomplete="off"
            disabled={sidebarCtrl.busy}
            onkeydown={onNewSubmoduleKeydown}
          />
          <input
            class="nb-input"
            bind:value={sidebarCtrl.newSubmodulePath}
            placeholder="path (e.g. vendor/lib)&#8230;"
            spellcheck="false"
            autocomplete="off"
            disabled={sidebarCtrl.busy}
            onkeydown={onNewSubmoduleKeydown}
          />
          <input
            class="nb-input"
            bind:value={sidebarCtrl.newSubmoduleBranch}
            placeholder="branch (optional)&#8230;"
            spellcheck="false"
            autocomplete="off"
            disabled={sidebarCtrl.busy}
            onkeydown={onNewSubmoduleKeydown}
          />
          {#if sidebarCtrl.busy}
            <div class="nb-row"><span class="spinner"></span></div>
          {/if}
        </div>
      {:else}
        <div class="ref-item new-branch" role="button" tabindex="0" onclick={() => sidebarCtrl.startNewSubmodule()} onkeydown={(e) => (e.key === "Enter" || e.key === " ") && sidebarCtrl.startNewSubmodule()}>
          <span class="rname nb">&#65291; Add submodule&#8230;</span>
        </div>
      {/if}
    </div>
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
    <button disabled={menu.isCurrent} onclick={() => { const name = menu.name; const x = menu.x, y = menu.y; sidebarCtrl.closeMenu(); sidebarCtrl.checkout(name, { x, y }); }}>Checkout</button>
    <!-- Pushes THIS branch directly — no switching, unlike the topbar Push
         button/doPush() which always targets whatever's checked out. Shown
         for every branch (not gated by !menu.isCurrent, unlike the actions
         below) since even the current branch benefits from a from-the-
         sidebar push, e.g. while comparing several branches without
         checking any of them out. -->
    <button onclick={() => { const name = menu.name; sidebarCtrl.closeMenu(); sidebarCtrl.pushBranch(name, null); }}>Push</button>
    <button onclick={() => { const name = menu.name; const x = menu.x, y = menu.y; sidebarCtrl.closeMenu(); sidebarCtrl.openPushMenu(name, x, y); }}>Push to&#8230;</button>
    {#if !menu.isCurrent}
      <button onclick={() => { const name = menu.name; const x = menu.x, y = menu.y; sidebarCtrl.closeMenu(); sidebarCtrl.openMergeMenu(name, x, y); }}>Merge into current&#8230;</button>
      <button onclick={() => { const name = menu.name; sidebarCtrl.closeMenu(); sidebarCtrl.rebaseOnto(name); }}>Rebase current branch onto here</button>
      <button onclick={() => { const name = menu.name; sidebarCtrl.closeMenu(); sidebarCtrl.interactiveRebaseOnto(name); }}>Interactive rebase onto here&#8230;</button>
    {/if}
    {#if menu.upstream}
      <button class="danger" onclick={() => { const name = menu.name; const upstream = menu.upstream as string; sidebarCtrl.closeMenu(); sidebarCtrl.resetToUpstream(name, upstream); }}>Reset to {menu.upstream}&#8230;</button>
    {/if}
    <button class="danger" disabled={menu.isCurrent} onclick={() => { const name = menu.name; sidebarCtrl.closeMenu(); sidebarCtrl.deleteBranch(name); }}>Delete&#8230;</button>
  </div>
{/if}

{#if sidebarCtrl.pushMenu}
  {@const pm = sidebarCtrl.pushMenu}
  <div class="ref-pop cm-pop" bind:this={pushMenuEl} style="left:{pm.x}px;top:{pm.y}px">
    <div class="cm-head"><span>Push <b>{pm.name}</b> to&#8230;</span></div>
    <div class="nb-form" class:busy={sidebarCtrl.busy}>
      <input
        class="nb-input"
        bind:this={pushBranchInputEl}
        bind:value={sidebarCtrl.pushBranchInput}
        placeholder={pm.name + " (same name)"}
        spellcheck="false"
        autocomplete="off"
        disabled={sidebarCtrl.busy}
        onkeydown={onPushBranchKeydown}
      />
      <div class="nb-row">
        <span class="mut">Enter to push, Esc to cancel</span>
        {#if sidebarCtrl.busy}<span class="spinner"></span>{/if}
      </div>
    </div>
  </div>
{/if}

{#if sidebarCtrl.mergeMenu}
  {@const mm = sidebarCtrl.mergeMenu}
  <div class="ref-pop" bind:this={mergeMenuEl} style="left:{mm.x}px;top:{mm.y}px">
    <!-- Same capture-before-close rationale as the branch/tag/submodule menus
         above — mm.name is read into a local BEFORE closeMergeMenu() nulls
         sidebarCtrl.mergeMenu. -->
    <button onclick={() => { const name = mm.name; sidebarCtrl.closeMergeMenu(); sidebarCtrl.mergeInto(name, "auto"); }}>Auto (fast-forward if possible)</button>
    <button onclick={() => { const name = mm.name; sidebarCtrl.closeMergeMenu(); sidebarCtrl.mergeInto(name, "no-ff"); }}>Always create a merge commit</button>
    <button onclick={() => { const name = mm.name; sidebarCtrl.closeMergeMenu(); sidebarCtrl.mergeInto(name, "ff-only"); }}>Fast-forward only</button>
    <button onclick={() => { const name = mm.name; sidebarCtrl.closeMergeMenu(); sidebarCtrl.squashInto(name); }}>Squash (no commit)</button>
  </div>
{/if}

<!-- Backlog #34: dirty-tree resolution chooser — opened by checkout/
     checkoutRemote the instant either hits git's dirty-tree collision,
     instead of the plain toast every OTHER checkout refusal still gets.
     Reuses `.ref-pop.cm-pop`/`.cm-head` verbatim (CommitMenu.svelte's own
     "small non-interactive header line" pattern) rather than inventing new
     CSS. Ordered by increasing risk, most-destructive last, matching the
     branch/submodule popovers' own Delete/Remove-last convention. -->
{#if sidebarCtrl.dirtyCheckoutMenu}
  {@const dcm = sidebarCtrl.dirtyCheckoutMenu}
  <div class="ref-pop cm-pop" bind:this={dirtyCheckoutMenuEl} style="left:{dcm.x}px;top:{dcm.y}px">
    <div class="cm-head">
      <span>{dcm.files.length} file{dcm.files.length === 1 ? "" : "s"} would be overwritten switching to <b>{dcm.name}</b>:</span>
      <span class="subject" title={dcm.files.join(", ")}>{dcm.files.slice(0, 6).join(", ")}{dcm.files.length > 6 ? "…" : ""}</span>
    </div>
    <!-- Capture dcm.name/startPoint/files.length into locals BEFORE
         closeDirtyCheckoutMenu() nulls sidebarCtrl.dirtyCheckoutMenu — same
         rationale as every other popover's own capture-before-close comment
         above. -->
    <button
      onclick={() => {
        const name = dcm.name, sp = dcm.startPoint;
        sidebarCtrl.closeDirtyCheckoutMenu();
        sidebarCtrl.stashSwitchReapply(name, sp);
      }}>Stash, switch, then reapply</button
    >
    <button
      onclick={() => {
        const name = dcm.name, sp = dcm.startPoint;
        sidebarCtrl.closeDirtyCheckoutMenu();
        sidebarCtrl.stashSwitchLeaveStashed(name, sp);
      }}>Stash, switch, leave stashed</button
    >
    <button
      class="danger"
      onclick={() => {
        const name = dcm.name, sp = dcm.startPoint, n = dcm.files.length;
        sidebarCtrl.closeDirtyCheckoutMenu();
        sidebarCtrl.forceDiscardCheckout(name, sp, n);
      }}>Force switch, discarding my changes&#8230;</button
    >
  </div>
{/if}

<!-- A branch row's own click/Enter opens this instead of checking out
     directly (see CheckoutConfirm's own doc comment) — a stray click that
     misses the visibility checkbox right next to it, or just brushes the
     row, used to switch branches with zero recourse. Reuses `.ref-pop.cm-pop`/
     `.cm-head` verbatim, same as the dirty-tree chooser above; no Cancel
     button, matching every OTHER popover here (menu/tagMenu/submoduleMenu/
     mergeMenu/dirtyCheckoutMenu) — outside-click dismisses it. -->
{#if sidebarCtrl.checkoutConfirm}
  {@const cc = sidebarCtrl.checkoutConfirm}
  <div class="ref-pop cm-pop" bind:this={checkoutConfirmEl} style="left:{cc.x}px;top:{cc.y}px">
    <div class="cm-head">Switch to <b>{cc.name}</b>?</div>
    <!-- Same capture-before-close rationale as the branch menu above. -->
    <button
      onclick={() => {
        const name = cc.name, remote = cc.remote, pos = { x: cc.x, y: cc.y };
        sidebarCtrl.closeCheckoutConfirm();
        if (remote) sidebarCtrl.checkoutRemote(name, pos);
        else sidebarCtrl.checkout(name, pos);
      }}>Switch</button
    >
  </div>
{/if}

{#if sidebarCtrl.tagMenu}
  {@const tm = sidebarCtrl.tagMenu}
  <div class="ref-pop" bind:this={tagMenuEl} style="left:{tm.x}px;top:{tm.y}px">
    <!-- Same capture-before-close rationale as the branch menu above. -->
    <button onclick={() => { const name = tm.name; sidebarCtrl.closeTagMenu(); sidebarCtrl.pushTag(name); }}>Push to origin</button>
    <button class="danger" onclick={() => { const name = tm.name; sidebarCtrl.closeTagMenu(); sidebarCtrl.deleteTag(name); }}>Delete&#8230;</button>
  </div>
{/if}

{#if sidebarCtrl.submoduleMenu}
  {@const sm = sidebarCtrl.submoduleMenu}
  {@const smAction = submoduleAction(sm.status)}
  <div class="ref-pop" bind:this={submoduleMenuEl} style="left:{sm.x}px;top:{sm.y}px">
    <!-- Same capture-before-close rationale as the branch/tag menus above —
         path/status/absolutePath are captured into locals (sm.*, smAction)
         from the snapshot the popover opened with, matching what the row
         itself showed. -->
    {#if submoduleCanOpen(sm.status)}
      <button onclick={() => { const path = sm.path, p = sm.absolutePath; sidebarCtrl.closeSubmoduleMenu(); sidebarCtrl.openSubmodule(path, p); }}>Open</button>
    {/if}
    <!-- Sync is offered regardless of status (unlike Init/Update below) — it
         only rewrites .git/config's url, never the submodule's own working
         tree/index, so there's nothing for "dirty"/"conflicted" to block. -->
    <button onclick={() => { const p = sm.path; sidebarCtrl.closeSubmoduleMenu(); sidebarCtrl.syncSubmodule(p); }}>Sync</button>
    {#if smAction === "init"}
      <button onclick={() => { const p = sm.path; sidebarCtrl.closeSubmoduleMenu(); sidebarCtrl.initAndUpdateSubmodule(p); }}>Init + update</button>
    {:else if smAction === "update"}
      <button onclick={() => { const p = sm.path; sidebarCtrl.closeSubmoduleMenu(); sidebarCtrl.updateSubmodule(p); }}>Update</button>
    {:else if smAction === "blocked"}
      <button disabled title={subBlockedTip(sm.status)}>Update</button>
    {/if}
    <!-- Deinit/Remove — offered unconditionally like Sync (not status-gated
         the way Init/Update are): Deinit's own status-gated confirm
         decision lives in the controller (submoduleNeedsForceConfirm), and
         Remove is always final regardless of status. Ordering is
         increasing severity, Remove last. -->
    <button onclick={() => { const p = sm.path, st = sm.status; sidebarCtrl.closeSubmoduleMenu(); sidebarCtrl.deinitSubmodule(p, st); }}>Deinit</button>
    <button class="danger" onclick={() => { const p = sm.path; sidebarCtrl.closeSubmoduleMenu(); sidebarCtrl.removeSubmodule(p); }}>Remove&#8230;</button>
  </div>
{/if}
