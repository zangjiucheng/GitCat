<script lang="ts">
  import { sidebarCtrl, submoduleAction, submoduleCanOpen, SUBMODULES_ALL, SUBMODULES_SYNC_ALL, buildRefRows, remoteHead, compareRefLabels } from "./sidebar.svelte.ts";
  import type { RefSection } from "./sidebar.svelte.ts";
  import { remotesCtrl } from "../remotes/remotes.svelte.ts";
  import { dashboardCtrl } from "../dashboard/dashboard.svelte.ts";
  import { forcePushCtrl } from "../forcepush/forcepush.svelte.ts";
  import { snapshotPreviewCtrl } from "../snapshotpreview/snapshotpreview.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import type { SubmoduleInfo } from "../../ipc/bindings";
  import { t } from "@/i18n/i18n.svelte.ts";
  import Folder from "@lucide/svelte/icons/folder";
  import Zap from "@lucide/svelte/icons/zap";
  import Clipboard from "@lucide/svelte/icons/clipboard";
  import ChevronsDownUp from "@lucide/svelte/icons/chevrons-down-up";
  import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
  import Cloud from "@lucide/svelte/icons/cloud";

  let menuEl: HTMLDivElement | undefined = $state();
  let newBranchEl: HTMLInputElement | undefined = $state();
  let newBranchFormEl: HTMLDivElement | undefined = $state();
  let tagMenuEl: HTMLDivElement | undefined = $state();
  let newTagEl: HTMLInputElement | undefined = $state();
  let newTagFormEl: HTMLDivElement | undefined = $state();
  let newSubmoduleEl: HTMLInputElement | undefined = $state();
  let newSubmoduleFormEl: HTMLDivElement | undefined = $state();
  let submoduleMenuEl: HTMLDivElement | undefined = $state();

  // Full-name tooltip for a truncated ref name (branch / remote / tag /
  // submodule). A position:fixed pill (see .rname-tip) so it escapes
  // .ref-scroll's overflow clip and can extend PAST the sidebar's right edge
  // over the graph, rather than being cut off. One delegated handler over the
  // whole list; only shown when the name is actually ellipsized (scrollWidth >
  // clientWidth), so short names never get a redundant tip.
  let nameTip = $state<{ text: string; x: number; y: number } | null>(null);
  function onRefHover(e: MouseEvent) {
    const el = (e.target as HTMLElement | null)?.closest?.(".rname") as HTMLElement | null;
    if (!el) {
      nameTip = null;
      return;
    }
    // A tree leaf renders only its own last segment (see buildRefRows), so its
    // full ref lives in data-fullname — show the tip whenever that differs from
    // what's on screen, not just when the text is ellipsized. Without this the
    // folder grouping would have left no way at all to read a ref's full name
    // from the sidebar.
    const full = el.dataset.fullname ?? "";
    const shown = (el.textContent ?? "").trim();
    const ellipsized = el.scrollWidth > el.clientWidth + 1;
    const abbreviated = full !== "" && full !== shown;
    if (ellipsized || abbreviated) {
      const r = el.getBoundingClientRect();
      nameTip = { text: abbreviated ? full : shown, x: r.left, y: r.bottom + 3 };
    } else {
      nameTip = null;
    }
  }
  let mergeMenuEl: HTMLDivElement | undefined = $state();
  let dirtyCheckoutMenuEl: HTMLDivElement | undefined = $state();
  let checkoutConfirmEl: HTMLDivElement | undefined = $state();
  let pushMenuEl: HTMLDivElement | undefined = $state();
  let pushBranchInputEl: HTMLInputElement | undefined = $state();
  let renameMenuEl: HTMLDivElement | undefined = $state();
  let renameInputEl: HTMLInputElement | undefined = $state();

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
    // Outside-click cancels the Rename form — same busy-blocked rationale.
    if (sidebarCtrl.renameMenu && !sidebarCtrl.busy && renameMenuEl && !renameMenuEl.contains(e.target as Node)) sidebarCtrl.cancelRenameMenu();
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

  // Focus AND select the pre-filled name so the user can immediately retype it
  // or edit just the suffix.
  $effect(() => {
    if (sidebarCtrl.renameMenu)
      requestAnimationFrame(() => {
        renameInputEl?.focus();
        renameInputEl?.select();
      });
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

  function onRenameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") sidebarCtrl.confirmRenameMenu();
    else if (e.key === "Escape" && !sidebarCtrl.busy) sidebarCtrl.cancelRenameMenu();
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

  // While a filter is typed, every folder renders open regardless of collapsed
  // state (buildRefRows' `forceExpand`) — a match must never be hidden inside a
  // folder that happened to be folded, which is what VS Code's explorer and Git
  // Fork's own filter box both do. Collapsed state itself is untouched, so the
  // tree springs back exactly as it was once the box is emptied.
  const filterActive = $derived(sidebarCtrl.filter.trim() !== "");

  // Each section's folder paths, derived ONCE per ref-list change. Both the
  // collapse-all button's presence and its direction need this list, and
  // recomputing it inline in the markup would re-split every ref name on every
  // render of the summary row — cheap per ref, but the remote list is as long as
  // the repo has remote-tracking branches.
  const localFolderPaths = $derived(sidebarCtrl.folderPaths("local"));
  const remoteFolderPaths = $derived(sidebarCtrl.folderPaths("remote"));
  const tagFolderPaths = $derived(sidebarCtrl.folderPaths("tag"));

  // Whether EVERY folder of a section is currently folded — drives the
  // collapse-all button's direction and label, so one control does both jobs
  // instead of two competing buttons.
  //
  // Read alongside `filterActive`: a typed filter force-expands every folder for
  // rendering WITHOUT touching the stored state, so while one is active this
  // predicate describes something the screen isn't showing. That's why the
  // collapse-all buttons hide entirely while filtering — offering "Expand all"
  // over an already-expanded tree would be a lie, and clicking it would quietly
  // overwrite the collapse state the user gets back when they clear the box.
  function allFolded(paths: string[], section: RefSection): boolean {
    return paths.length > 0 && paths.every((p) => sidebarCtrl.isFolderCollapsed(section, p));
  }
  const localAllFolded = $derived(allFolded(localFolderPaths, "local"));
  const remoteAllFolded = $derived(allFolded(remoteFolderPaths, "remote"));
  const tagAllFolded = $derived(allFolded(tagFolderPaths, "tag"));

  // Lane colour for a remote branch's dot, keyed by WHICH REMOTE it belongs to,
  // so every `origin/*` row shares one colour and every `upstream/*` row
  // another. Derived from the ref's own name against the remotes sorted the same
  // way the tree renders them, so colour order and display order agree whatever
  // order the backend enumerated them in.
  const remoteHeads = $derived(
    [...new Set(sidebarCtrl.remotes.map((r) => remoteHead(r.name)).filter((h): h is string => h !== null))].sort(compareRefLabels),
  );
  function remoteColorIndex(name: string): number {
    const head = remoteHead(name);
    const i = head === null ? -1 : remoteHeads.indexOf(head);
    return (i < 0 ? 0 : i) % 7;
  }

  // "not-initialized" -> "not initialized" — display the raw backend status
  // string (also used verbatim as the CSS [data-status] selector below) with
  // its hyphens turned into spaces, rather than a separate hand-maintained
  // label map that could drift out of sync with submodule.rs's classify_status.
  function subStatusLabel(status: string): string {
    switch (status) {
      case "clean": return t("sidebar.sub_status_clean");
      case "dirty": return t("sidebar.sub_status_dirty");
      case "out-of-date": return t("sidebar.sub_status_out_of_date");
      case "conflicted": return t("sidebar.sub_status_conflicted");
      case "not-initialized": return t("sidebar.sub_status_not_initialized");
      case "removed": return t("sidebar.sub_status_removed");
      case "unreadable": return t("sidebar.sub_status_unreadable");
      default: return status.replace(/-/g, " ");
    }
  }

  // Sidebar hover tooltip content (see index.html's [data-tip] rule) — the
  // git-config submodule name when it differs from the on-disk path, the
  // remote URL if known, and the checked-out sha (or "not cloned" for
  // not-initialized, whose workdirSha is always null).
  function subTooltip(s: SubmoduleInfo): string {
    const parts: string[] = [];
    if (s.name !== s.path) parts.push(s.name);
    if (s.url) parts.push(s.url);
    parts.push(s.workdirSha ? "@ " + s.workdirSha.slice(0, 7) : t("sidebar.not_cloned"));
    return parts.join(" — ");
  }

  // Native `title` on the disabled "blocked" action button (dirty/conflicted
  // rows — see submoduleAction's own doc comment) explaining why there's
  // nothing to click, rather than just a dead-looking disabled button.
  function subBlockedTip(status: string): string {
    return t("sidebar.sub_blocked_tip", { status: subStatusLabel(status) });
  }
</script>

<svelte:window onpointerdown={onWindowPointerdown} />

{#if !sidebarCtrl.hasRepo}
  <div class="sidebar-empty">
    <div class="ic"><Folder size={30} strokeWidth={1.3} aria-hidden="true" /></div>
    <div class="t">{t("sidebar.no_repo_open")}</div>
    <div class="sub">{t("sidebar.no_repo_sub")}</div>
    <button class="btn" onclick={() => dashboardCtrl.show()}
      ><Folder class="ico" size={14} aria-hidden="true" /> {t("sidebar.open_repo")}</button
    >
  </div>
{:else}
<div class="ref-filter">
  <div class="ref-search">
    <span class="mag">&#9906;</span>
    <input id="refFilter" placeholder={t("sidebar.filter_refs")} spellcheck="false" bind:value={sidebarCtrl.filter} />
  </div>
  <div class="ref-filter-actions">
    <button
      class="auto-toggle"
      class:active={sidebarCtrl.autoMode}
      title={t("sidebar.auto_tip")}
      onclick={() => sidebarCtrl.toggleAutoMode(bridge.CUR_REPO as unknown as string)}
      >{#if sidebarCtrl.autoMode}<Zap class="ico" size={12} aria-hidden="true" /> {/if}{t("sidebar.auto")}</button
    >
    {#if sidebarCtrl.isFiltering}
      <button class="show-all" onclick={() => sidebarCtrl.showAllBranches(bridge.CUR_REPO as unknown as string)}>{t("sidebar.show_all_branches")}</button>
    {/if}
    <button class="show-all" title={t("sidebar.hide_all_tip")} onclick={() => sidebarCtrl.hideAllBranches(bridge.CUR_REPO as unknown as string)}>{t("sidebar.hide_all_branches")}</button>
  </div>
</div>
<!-- The mouseover handler only drives a decorative "full name" tooltip for
     truncated rows; the name itself is already in the DOM (read by screen
     readers regardless of visual ellipsis), so no keyboard/role equivalent is
     needed for it. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_mouse_events_have_key_events -->
<div class="ref-scroll" id="refScroll" data-vimnav-list onmouseover={onRefHover} onmouseleave={() => (nameTip = null)} onfocusout={() => (nameTip = null)}>
  <details class="ref-group" open>
    <summary
      ><span class="tw">&#9656;</span>{t("sidebar.local")}<span class="count" id="cntLocal">{sidebarCtrl.locals.length}</span>
      {#if localFolderPaths.length > 0 && !filterActive}
        <!-- Fold/unfold every branch folder at once. Mirrors the ⋮ manage-btn's
             placement/look on the Remotes summary: preventDefault stops the
             click from also toggling this <details> open/closed. -->
        <button
          class="manage-btn fold-btn"
          title={localAllFolded ? t("sidebar.expand_branch_folders") : t("sidebar.collapse_branch_folders")}
          aria-label={localAllFolded ? t("sidebar.expand_branch_folders") : t("sidebar.collapse_branch_folders")}
          onclick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            sidebarCtrl.setAllFoldersCollapsed("local", !localAllFolded);
          }}>{#if localAllFolded}<ChevronsUpDown class="ico" size={12} aria-hidden="true" />{:else}<ChevronsDownUp class="ico" size={12} aria-hidden="true" />{/if}</button
        >
      {/if}</summary
    >
    <div class="ref-list" id="refLocal">
      {#each buildRefRows(sidebarCtrl.locals.filter((b) => matches(b.name)), (b) => b.name, (p) => sidebarCtrl.isFolderCollapsed("local", p), filterActive) as row (row.kind + row.path)}
        {#if row.kind === "folder"}
          <div
            class="ref-folder"
            class:collapsed={row.collapsed}
            style="--depth:{row.depth}"
            role="button"
            tabindex="0"
            aria-expanded={!row.collapsed}
            onclick={() => sidebarCtrl.toggleFolder("local", row.path)}
            onkeydown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault(); // Space would otherwise ALSO scroll the ref list
              sidebarCtrl.toggleFolder("local", row.path);
            }}
          >
            <span class="tw">&#9656;</span><Folder class="ico" size={12} aria-hidden="true" /><span class="rname">{row.label}</span
            ><span class="count">{row.count}</span>
          </div>
        {:else}
          {@const b = row.item}
          {@const isCur = b.name === sidebarCtrl.head}
          <div
            class="ref-item"
            class:current={isCur}
            class:busy={sidebarCtrl.busy}
            style="--depth:{row.depth}"
            data-branch={b.name}
          role="button"
          tabindex="0"
          onclick={(e) => {
            if ((e.target as HTMLElement).closest(".ref-menu")) return;
            sidebarCtrl.jumpToRef("local", b.name, b.sha);
          }}
          onkeydown={(e) => {
            // Fires during bubble, so a descendant's own Enter/Space (the ⋮
            // button, the visibility checkbox, the copy-name button) reaches
            // this handler too — bail before touching the event unless it
            // originated on the row itself, or preventDefault below would
            // cancel that descendant's own activation instead of just
            // suppressing the list's Space-scrolls.
            if (e.target !== e.currentTarget) return;
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault(); // Space would otherwise ALSO scroll the ref list
            sidebarCtrl.jumpToRef("local", b.name, b.sha);
          }}
          ondblclick={(e) => {
            // The checkbox/copy-name onclick handlers stopPropagation on click only —
            // dblclick is a separate event that still bubbles here, so it needs its own guard.
            if ((e.target as HTMLElement).closest(".ref-menu, .rb-check, .copy-name") || isCur || sidebarCtrl.busy) return;
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
            title={isCur ? t("sidebar.current_always_shown") : t("sidebar.toggle_branch_visible")}
            onclick={(e) => {
              e.stopPropagation();
              sidebarCtrl.toggleBranchVisible(bridge.CUR_REPO as unknown as string, "local", b.name);
            }}
          />
          <!-- Only this branch's own last segment: the folder rows above
               already carry the shared prefix, and the full name is still
               available on hover (onRefHover's .rname-tip) and via
               data-branch. -->
          <span class="rname" data-fullname={b.name}>{row.label}</span>
          <button
            class="copy-name"
            title={sidebarCtrl.copiedBranch === b.name ? t("sidebar.copied") : t("sidebar.copy_branch_name")}
            aria-label={t("sidebar.copy_branch_name_named", { name: b.name })}
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
            title={t("sidebar.branch_actions")}
            aria-label={t("sidebar.branch_actions")}
            disabled={sidebarCtrl.busy}
            onclick={(e) => {
              e.stopPropagation();
              sidebarCtrl.openMenu(b.name, isCur, e.currentTarget as HTMLElement, b.upstream);
            }}>&#8942;</button
          >
          </div>
        {/if}
      {/each}
      {#if sidebarCtrl.newBranchOpen}
        <div class="nb-form" class:busy={sidebarCtrl.busy} bind:this={newBranchFormEl}>
          <input
            class="nb-input"
            bind:this={newBranchEl}
            bind:value={sidebarCtrl.newBranchInput}
            placeholder={t("sidebar.branch_name_placeholder")}
            spellcheck="false"
            autocomplete="off"
            disabled={sidebarCtrl.busy}
            onkeydown={onNewBranchKeydown}
          />
          <div class="nb-row">
            <select class="nb-from" bind:value={sidebarCtrl.newBranchFrom} title={t("sidebar.branch_from")} disabled={sidebarCtrl.busy} onkeydown={onNewBranchKeydown}>
              <option value="">{t("sidebar.from_head")}</option>
              {#if sidebarCtrl.locals.length}
                <optgroup label={t("sidebar.local")}>
                  {#each sidebarCtrl.locals as b (b.name)}
                    <option value={b.name}>{b.name}</option>
                  {/each}
                </optgroup>
              {/if}
              {#if sidebarCtrl.remotes.length}
                <optgroup label={t("sidebar.remote")}>
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
          <span class="rname nb">&#65291; {t("sidebar.new_branch")}</span>
        </div>
      {/if}
    </div>
  </details>
  <details class="ref-group">
    <summary
      ><span class="tw">&#9656;</span>{t("sidebar.remote")}<span class="count" id="cntRemote">{sidebarCtrl.remotes.length}</span>{#if remoteFolderPaths.length > 0 && !filterActive}<button
          class="manage-btn fold-btn"
          title={remoteAllFolded ? t("sidebar.expand_branch_folders") : t("sidebar.collapse_branch_folders")}
          aria-label={remoteAllFolded ? t("sidebar.expand_branch_folders") : t("sidebar.collapse_branch_folders")}
          onclick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            sidebarCtrl.setAllFoldersCollapsed("remote", !remoteAllFolded);
          }}>{#if remoteAllFolded}<ChevronsUpDown class="ico" size={12} aria-hidden="true" />{:else}<ChevronsDownUp class="ico" size={12} aria-hidden="true" />{/if}</button
        >{/if}<button
        class="manage-btn"
        title={t("sidebar.manage_remotes")}
        aria-label={t("sidebar.manage_remotes_aria")}
        onclick={(e) => {
          e.preventDefault(); // don't also toggle this <details> open/closed
          e.stopPropagation();
          remotesCtrl.show(bridge.CUR_REPO as unknown as string);
        }}>&#8942;</button
      ></summary
    >
    <div class="ref-list" id="refRemote">
      <!-- Grouped on the FULL ref name, so a remote is itself the outermost
           folder and its branches nest under it: `origin` > `feature` >
           `knotAlg`. Indentation therefore matches containment, and a folder
           path is `origin/feature` from the start — which is what keeps
           `feature/` under two different remotes from sharing one collapse
           state. -->
      {#each buildRefRows(sidebarCtrl.remotes.filter((r) => matches(r.name)), (r) => r.name, (p) => sidebarCtrl.isFolderCollapsed("remote", p), filterActive) as row (row.kind + row.path)}
          {#if row.kind === "folder"}
            <div
              class="ref-folder"
              class:collapsed={row.collapsed}
              style="--depth:{row.depth}"
              role="button"
              tabindex="0"
              aria-expanded={!row.collapsed}
              onclick={() => sidebarCtrl.toggleFolder("remote", row.path)}
              onkeydown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault(); // Space would otherwise ALSO scroll the ref list
              sidebarCtrl.toggleFolder("remote", row.path);
            }}
            >
              <!-- A depth-0 folder IS a remote, so it gets the cloud rather than
                   a generic folder icon. -->
              <span class="tw">&#9656;</span>{#if row.depth === 0}<Cloud class="ico" size={12} aria-hidden="true" />{:else}<Folder
                  class="ico"
                  size={12}
                  aria-hidden="true"
                />{/if}<span class="rname">{row.label}</span><span class="count">{row.count}</span>
            </div>
          {:else}
          {@const r = row.item}
          <div
            class="ref-item"
            class:busy={sidebarCtrl.busy}
            style="--depth:{row.depth}"
            role="button"
            tabindex="0"
            onclick={(e) => {
              if ((e.target as HTMLElement).closest(".ref-menu")) return;
              sidebarCtrl.jumpToRef("remote", r.name, r.sha);
            }}
            onkeydown={(e) => {
              // Fires during bubble, so a descendant's own Enter/Space (the ⋮
              // button, the visibility checkbox, the copy-name button) reaches
              // this handler too — bail before touching the event unless it
              // originated on the row itself, or preventDefault below would
              // cancel that descendant's own activation instead of just
              // suppressing the list's Space-scrolls.
              if (e.target !== e.currentTarget) return;
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault(); // Space would otherwise ALSO scroll the ref list
              sidebarCtrl.jumpToRef("remote", r.name, r.sha);
            }}
            ondblclick={(e) => {
              if ((e.target as HTMLElement).closest(".ref-menu, .rb-check, .copy-name") || sidebarCtrl.busy) return;
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              sidebarCtrl.openCheckoutConfirm(r.name, true, rect.left, rect.bottom + 4);
            }}
            oncontextmenu={(e) => {
              e.preventDefault();
              if (!sidebarCtrl.busy) {
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                sidebarCtrl.openCheckoutConfirm(r.name, true, rect.left, rect.bottom + 4);
              }
            }}
          >
            <input
              type="checkbox"
              class="rb-check"
              checked={sidebarCtrl.isBranchVisible("remote", r.name)}
              title={t("sidebar.toggle_branch_visible")}
              onclick={(e) => {
                e.stopPropagation();
                sidebarCtrl.toggleBranchVisible(bridge.CUR_REPO as unknown as string, "remote", r.name);
              }}
            />
            <span class="dot" style="background:var(--l{remoteColorIndex(r.name)})"></span><span class="rname" data-fullname={r.name}>{row.label}</span>
            <button
              class="copy-name"
              title={sidebarCtrl.copiedBranch === r.name ? t("sidebar.copied") : t("sidebar.copy_branch_name")}
              aria-label={t("sidebar.copy_branch_name_named", { name: r.name })}
              onclick={(e) => {
                e.stopPropagation();
                sidebarCtrl.copyBranchName(r.name);
              }}>{#if sidebarCtrl.copiedBranch === r.name}✓{:else}<Clipboard class="ico" size={12} aria-hidden="true" />{/if}</button
            >
            {#if sidebarCtrl.busyTarget === r.name}<span class="spinner"></span>{/if}
            <!-- A remote row's only action is checkout (there's no remote "branch
                 actions" menu to open), so its ⋮ opens the checkout confirm
                 directly instead of a menu — this keeps that action reachable
                 without a mouse. -->
            <button
              class="ref-menu"
              title={t("sidebar.checkout_remote")}
              aria-label={t("sidebar.checkout_named", { name: r.name })}
              disabled={sidebarCtrl.busy}
              onclick={(e) => {
                e.stopPropagation();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                sidebarCtrl.openCheckoutConfirm(r.name, true, rect.left, rect.bottom + 4);
              }}>&#8942;</button
            >
          </div>
          {/if}
        {/each}
    </div>
  </details>
  <details class="ref-group">
    <summary
      ><span class="tw">&#9656;</span>{t("sidebar.tags")}<span class="count" id="cntTags">{sidebarCtrl.tags.length}</span>{#if tagFolderPaths.length > 0 && !filterActive}<button
          class="manage-btn fold-btn"
          title={tagAllFolded ? t("sidebar.expand_tag_folders") : t("sidebar.collapse_tag_folders")}
          aria-label={tagAllFolded ? t("sidebar.expand_tag_folders") : t("sidebar.collapse_tag_folders")}
          onclick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            sidebarCtrl.setAllFoldersCollapsed("tag", !tagAllFolded);
          }}>{#if tagAllFolded}<ChevronsUpDown class="ico" size={12} aria-hidden="true" />{:else}<ChevronsDownUp class="ico" size={12} aria-hidden="true" />{/if}</button
        >{/if}</summary
    >
    <div class="ref-list" id="refTags">
      <!-- Same "/"-segmented grouping as the branch lists: tags are just as
           conventionally path-like (`v1/rc1`, `release/2026-08`), and a repo
           with a few hundred of them is exactly where a flat list stops being
           readable. -->
      {#each buildRefRows(sidebarCtrl.tags.filter((tag) => matches(tag.name)), (tag) => tag.name, (p) => sidebarCtrl.isFolderCollapsed("tag", p), filterActive) as row (row.kind + row.path)}
        {#if row.kind === "folder"}
          <div
            class="ref-folder"
            class:collapsed={row.collapsed}
            style="--depth:{row.depth}"
            role="button"
            tabindex="0"
            aria-expanded={!row.collapsed}
            onclick={() => sidebarCtrl.toggleFolder("tag", row.path)}
            onkeydown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault(); // Space would otherwise ALSO scroll the ref list
              sidebarCtrl.toggleFolder("tag", row.path);
            }}
          >
            <span class="tw">&#9656;</span><Folder class="ico" size={12} aria-hidden="true" /><span class="rname">{row.label}</span
            ><span class="count">{row.count}</span>
          </div>
        {:else}
        {@const tag = row.item}
        <div
          class="ref-item"
          class:busy={sidebarCtrl.busy}
          style="--depth:{row.depth}"
          data-tag={tag.name}
          role="button"
          tabindex="0"
          onclick={(e) => {
            if ((e.target as HTMLElement).closest(".ref-menu")) return;
            sidebarCtrl.jumpToRef("tag", tag.name, tag.sha);
          }}
          onkeydown={(e) => {
            // Fires during bubble, so a descendant's own Enter/Space (the ⋮
            // button) reaches this handler too — bail before touching the
            // event unless it originated on the row itself, or preventDefault
            // below would cancel that descendant's own activation instead of
            // just suppressing the list's Space-scrolls.
            if (e.target !== e.currentTarget) return;
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault(); // Space would otherwise ALSO scroll the ref list
            sidebarCtrl.jumpToRef("tag", tag.name, tag.sha);
          }}
          oncontextmenu={(e) => {
            e.preventDefault();
            if (!sidebarCtrl.busy) sidebarCtrl.openTagMenu(tag.name, e.currentTarget as HTMLElement);
          }}
        >
          <span class="rname" data-fullname={tag.name}>{row.label}</span>
          {#if sidebarCtrl.busyTarget === tag.name}
            <span class="spinner"></span>
          {/if}
          <button
            class="ref-menu"
            title={t("sidebar.tag_actions")}
            aria-label={t("sidebar.tag_actions")}
            disabled={sidebarCtrl.busy}
            onclick={(e) => {
              e.stopPropagation();
              sidebarCtrl.openTagMenu(tag.name, e.currentTarget as HTMLElement);
            }}>&#8942;</button
          >
        </div>
        {/if}
      {/each}
      {#if sidebarCtrl.newTagOpen}
        <div class="nb-form" class:busy={sidebarCtrl.busy} bind:this={newTagFormEl}>
          <input
            class="nb-input"
            bind:this={newTagEl}
            bind:value={sidebarCtrl.newTagName}
            placeholder={t("sidebar.tag_name_placeholder")}
            spellcheck="false"
            autocomplete="off"
            disabled={sidebarCtrl.busy}
            onkeydown={onNewTagKeydown}
          />
          <input
            class="nb-input"
            bind:value={sidebarCtrl.newTagMessage}
            placeholder={t("sidebar.tag_message_placeholder")}
            spellcheck="false"
            autocomplete="off"
            disabled={sidebarCtrl.busy}
            onkeydown={onNewTagKeydown}
          />
          <div class="nb-row">
            <select class="nb-from" bind:value={sidebarCtrl.newTagFrom} title={t("sidebar.tag_target")} disabled={sidebarCtrl.busy} onkeydown={onNewTagKeydown}>
              <option value="">{t("sidebar.at_head")}</option>
              {#if sidebarCtrl.locals.length}
                <optgroup label={t("sidebar.local")}>
                  {#each sidebarCtrl.locals as b (b.name)}
                    <option value={b.name}>{b.name}</option>
                  {/each}
                </optgroup>
              {/if}
              {#if sidebarCtrl.remotes.length}
                <optgroup label={t("sidebar.remote")}>
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
          <span class="rname nb">&#65291; {t("sidebar.new_tag")}</span>
        </div>
      {/if}
    </div>
  </details>
  <details class="ref-group">
    <summary><span class="tw">&#9656;</span>{t("sidebar.submodules")}<span class="count" id="cntSubmodules">{sidebarCtrl.submodules.length || "—"}</span></summary>
    <div class="ref-list" id="refSubmodules">
      {#if !sidebarCtrl.submodules.length}
        <div class="sub-item"><span class="rname mut">{t("sidebar.no_submodules")}</span></div>
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
            ><input type="checkbox" bind:checked={sidebarCtrl.submodulesRecursive} disabled={sidebarCtrl.busy} /> {t("sidebar.recursive")}</label
          >
          <div class="sub-bulk-row">
            <button
              class="sub-update-all"
              disabled={sidebarCtrl.busy}
              onclick={() => sidebarCtrl.syncAllSubmodules(sidebarCtrl.submodulesRecursive)}
            >
              {#if sidebarCtrl.busy && sidebarCtrl.busyTarget === SUBMODULES_SYNC_ALL}<span class="spinner"></span>{:else}{t("sidebar.sync_all")}{/if}
            </button>
            <button
              class="sub-update-all"
              disabled={sidebarCtrl.busy}
              onclick={() => sidebarCtrl.updateAllSubmodules(sidebarCtrl.submodulesRecursive)}
            >
              {#if sidebarCtrl.busy && sidebarCtrl.busyTarget === SUBMODULES_ALL}<span class="spinner"></span>{:else}{t("sidebar.update_all")}{/if}
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
               everything else" convention — clicking anywhere on an openable
               row (canOpen) calls Open, same as clicking a branch row jumps
               the graph to its tip (a submodule row's only single-click
               action is Open, so there's no second gesture to disambiguate
               from the way there is on a branch row). -->
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
              <span class="rname mut">{t("sidebar.sub_removed_uncommitted")}</span>
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
              <span class="rname mut">{t("sidebar.sub_unreadable_cyclic")}</span>
            {:else}
              <button
                class="ref-menu"
                title={t("sidebar.submodule_actions")}
                aria-label={t("sidebar.submodule_actions")}
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
            placeholder={t("sidebar.submodule_url_placeholder")}
            spellcheck="false"
            autocomplete="off"
            disabled={sidebarCtrl.busy}
            onkeydown={onNewSubmoduleKeydown}
          />
          <input
            class="nb-input"
            bind:value={sidebarCtrl.newSubmodulePath}
            placeholder={t("sidebar.submodule_path_placeholder")}
            spellcheck="false"
            autocomplete="off"
            disabled={sidebarCtrl.busy}
            onkeydown={onNewSubmoduleKeydown}
          />
          <input
            class="nb-input"
            bind:value={sidebarCtrl.newSubmoduleBranch}
            placeholder={t("sidebar.submodule_branch_placeholder")}
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
          <span class="rname nb">&#65291; {t("sidebar.add_submodule")}</span>
        </div>
      {/if}
    </div>
  </details>
  <details class="ref-group">
    <summary><span class="tw">&#9656;</span>{t("sidebar.snapshots")}<span class="count" id="snapCount">{sidebarCtrl.snapshots.length || "—"}</span></summary>
    <div class="ref-list" id="refSnaps">
      {#if !sidebarCtrl.snapshots.length}
        <div class="ref-item"><span class="rname mut">{t("sidebar.no_snapshots")}</span></div>
      {:else}
        {#each sidebarCtrl.snapshots.slice(0, SNAP_CAP) as s (s.ref)}
          {@const sha7 = (s.sha || "").slice(0, 7) || t("sidebar.snapshot_label")}
          <div
            class="snap-item snap-clickable"
            data-tip={new Date(s.ts * 1000).toLocaleString()}
            role="button"
            tabindex="0"
            title={t("sidebar.preview_snapshot")}
            onclick={(e) => snapshotPreviewCtrl.showAt(s, e.clientX, e.clientY)}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                snapshotPreviewCtrl.showAt(s, r.right, r.top);
              }
            }}
          >
            <span class="dot" style="background:var(--accent)"></span>
            <div class="snap-main">
              <span class="snap-subject">{s.subject || t("sidebar.no_message")}</span>
              <span class="snap-meta">
                <button class="snap-sha" onclick={(e) => { e.stopPropagation(); sidebarCtrl.copySnapshotSha(s.sha); }}>{sidebarCtrl.copiedSnapshotSha === s.sha ? t("sidebar.copied_check") : sha7}</button>
                <span class="mut">&#183; {bridge.relTime(s.ts).replace(" ago", "")}</span>
              </span>
            </div>
          </div>
        {/each}
        {#if sidebarCtrl.snapshots.length > SNAP_CAP}
          <div class="ref-item"><span class="rname mut">{t("sidebar.snapshots_more", { n: sidebarCtrl.snapshots.length - SNAP_CAP })}</span></div>
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
    <button disabled={menu.isCurrent} onclick={() => { const name = menu.name; const x = menu.x, y = menu.y; sidebarCtrl.closeMenu(); sidebarCtrl.checkout(name, { x, y }); }}>{t("sidebar.checkout")}</button>
    <!-- Pushes THIS branch directly — no switching, unlike the topbar Push
         button/doPush() which always targets whatever's checked out. Shown
         for every branch (not gated by !menu.isCurrent, unlike the actions
         below) since even the current branch benefits from a from-the-
         sidebar push, e.g. while comparing several branches without
         checking any of them out. -->
    <button onclick={() => { const name = menu.name; sidebarCtrl.closeMenu(); sidebarCtrl.pushBranch(name, null); }}>{t("sidebar.push")}</button>
    <button onclick={() => { const name = menu.name; const x = menu.x, y = menu.y; sidebarCtrl.closeMenu(); sidebarCtrl.openPushMenu(name, x, y); }}>{t("sidebar.push_to")}</button>
    <!-- Force push targets the CURRENT branch (the backend force_push resolves
         its branch from HEAD), so it's offered only on the current branch. Both
         variants open their own typed-confirm danger window (see
         forcepush.svelte.ts); "override" is the raw --force. -->
    {#if menu.isCurrent}
      <button class="danger" onclick={() => { sidebarCtrl.closeMenu(); forcePushCtrl.forcePushLease(bridge.CUR_REPO as unknown as string); }}>{t("sidebar.force_push_lease")}</button>
      <button class="danger" onclick={() => { sidebarCtrl.closeMenu(); forcePushCtrl.forcePushOverride(bridge.CUR_REPO as unknown as string); }}>{t("sidebar.force_push_override")}</button>
    {/if}
    {#if !menu.isCurrent}
      <button onclick={() => { const name = menu.name; const x = menu.x, y = menu.y; sidebarCtrl.closeMenu(); sidebarCtrl.openMergeMenu(name, x, y); }}>{t("sidebar.merge_into_current")}</button>
      <button onclick={() => { const name = menu.name; sidebarCtrl.closeMenu(); sidebarCtrl.rebaseOnto(name); }}>{t("sidebar.rebase_onto")}</button>
      <button onclick={() => { const name = menu.name; sidebarCtrl.closeMenu(); sidebarCtrl.interactiveRebaseOnto(name); }}>{t("sidebar.interactive_rebase_onto")}</button>
    {/if}
    {#if menu.upstream}
      <button class="danger" onclick={() => { const name = menu.name; const upstream = menu.upstream as string; sidebarCtrl.closeMenu(); sidebarCtrl.resetToUpstream(name, upstream); }}>{t("sidebar.reset_to_upstream", { upstream: menu.upstream })}</button>
    {/if}
    <button onclick={() => { const name = menu.name; sidebarCtrl.closeMenu(); sidebarCtrl.copyBranchName(name); }}>{t("sidebar.copy_name")}</button>
    <button onclick={() => { const name = menu.name; const x = menu.x, y = menu.y; sidebarCtrl.closeMenu(); sidebarCtrl.openRenameMenu(name, x, y); }}>{t("sidebar.rename")}</button>
    <button class="danger" disabled={menu.isCurrent} onclick={() => { const name = menu.name; sidebarCtrl.closeMenu(); sidebarCtrl.deleteBranch(name); }}>{t("sidebar.delete")}</button>
  </div>
{/if}

{#if sidebarCtrl.pushMenu}
  {@const pm = sidebarCtrl.pushMenu}
  <div class="ref-pop cm-pop" bind:this={pushMenuEl} style="left:{pm.x}px;top:{pm.y}px">
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    <div class="cm-head"><span>{@html t("sidebar.push_to_head", { name: pm.name })}</span></div>
    <div class="nb-form" class:busy={sidebarCtrl.busy}>
      <input
        class="nb-input"
        bind:this={pushBranchInputEl}
        bind:value={sidebarCtrl.pushBranchInput}
        placeholder={t("sidebar.push_same_name", { name: pm.name })}
        spellcheck="false"
        autocomplete="off"
        disabled={sidebarCtrl.busy}
        onkeydown={onPushBranchKeydown}
      />
      <div class="nb-row">
        <span class="mut">{t("sidebar.enter_to_push")}</span>
        {#if sidebarCtrl.busy}<span class="spinner"></span>{/if}
      </div>
    </div>
  </div>
{/if}

{#if sidebarCtrl.renameMenu}
  {@const rm = sidebarCtrl.renameMenu}
  <div class="ref-pop cm-pop" bind:this={renameMenuEl} style="left:{rm.x}px;top:{rm.y}px">
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    <div class="cm-head"><span>{@html t("sidebar.rename_head", { name: rm.name })}</span></div>
    <div class="nb-form" class:busy={sidebarCtrl.busy}>
      <input
        class="nb-input"
        bind:this={renameInputEl}
        bind:value={sidebarCtrl.renameInput}
        placeholder={t("sidebar.new_branch_name")}
        spellcheck="false"
        autocomplete="off"
        disabled={sidebarCtrl.busy}
        onkeydown={onRenameKeydown}
      />
      <div class="nb-row">
        <span class="mut">{t("sidebar.enter_to_rename")}</span>
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
    <button onclick={() => { const name = mm.name; sidebarCtrl.closeMergeMenu(); sidebarCtrl.mergeInto(name, "auto"); }}>{t("sidebar.merge_auto")}</button>
    <button onclick={() => { const name = mm.name; sidebarCtrl.closeMergeMenu(); sidebarCtrl.mergeInto(name, "no-ff"); }}>{t("sidebar.merge_no_ff")}</button>
    <button onclick={() => { const name = mm.name; sidebarCtrl.closeMergeMenu(); sidebarCtrl.mergeInto(name, "ff-only"); }}>{t("sidebar.merge_ff_only")}</button>
    <button onclick={() => { const name = mm.name; sidebarCtrl.closeMergeMenu(); sidebarCtrl.squashInto(name); }}>{t("sidebar.merge_squash")}</button>
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
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      <span>{@html t("sidebar.dirty_overwrite", { n: dcm.files.length, files: dcm.files.length === 1 ? t("sidebar.file") : t("sidebar.files_plural"), name: dcm.name })}</span>
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
      }}>{t("sidebar.stash_switch_reapply")}</button
    >
    <button
      onclick={() => {
        const name = dcm.name, sp = dcm.startPoint;
        sidebarCtrl.closeDirtyCheckoutMenu();
        sidebarCtrl.stashSwitchLeaveStashed(name, sp);
      }}>{t("sidebar.stash_switch_leave")}</button
    >
    <button
      class="danger"
      onclick={() => {
        const name = dcm.name, sp = dcm.startPoint, n = dcm.files.length;
        sidebarCtrl.closeDirtyCheckoutMenu();
        sidebarCtrl.forceDiscardCheckout(name, sp, n);
      }}>{t("sidebar.force_switch_discard")}</button
    >
  </div>
{/if}

<!-- Opens on any branch row's double-click, and on a remote row's
     right-click/⋮ — a local row's right-click/⋮ open the branch menu
     instead, whose Checkout button calls checkout() immediately with no
     confirm (see CheckoutConfirm's own doc comment). On the routes that
     do lead here, this popover is the guard against a stray click — one
     that misses the visibility checkbox right next to the row, or just
     brushes it — switching branches with zero recourse. Reuses
     `.ref-pop.cm-pop`/`.cm-head` verbatim, same as the dirty-tree chooser
     above; no Cancel button, matching every OTHER popover here
     (menu/tagMenu/submoduleMenu/mergeMenu/dirtyCheckoutMenu) —
     outside-click dismisses it. -->
{#if sidebarCtrl.checkoutConfirm}
  {@const cc = sidebarCtrl.checkoutConfirm}
  <div class="ref-pop cm-pop" bind:this={checkoutConfirmEl} style="left:{cc.x}px;top:{cc.y}px">
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    <div class="cm-head">{@html t("sidebar.switch_to_confirm", { name: cc.name })}</div>
    <!-- Same capture-before-close rationale as the branch menu above. -->
    <button
      onclick={() => {
        const name = cc.name, remote = cc.remote, pos = { x: cc.x, y: cc.y };
        sidebarCtrl.closeCheckoutConfirm();
        if (remote) sidebarCtrl.checkoutRemote(name, pos);
        else sidebarCtrl.checkout(name, pos);
      }}>{t("sidebar.switch")}</button
    >
  </div>
{/if}

{#if sidebarCtrl.tagMenu}
  {@const tm = sidebarCtrl.tagMenu}
  <div class="ref-pop" bind:this={tagMenuEl} style="left:{tm.x}px;top:{tm.y}px">
    <!-- Same capture-before-close rationale as the branch menu above. -->
    <button onclick={() => { const name = tm.name; sidebarCtrl.closeTagMenu(); sidebarCtrl.pushTag(name); }}>{t("sidebar.push_to_origin")}</button>
    <button class="danger" onclick={() => { const name = tm.name; sidebarCtrl.closeTagMenu(); sidebarCtrl.deleteTag(name); }}>{t("sidebar.delete")}</button>
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
      <button onclick={() => { const path = sm.path, p = sm.absolutePath; sidebarCtrl.closeSubmoduleMenu(); sidebarCtrl.openSubmodule(path, p); }}>{t("sidebar.open")}</button>
    {/if}
    <!-- Sync is offered regardless of status (unlike Init/Update below) — it
         only rewrites .git/config's url, never the submodule's own working
         tree/index, so there's nothing for "dirty"/"conflicted" to block. -->
    <button onclick={() => { const p = sm.path; sidebarCtrl.closeSubmoduleMenu(); sidebarCtrl.syncSubmodule(p); }}>{t("sidebar.sync")}</button>
    {#if smAction === "init"}
      <button onclick={() => { const p = sm.path; sidebarCtrl.closeSubmoduleMenu(); sidebarCtrl.initAndUpdateSubmodule(p); }}>{t("sidebar.init_update")}</button>
    {:else if smAction === "update"}
      <button onclick={() => { const p = sm.path; sidebarCtrl.closeSubmoduleMenu(); sidebarCtrl.updateSubmodule(p); }}>{t("sidebar.update")}</button>
    {:else if smAction === "blocked"}
      <button disabled title={subBlockedTip(sm.status)}>{t("sidebar.update")}</button>
    {/if}
    <!-- Deinit/Remove — offered unconditionally like Sync (not status-gated
         the way Init/Update are): Deinit's own status-gated confirm
         decision lives in the controller (submoduleNeedsForceConfirm), and
         Remove is always final regardless of status. Ordering is
         increasing severity, Remove last. -->
    <button onclick={() => { const p = sm.path, st = sm.status; sidebarCtrl.closeSubmoduleMenu(); sidebarCtrl.deinitSubmodule(p, st); }}>{t("sidebar.deinit")}</button>
    <button class="danger" onclick={() => { const p = sm.path; sidebarCtrl.closeSubmoduleMenu(); sidebarCtrl.removeSubmodule(p); }}>{t("sidebar.remove")}</button>
  </div>
{/if}

{#if nameTip}
  <div class="rname-tip" style="left:{nameTip.x}px;top:{nameTip.y}px">{nameTip.text}</div>
{/if}
