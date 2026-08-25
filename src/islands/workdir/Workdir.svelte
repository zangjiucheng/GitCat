<script lang="ts">
  import { workdirCtrl, canBlameWorkdirFile, blameTargetForWorkdirFile, type WdTreeDir } from "./workdir.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import { blameCtrl } from "../blame/blame.svelte.ts";
  import { sidebarCtrl } from "../sidebar/sidebar.svelte.ts";
  import { fileHistoryCtrl } from "../filehistory/filehistory.svelte.ts";
  import { externalToolsCtrl } from "../externaltools/externaltools.svelte.ts";
  import BinaryDiffPreview from "../diffpreview/BinaryDiffPreview.svelte";
  import { previewKind } from "../diffpreview/preview-kind";
  import { t } from "@/i18n/i18n.svelte.ts";
  import Eye from "@lucide/svelte/icons/eye";
  import History from "@lucide/svelte/icons/history";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Folder from "@lucide/svelte/icons/folder";
  import ChevronsDownUp from "@lucide/svelte/icons/chevrons-down-up";
  import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
  import Maximize2 from "@lucide/svelte/icons/maximize-2";
  import Splitter from "../detailpanel/Splitter.svelte";
  import TabStrip from "../detailpanel/TabStrip.svelte";
  import { detailPanelCtrl, WORKTREE_VIEW_TABS, WORKTREE_CHANGES_SPLIT } from "../detailpanel/detailpanel.svelte.ts";

  // "Open in external diff" (backlog #12) — added to BOTH staged (4th icon,
  // was 3) and unstaged (5th icon, was 4) rows: unlike Blame/History (which
  // need HEAD's own committed tree — see canBlameWorkdirFile's own doc
  // comment), a diff tool is exactly as meaningful for an unstaged edit as a
  // staged one, and the un-diffable case for THIS button is narrower — only
  // an untracked ("?") row has no `git diff`-visible content at all against
  // the index/HEAD (a new file has nothing to compare yet), disabled below
  // exactly like that one status is also excluded from Blame/History.
  const STATUS_LABEL: Record<string, string> = { A: "A", M: "M", D: "D", R: "R", T: "T", "?": "U" };

  function repo(): string {
    return bridge.CUR_REPO as unknown as string;
  }

  // Repo-relative paths that are submodules (from the sidebar's already-loaded
  // submodule list) — so a submodule that shows up here as a plain "M" gets a
  // clear "submodule" badge instead of looking like an ordinary modified file.
  // A submodule in the working-tree status IS the dirty case (its own tree has
  // uncommitted changes, or its recorded commit moved).
  const submodulePaths = $derived(new Set(sidebarCtrl.submodules.map((s) => s.path)));

  // BUG FIX: same "stale scroll position carries over to the next file's
  // diff" issue Detail.svelte's own #diffview has, and for the identical
  // reason — the {#if workdirCtrl.selectedDiffFile} block below stays
  // truthy across a staged/unstaged file switch, so .diffview is the SAME
  // DOM node for every file, not recreated; the browser keeps whatever
  // scrollLeft/scrollTop the PREVIOUS file's diff left it at. See Detail.svelte's
  // own copy of this fix for the full writeup.
  let diffviewEl = $state<HTMLDivElement | undefined>(undefined);
  // Second .diffview instance for the expanded-diff modal below (same reset).
  let diffviewExpandedEl = $state<HTMLDivElement | undefined>(undefined);

  // The commit message box is natively resizable (CSS resize:vertical), but the
  // height reset on every remount/app restart. Persist it: restore the saved
  // height on mount, and save it (debounced) as the user drags — same
  // remembered-size spirit as the diff modal's tree width.
  const WD_MSG_H_LS = "gitcat.wdMsgH",
    WD_MSG_H_MIN = 52;
  let msgEl = $state<HTMLTextAreaElement | undefined>(undefined);
  $effect(() => {
    const el = msgEl;
    if (!el) return;
    const saved = Number(localStorage.getItem(WD_MSG_H_LS));
    if (Number.isFinite(saved) && saved >= WD_MSG_H_MIN) el.style.height = saved + "px";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          localStorage.setItem(WD_MSG_H_LS, String(Math.round(el.offsetHeight)));
        } catch {
          /* private mode / quota — height just won't persist */
        }
      }, 200);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
    };
  });
  $effect(() => {
    workdirCtrl.selectedDiffFile;
    if (diffviewEl) {
      diffviewEl.scrollLeft = 0;
      diffviewEl.scrollTop = 0;
    }
    if (diffviewExpandedEl) {
      diffviewExpandedEl.scrollLeft = 0;
      diffviewExpandedEl.scrollTop = 0;
    }
  });

  // Expand the uncommitted-changes diff into the same near-fullscreen modal the
  // commit view uses (see Detail.svelte's .diffx) — a bigger window for reading
  // a large working-tree change, with the staged/unstaged file lists on the left
  // and the full per-hunk / per-line staging kept intact on the right.
  // State lives on the controller so the canvas can open this too: double-
  // clicking the pinned workdir band calls workdirCtrl.expandDiff(), the same
  // way double-clicking a commit row calls detailCtrl.expandDiff().
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && workdirCtrl.diffExpanded) {
      workdirCtrl.collapseDiff();
      e.stopPropagation();
    }
  }

  // Resizable file-list panel in that modal — used to be a complete second
  // inline copy of Detail.svelte's own diffx splitter (same constants, same
  // hand-rolled .diffx-splitter markup+a11y attributes, same storage key),
  // left that way until this file's Task 8 restructuring made touching it
  // unavoidable anyway. Now the shared Splitter component, with the exact
  // constants the old copy used (min 160 / max 620 / default 280) and the
  // SAME storage key ("gitcat.diffxTreeW") — both this modal and Detail.svelte's
  // own expanded-diff modal already shared that key, so keeping it exact
  // preserves whichever width the user last dragged instead of silently
  // resetting it.
  let diffxTreeW = $state(280);

  // The "changes" tab's own file-list/diff Splitter (Task 8) — a separate
  // pane from the expanded-diff modal's diffxTreeW above, sized by
  // WORKTREE_CHANGES_SPLIT (detailpanel.svelte.ts) rather than CHANGES_SPLIT:
  // this file-list column stacks the staged AND unstaged trees, not the
  // commit view's one, so it needs its own bounds — see that constant's own
  // doc comment for the full reasoning. Seeded from whichever axis is
  // current; Splitter.svelte overwrites this from storage on mount, and the
  // {#key detailPanelCtrl.changesSplitAxis} wrapper below remounts it
  // (re-seeding from the OTHER axis's own storage) whenever the placement
  // changes live, rather than carrying one axis's pixel value over as the
  // other's — exact same convention as Detail.svelte's own "changes" tab.
  let filesSize = $state(WORKTREE_CHANGES_SPLIT[detailPanelCtrl.changesSplitAxis].defaultSize);
</script>

<svelte:window on:keydown={onKeydown} />

{#if workdirCtrl.selected}
  <!-- The working tree's three tabs (Task 8): the six sections that used to
       stack in this panel — most crampingly in the right-hand column, the
       default, where they competed for a 344px width — now split into the
       commit box, the staged/unstaged trees beside their diff, and the
       stash (previously the last section, requiring a scroll to reach; now
       one click). Same TabStrip/detailPanelCtrl registry Task 7 gave the
       commit view, so both views share one tab-strip implementation. -->
  <TabStrip
    tabs={WORKTREE_VIEW_TABS}
    active={detailPanelCtrl.worktreeTab}
    onselect={(id) => detailPanelCtrl.select("worktree", id)}
  />

  <!-- .d-view (index.html): the panel is a flex column and this is the item
       that takes whatever height the tab strip leaves, so the "changes" tab's
       diff below can fill a taller panel instead of stopping at .diffview's
       320px cap. It is also this tab content's own scroller — the panel used
       to be that — so a tab of stacked sections still scrolls. Detail.svelte's
       commit view wraps its own tabs the same way. -->
  <div class="d-view">
  {#if detailPanelCtrl.worktreeTab === "commit"}
  <section>
    <div class="d-subject">{t("workdir.uncommitted_changes")}</div>
    <div class="d-body" style="margin-top:2px">
      {#if workdirCtrl.status?.branch}
        {t("workdir.on")} <b class="mono">{workdirCtrl.status.branch}</b>
      {:else}
        {t("workdir.detached_head")}
      {/if}
    </div>
    <div class="id-strip">
      {#if workdirCtrl.status}
        {@const s = workdirCtrl.status}
        {#if s.conflicted}
          <span class="gpg bad">{t("workdir.n_conflicted", { n: s.conflicted })}</span>
        {:else if s.staged.length || s.unstaged.length}
          <span class="hash">{t("workdir.staged_unstaged", { staged: s.staged.length, unstaged: s.unstaged.length })}</span>
        {:else}
          <span class="gpg good">&#10003; {t("workdir.clean")}</span>
        {/if}
      {/if}
      {#if workdirCtrl.loading}<span class="spinner"></span>{/if}
    </div>
    {#if workdirCtrl.status?.conflicted}
      <div class="pl-err" style="margin-top:10px">
        {t("workdir.conflicted_hint", { n: workdirCtrl.status.conflicted, files: workdirCtrl.status.conflicted === 1 ? t("workdir.file") : t("workdir.files_plural") })}
      </div>
    {/if}
  </section>

  <section>
    <div class="d-lab-row">
      <h4 class="d-lab" style="margin:0">{t("workdir.commit")}</h4>
      <button
        class="wd-stage-all"
        title={t("workdir.generate_tip")}
        disabled={workdirCtrl.busy && workdirCtrl.busyTarget === "__commit__"}
        onclick={() => workdirCtrl.generateMessage(repo())}
      >
        {#if workdirCtrl.generating}<span class="spinner"></span> {t("workdir.generating")}{:else}&#10024; {t("workdir.generate")}{/if}
      </button>
    </div>
    <textarea
      class="wd-msg"
      rows="3"
      bind:this={msgEl}
      placeholder={workdirCtrl.amend ? t("workdir.msg_placeholder_amend") : t("workdir.msg_placeholder")}
      bind:value={workdirCtrl.message}
      disabled={workdirCtrl.busy && workdirCtrl.busyTarget === "__commit__"}
    ></textarea>
    <div class="wd-commit-row">
      <label class="wd-amend"
        ><input type="checkbox" bind:checked={workdirCtrl.amend} disabled={workdirCtrl.busy && workdirCtrl.busyTarget === "__commit__"} /> {t("workdir.amend_previous")}</label
      >
      <button
        class="btn"
        disabled={(workdirCtrl.busy && workdirCtrl.busyTarget === "__commit__") || (!workdirCtrl.amend && !workdirCtrl.message.trim())}
        onclick={() => workdirCtrl.commit(repo())}
      >
        {#if workdirCtrl.busy && workdirCtrl.busyTarget === "__commit__"}<span class="spinner"></span>{/if}
        {workdirCtrl.amend ? t("workdir.amend") : t("workdir.commit_btn")}
      </button>
    </div>
  </section>
  {:else if detailPanelCtrl.worktreeTab === "changes"}
  <!-- The "changes" tab: staged + unstaged trees beside their diff, same
       .d-split/.d-split-files/.d-split-diff rules Detail.svelte's own
       "changes" tab uses (index.html) — the axis is the only thing the
       placement changes, read from detailPanelCtrl.changesSplitAxis (never a
       local derivation — see that field's own doc comment on why a
       $derived reading a DOM attribute can't track it). Keyed on the axis so
       a live placement switch remounts the Splitter and re-seeds `filesSize`
       from THAT axis's own storage key. -->
  {#key detailPanelCtrl.changesSplitAxis}
  <div class="d-split">
    <div
      class="d-split-files"
      style={detailPanelCtrl.changesSplitAxis === "x" ? `width:${filesSize}px` : `height:${filesSize}px`}
    >
  <section>
    <div class="wd-sec-head">
      <h4 class="d-lab" style="margin:0">{t("workdir.staged", { n: workdirCtrl.status?.staged.length ?? 0 })}</h4>
      <div class="wd-sec-actions">
        {@render treeCtl("staged", workdirCtrl.stagedHasDirs)}
        {#if workdirCtrl.status?.staged.length}
          <button class="wd-stage-all" disabled={workdirCtrl.busy} onclick={() => workdirCtrl.unstageAll(repo())}>
            {#if workdirCtrl.busy && workdirCtrl.busyTarget === "__unstage_all__"}<span class="spinner"></span>{:else}{t("workdir.unstage_all")}{/if}
          </button>
        {/if}
      </div>
    </div>
    {#if !workdirCtrl.status?.staged.length}
      <div class="mut" style="font-size:12px">{t("workdir.nothing_staged")}</div>
    {:else}
      <div class="wd-files tree">
        {@render stagedDirNode(workdirCtrl.stagedTree)}
      </div>
    {/if}
  </section>

  <section>
    <div class="wd-sec-head">
      <h4 class="d-lab" style="margin:0">{t("workdir.unstaged", { n: workdirCtrl.status?.unstaged.length ?? 0 })}</h4>
      <div class="wd-sec-actions">
        {@render treeCtl("unstaged", workdirCtrl.unstagedHasDirs)}
        {#if workdirCtrl.status?.unstaged.length}
          <button class="wd-stage-all" disabled={workdirCtrl.busy} onclick={() => workdirCtrl.stageAll(repo())}>
            {#if workdirCtrl.busy && workdirCtrl.busyTarget === "__all__"}<span class="spinner"></span>{:else}{t("workdir.stage_all")}{/if}
          </button>
        {/if}
        {#if workdirCtrl.hasChanges}
          <button
            class="wd-stage-all wd-discard-all"
            disabled={workdirCtrl.busy}
            title={t("workdir.discard_all_tip")}
            onclick={() => workdirCtrl.discardAll(repo())}
          >
            {#if workdirCtrl.busy && workdirCtrl.busyTarget === "__discard_all__"}<span class="spinner"></span>{:else}{t("workdir.discard_all")}{/if}
          </button>
        {/if}
      </div>
    </div>
    {#if !workdirCtrl.status?.unstaged.length}
      <div class="mut" style="font-size:12px">{t("workdir.no_unstaged")}</div>
    {:else}
      <div class="wd-files tree">
        {@render unstagedDirNode(workdirCtrl.unstagedTree)}
      </div>
    {/if}
  </section>
    </div>
    <Splitter
      axis={detailPanelCtrl.changesSplitAxis}
      bind:size={filesSize}
      min={WORKTREE_CHANGES_SPLIT[detailPanelCtrl.changesSplitAxis].min}
      max={WORKTREE_CHANGES_SPLIT[detailPanelCtrl.changesSplitAxis].max}
      defaultSize={WORKTREE_CHANGES_SPLIT[detailPanelCtrl.changesSplitAxis].defaultSize}
      label={t("workdir.resize_file_list")}
      storageKey={WORKTREE_CHANGES_SPLIT[detailPanelCtrl.changesSplitAxis].storageKey}
    />
    <div class="d-split-diff">
  {#if workdirCtrl.selectedDiffFile}
    {@const file = workdirCtrl.selectedDiffFile}
    <section>
      <div class="wd-sec-head">
        <h4 class="d-lab" style="margin:0">{t("workdir.diff")}</h4>
        {@render workdirLinesBar(file)}
        <button class="wd-act" title={t("workdir.expand_diff")} aria-label={t("workdir.expand_diff_aria")} onclick={() => workdirCtrl.expandDiff()}>
          <Maximize2 class="ico" size={13} aria-hidden="true" />
        </button>
      </div>
      <div class="diffview" bind:this={diffviewEl}>
        {@render workdirDiffBody(file)}
      </div>
    </section>
  {/if}
    </div>
  </div>
  {/key}
  {:else}
  <section>
    <div class="wd-sec-head">
      <h4 class="d-lab" style="margin:0">{t("workdir.stash")}</h4>
    </div>
    {#if !workdirCtrl.stashes.length}
      <div class="mut" style="font-size:12px">{t("workdir.no_stashes")}</div>
    {:else}
      <div class="wd-stash-list">
        {#each workdirCtrl.stashes as s (s.index)}
          <div class="wd-stash-item">
            <span class="dot" style="background:var(--accent2)"></span>
            <div class="wd-stash-main">
              <span class="wd-stash-msg">{s.message || t("workdir.no_message")}</span>
              <span class="wd-stash-meta mut mono">stash@{"{" + s.index + "}"} &#183; {s.sha}{s.branch ? " · " + s.branch : ""}</span>
            </div>
            {#if workdirCtrl.stashBusy && workdirCtrl.stashBusyTarget === s.index}
              <span class="spinner"></span>
            {:else}
              <div class="wd-stash-act">
                <button title={t("workdir.stash_apply_tip")} disabled={workdirCtrl.stashBusy} onclick={() => workdirCtrl.applyStash(repo(), s.index)}>{t("workdir.apply")}</button>
                <button title={t("workdir.stash_pop_tip")} disabled={workdirCtrl.stashBusy} onclick={() => workdirCtrl.popStash(repo(), s.index)}>{t("workdir.pop")}</button>
                <button
                  class="danger"
                  title={t("workdir.stash_drop_tip")}
                  disabled={workdirCtrl.stashBusy}
                  onclick={() => workdirCtrl.confirmDropStash(repo(), s.index)}><Trash2 class="ico" size={12} aria-hidden="true" /></button
                >
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if workdirCtrl.stashOpen}
      <div class="wd-stash-form" class:busy={workdirCtrl.busy && workdirCtrl.busyTarget === "__stash__"}>
        <input
          placeholder={t("workdir.stash_msg_placeholder")}
          spellcheck="false"
          autocomplete="off"
          bind:value={workdirCtrl.stashMessage}
          disabled={workdirCtrl.busy && workdirCtrl.busyTarget === "__stash__"}
          onkeydown={(e) => e.key === "Enter" && workdirCtrl.saveStash(repo())}
        />
        <div class="nb-row">
          <label class="wd-amend"
            ><input
              type="checkbox"
              bind:checked={workdirCtrl.stashIncludeUntracked}
              disabled={workdirCtrl.busy && workdirCtrl.busyTarget === "__stash__"}
            /> {t("workdir.include_untracked")}</label
          >
          {#if workdirCtrl.busy && workdirCtrl.busyTarget === "__stash__"}
            <span class="spinner"></span>
          {:else}
            <button class="btn ghost" style="padding:4px 10px" onclick={() => workdirCtrl.cancelStashForm()}>{t("common.cancel")}</button>
            <button class="btn" style="padding:4px 10px" onclick={() => workdirCtrl.saveStash(repo())}>{t("common.save")}</button>
          {/if}
        </div>
      </div>
    {:else}
      <button class="wd-stash-new" onclick={() => workdirCtrl.openStashForm()}>&#65291; {t("workdir.stash_changes")}</button>
    {/if}
  </section>
  {/if}
  </div>

  <!-- Expanded uncommitted-changes diff — the SAME near-fullscreen .diffx modal
       the commit view uses (see Detail.svelte), for reading a big working-tree
       change comfortably: the staged/unstaged file lists on the left, the
       selected file's diff (with the full per-hunk / per-line staging intact) on
       the right. A top-level scrim so it's a direct child of .detail, same as
       the commit modal (index.html's `.detail.collapsed>*:not(.scrim)` exempts
       it from the Focus-mode panel collapse). -->
  <div class="scrim" class:on={workdirCtrl.diffExpanded}>
    <div class="modal diffx">
      <div class="modal-head">
        <div class="diffx-head-main">
          <h3>{t("workdir.uncommitted_changes")}</h3>
          <p>{#if workdirCtrl.status?.branch}{t("workdir.on")} <span class="mono">{workdirCtrl.status.branch}</span>{:else}{t("workdir.detached_head")}{/if}</p>
        </div>
      </div>
      <div class="modal-body diffx-body">
        <div class="diffx-files" style="width:{diffxTreeW}px">
          <div class="diffx-files-scroll tree" data-vimnav-list>
            <div class="diffx-files-head">
              <span class="d-lab" style="margin:0">{t("workdir.staged", { n: workdirCtrl.status?.staged.length ?? 0 })}</span>
              <div class="wd-sec-actions">
                {@render treeCtl("staged", workdirCtrl.stagedHasDirs)}
                {#if workdirCtrl.status?.staged.length}
                  <button class="wd-stage-all" disabled={workdirCtrl.busy} onclick={() => workdirCtrl.unstageAll(repo())}>
                    {#if workdirCtrl.busy && workdirCtrl.busyTarget === "__unstage_all__"}<span class="spinner"></span>{:else}{t("workdir.unstage_all")}{/if}
                  </button>
                {/if}
              </div>
            </div>
            {#if !workdirCtrl.status?.staged.length}
              <div class="mut" style="font-size:12px;padding:2px 4px">{t("workdir.nothing_staged")}</div>
            {:else}
              {@render stagedDirNode(workdirCtrl.stagedTree)}
            {/if}
            <div class="diffx-files-head" style="margin-top:12px">
              <span class="d-lab" style="margin:0">{t("workdir.unstaged", { n: workdirCtrl.status?.unstaged.length ?? 0 })}</span>
              <div class="wd-sec-actions">
                {@render treeCtl("unstaged", workdirCtrl.unstagedHasDirs)}
                {#if workdirCtrl.status?.unstaged.length}
                  <button class="wd-stage-all" disabled={workdirCtrl.busy} onclick={() => workdirCtrl.stageAll(repo())}>
                    {#if workdirCtrl.busy && workdirCtrl.busyTarget === "__all__"}<span class="spinner"></span>{:else}{t("workdir.stage_all")}{/if}
                  </button>
                {/if}
              </div>
            </div>
            {#if !workdirCtrl.status?.unstaged.length}
              <div class="mut" style="font-size:12px;padding:2px 4px">{t("workdir.no_unstaged")}</div>
            {:else}
              {@render unstagedDirNode(workdirCtrl.unstagedTree)}
            {/if}
          </div>
        </div>
        <Splitter
          axis="x"
          bind:size={diffxTreeW}
          min={160}
          max={620}
          defaultSize={280}
          label={t("workdir.resize_file_list")}
          storageKey="gitcat.diffxTreeW"
        />
        <div class="diffview diffx-diff" bind:this={diffviewExpandedEl}>
          {#if workdirCtrl.selectedDiffFile}
            {@const file = workdirCtrl.selectedDiffFile}
            {@render workdirLinesBar(file)}
            {@render workdirDiffBody(file)}
          {:else}
            <div class="diff-file-h mut">{t("workdir.select_file_hint")}</div>
          {/if}
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" onclick={() => workdirCtrl.collapseDiff()}>{t("common.close")}</button>
      </div>
    </div>
  </div>
{/if}

<!-- Per-file right-click menu (opened from an unstaged file row's contextmenu).
     A transparent full-screen backdrop dismisses it on the next click/right-
     click, like the app's other popovers. -->
{#if workdirCtrl.rowMenu}
  <div
    class="wd-rowmenu-backdrop"
    role="presentation"
    onclick={() => workdirCtrl.closeRowMenu()}
    oncontextmenu={(e) => {
      e.preventDefault();
      workdirCtrl.closeRowMenu();
    }}
  ></div>
  <div class="wd-rowmenu" style="left:{workdirCtrl.rowMenu.x}px; top:{workdirCtrl.rowMenu.y}px">
    <button
      class="wd-rowmenu-item danger"
      disabled={workdirCtrl.busy}
      onclick={() => {
        const m = workdirCtrl.rowMenu;
        workdirCtrl.closeRowMenu();
        if (m) workdirCtrl.confirmDiscard(m.file, m.untracked);
      }}>{t("workdir.discard_changes")}</button
    >
  </div>
{/if}

<!-- The uncommitted-changes Diff, reused by the inline panel above and the
     expanded .diffx modal: a "lines selected" action bar and the file's diff
     body (per-hunk toolbar + per-line staging checkboxes). -->
{#snippet workdirLinesBar(file: string)}
  {#if workdirCtrl.hasSelectableLines}
    <div class="wd-lines-bar">
      <!-- Select all / Deselect all: one toggle to grab every +/- line in the
           diff or clear the whole selection, so a per-hunk selection can be
           reset and re-picked without clicking each checkbox. -->
      <button
        class="wd-sel-toggle"
        disabled={workdirCtrl.busy}
        onclick={() => (workdirCtrl.selectedLinesCount ? workdirCtrl.deselectAllLines() : workdirCtrl.selectAllLines())}
        >{workdirCtrl.selectedLinesCount ? t("workdir.deselect_all") : t("workdir.select_all")}</button
      >
      {#if workdirCtrl.selectedLinesCount}
        <span class="mut" style="font-size:11.5px">{t("workdir.lines_selected", { n: workdirCtrl.selectedLinesCount, line: workdirCtrl.selectedLinesCount === 1 ? t("workdir.line") : t("workdir.lines_plural") })}</span>
        {#if workdirCtrl.busy && workdirCtrl.busyTarget === file}
          <span class="spinner"></span>
        {:else if !workdirCtrl.selectedDiffStaged}
          <button disabled={workdirCtrl.busy} onclick={() => workdirCtrl.stageLines(repo(), file, workdirCtrl.buildSelectedHunks())}>{t("workdir.stage_selected")}</button>
          <button class="danger" disabled={workdirCtrl.busy} onclick={() => workdirCtrl.confirmDiscardLines(file, workdirCtrl.buildSelectedHunks())}>{t("workdir.discard_selected")}</button>
        {:else}
          <button disabled={workdirCtrl.busy} onclick={() => workdirCtrl.unstageLines(repo(), file, workdirCtrl.buildSelectedHunks())}>{t("workdir.unstage_selected")}</button>
        {/if}
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet workdirDiffBody(file: string)}
  {#if workdirCtrl.diffLoading}
    <div class="diff-file-h mut"><span class="spinner"></span> {t("workdir.loading_diff")}</div>
  {:else if workdirCtrl.diffError}
    <div class="diff-file-h">{workdirCtrl.diffHeader}</div>
    <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut">{workdirCtrl.diffError}</code></div>
  {:else if workdirCtrl.diffFile}
    <div class="diff-file-h">{workdirCtrl.diffHeader}</div>
    <div class="diff-rows">
      {#if workdirCtrl.diffFile.binary}
        {#if previewKind(workdirCtrl.diffFile.path)}
          <!-- #37: image/PDF visual before/after. Sides depend on which diff
               is shown: staged is HEAD->index, unstaged is index->workdir. -->
          <BinaryDiffPreview
            repo={repo()}
            path={workdirCtrl.diffFile.path}
            oldPath={workdirCtrl.diffFile.oldPath ?? null}
            newRev={workdirCtrl.selectedDiffStaged ? ":index" : ":workdir"}
            oldRev={workdirCtrl.selectedDiffStaged ? "HEAD" : ":index"}
            externalStaged={workdirCtrl.selectedDiffStaged}
          />
        {:else}
          <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut">{t("workdir.binary_not_shown")}</code></div>
        {/if}
      {:else if !workdirCtrl.diffHunks.length}
        <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut">{t("workdir.no_textual_diff")}</code></div>
      {:else}
        {#each workdirCtrl.diffHunks as hunk (hunk.header)}
          <div class="diff-line hunk">
            <span class="ln"></span><span class="sel"></span><span class="mk"></span><code>{hunk.header}</code>
            <span class="wd-hunk-act">
              {#if workdirCtrl.busy && workdirCtrl.busyTarget === file}
                <span class="spinner"></span>
              {:else if !workdirCtrl.selectedDiffStaged}
                <button disabled={workdirCtrl.busy} onclick={() => workdirCtrl.stageLines(repo(), file, [workdirCtrl.hunkSelectionFor(hunk)])}>{t("workdir.stage_hunk")}</button>
                <button class="danger" disabled={workdirCtrl.busy} onclick={() => workdirCtrl.confirmDiscardLines(file, [workdirCtrl.hunkSelectionFor(hunk)])}>{t("workdir.discard_hunk")}</button>
              {:else}
                <button disabled={workdirCtrl.busy} onclick={() => workdirCtrl.unstageLines(repo(), file, [workdirCtrl.hunkSelectionFor(hunk)])}>{t("workdir.unstage_hunk")}</button>
              {/if}
            </span>
          </div>
          {#each hunk.lines as line, idx (line.kind + ":" + line.oldNo + ":" + line.newNo)}
            {@const sel = workdirCtrl.isLineSelected(hunk.header, line)}
            <div
              class="diff-line {line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : ''}"
              class:selected={sel}
            >
              <span class="ln">{line.kind === "+" ? line.newNo : line.kind === "-" ? line.oldNo : (line.newNo ?? line.oldNo)}</span>
              <span class="sel">
                {#if line.kind === "+" || line.kind === "-"}
                  <input
                    type="checkbox"
                    checked={sel}
                    disabled={workdirCtrl.busy}
                    onclick={(e) => {
                      e.stopPropagation();
                      workdirCtrl.toggleLine(hunk.header, hunk.lines, idx, e.shiftKey);
                    }}
                    aria-label={t("workdir.select_line", { kind: line.kind === "+" ? t("workdir.added") : t("workdir.removed"), n: line.kind === "+" ? line.newNo : line.oldNo })}
                  />
                {/if}
              </span>
              <span class="mk">{line.kind === "+" || line.kind === "-" ? line.kind : ""}</span>
              <code>{@html line.html}</code>
            </div>
          {/each}
        {/each}
        {#if workdirCtrl.diffFile.truncated}
          <div class="diff-line"><span class="ln"></span><span class="sel"></span><span class="mk"></span><code class="mut">&#8230; {t("workdir.diff_truncated")}</code></div>
        {/if}
      {/if}
    </div>
  {/if}
{/snippet}

<!-- Staged/unstaged folder-tree rendering (see workdir.svelte.ts's buildWdTree
     doc comment) — two near-identical recursive snippets, one per section,
     rather than one parameterized by a `staged` flag: their action buttons
     genuinely differ (Unstage vs. Stage+Discard, and only unstaged rows
     disable "Open in external diff" for an untracked "?" row), so factoring
     them into one shared snippet would just replace this duplication with an
     equivalent pile of conditionals — same "duplicate the small per-row
     logic" convention Detail.svelte's own dirNode snippet already follows in
     spirit. Both reuse the SAME .tree/.dir/.indent/.tw folder CSS Detail.svelte
     already established (index.html) — leaf rows keep the existing .wd-file/
     .wd-path/.wd-act classes UNCHANGED (not Detail's .file/.fname/.badge,
     which assume a diffstat this WorkdirEntry shape doesn't have), so every
     existing status-color/hover/active/action-button rule keeps applying
     exactly as it did in the old flat list. A rename shows its full
     "oldPath → path" (unambiguous even when a rename crosses directories);
     an ordinary file shows just its own leaf name, since the tree structure
     already conveys the directory — title keeps the full path either way. -->
{#snippet treeCtl(section: "staged" | "unstaged", hasDirs: boolean)}
  {#if hasDirs}
    <button class="wd-act" title={t("workdir.collapse_all_folders")} aria-label={t("workdir.collapse_all_folders")} onclick={() => workdirCtrl.collapseAll(section)}>
      <ChevronsDownUp class="ico" size={14} aria-hidden="true" />
    </button>
    <button class="wd-act" title={t("workdir.expand_all_folders")} aria-label={t("workdir.expand_all_folders")} onclick={() => workdirCtrl.expandAll(section)}>
      <ChevronsUpDown class="ico" size={14} aria-hidden="true" />
    </button>
  {/if}
{/snippet}

{#snippet stagedDirNode(node: WdTreeDir)}
  {#each Object.entries(node.dirs) as [name, child] (child.path)}
    <details
      class="dir"
      open={!workdirCtrl.isDirCollapsed("staged", child.path)}
      ontoggle={(e) => workdirCtrl.setDirOpen("staged", child.path, (e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary
        ><span class="tw">&#9656;</span><Folder class="ico" size={13} aria-hidden="true" /><span class="wd-path">{name}</span>
        {#if workdirCtrl.busyTarget === child.path}
          <span class="spinner"></span>
        {:else}
          <!-- Unstage the whole folder in one go (git restore --staged on the
               directory) instead of file by file. preventDefault/stopPropagation
               so the click stages, not toggles the folder open/closed. -->
          <button
            class="wd-act"
            title={t("workdir.unstage_folder")}
            aria-label={t("workdir.unstage_folder_named", { path: child.path })}
            disabled={workdirCtrl.busy}
            onclick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              workdirCtrl.unstageFile(repo(), child.path);
            }}>&#8722;</button
          >
        {/if}</summary
      >
      <div class="indent">{@render stagedDirNode(child)}</div>
    </details>
  {/each}
  {#each node.files as f (f.path)}
    <div
      class="wd-file"
      class:active={workdirCtrl.selectedDiffFile === f.path && workdirCtrl.selectedDiffStaged}
      role="button"
      tabindex="0"
      onclick={() => workdirCtrl.selectDiffFile(f.path, true)}
      onkeydown={(e) => (e.key === "Enter" || e.key === " ") && workdirCtrl.selectDiffFile(f.path, true)}
    >
      <span class="st" data-status={f.status}>{STATUS_LABEL[f.status] ?? f.status}</span>
      <span class="wd-path" title={f.path}>{f.oldPath ? f.oldPath + " → " + f.path : f.name}</span>
      {#if submodulePaths.has(f.path)}
        <span class="wd-sub" title={t("workdir.submodule_tip")}>{t("workdir.submodule")}</span>
      {/if}
      {#if workdirCtrl.busyTarget === f.path}
        <span class="spinner"></span>
      {:else}
        <button
          class="wd-act"
          title={t("workdir.blame")}
          aria-label={t("workdir.blame_file", { path: f.path })}
          disabled={workdirCtrl.busy || !canBlameWorkdirFile(f)}
          onclick={(e) => {
            e.stopPropagation();
            blameCtrl.openFor(repo(), null, blameTargetForWorkdirFile(f), null);
          }}><Eye class="ico" size={14} aria-hidden="true" /></button
        >
        <button
          class="wd-act"
          title={t("workdir.history")}
          aria-label={t("workdir.history_file", { path: f.path })}
          disabled={workdirCtrl.busy || !canBlameWorkdirFile(f)}
          onclick={(e) => {
            e.stopPropagation();
            fileHistoryCtrl.openFor(repo(), null, blameTargetForWorkdirFile(f));
          }}><History class="ico" size={14} aria-hidden="true" /></button
        >
        <button
          class="wd-act"
          title={t("workdir.unstage")}
          aria-label={t("workdir.unstage_named", { path: f.path })}
          disabled={workdirCtrl.busy}
          onclick={(e) => {
            e.stopPropagation();
            workdirCtrl.unstageFile(repo(), f.path);
          }}>&#8722;</button
        >
        <button
          class="wd-act"
          title={t("workdir.open_external_diff")}
          aria-label={t("workdir.open_external_diff_for", { path: f.path })}
          disabled={workdirCtrl.busy}
          onclick={(e) => {
            e.stopPropagation();
            externalToolsCtrl.openDiff(repo(), f.path, true);
          }}><ExternalLink class="ico" size={14} aria-hidden="true" /></button
        >
      {/if}
    </div>
  {/each}
{/snippet}

{#snippet unstagedDirNode(node: WdTreeDir)}
  {#each Object.entries(node.dirs) as [name, child] (child.path)}
    <details
      class="dir"
      open={!workdirCtrl.isDirCollapsed("unstaged", child.path)}
      ontoggle={(e) => workdirCtrl.setDirOpen("unstaged", child.path, (e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary
        ><span class="tw">&#9656;</span><Folder class="ico" size={13} aria-hidden="true" /><span class="wd-path">{name}</span>
        {#if workdirCtrl.busyTarget === child.path}
          <span class="spinner"></span>
        {:else}
          <!-- Stage the whole folder in one go (git add on the directory)
               instead of file by file. preventDefault/stopPropagation so the
               click stages, not toggles the folder open/closed. -->
          <button
            class="wd-act"
            title={t("workdir.stage_folder")}
            aria-label={t("workdir.stage_folder_named", { path: child.path })}
            disabled={workdirCtrl.busy}
            onclick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              workdirCtrl.stageFile(repo(), child.path);
            }}>&#65291;</button
          >
        {/if}</summary
      >
      <div class="indent">{@render unstagedDirNode(child)}</div>
    </details>
  {/each}
  {#each node.files as f (f.path)}
    <div
      class="wd-file"
      class:active={workdirCtrl.selectedDiffFile === f.path && !workdirCtrl.selectedDiffStaged}
      role="button"
      tabindex="0"
      onclick={() => workdirCtrl.selectDiffFile(f.path, false)}
      onkeydown={(e) => (e.key === "Enter" || e.key === " ") && workdirCtrl.selectDiffFile(f.path, false)}
      oncontextmenu={(e) => {
        e.preventDefault();
        workdirCtrl.openRowMenu(f.path, f.status === "?", e.clientX, e.clientY);
      }}
    >
      <span class="st" data-status={f.status}>{STATUS_LABEL[f.status] ?? f.status}</span>
      <span class="wd-path" title={f.path}>{f.oldPath ? f.oldPath + " → " + f.path : f.name}</span>
      {#if submodulePaths.has(f.path)}
        <span class="wd-sub" title={t("workdir.submodule_tip")}>{t("workdir.submodule")}</span>
      {/if}
      {#if workdirCtrl.busyTarget === f.path}
        <span class="spinner"></span>
      {:else}
        <button
          class="wd-act"
          title={t("workdir.blame")}
          aria-label={t("workdir.blame_file", { path: f.path })}
          disabled={workdirCtrl.busy || !canBlameWorkdirFile(f)}
          onclick={(e) => {
            e.stopPropagation();
            blameCtrl.openFor(repo(), null, blameTargetForWorkdirFile(f), null);
          }}><Eye class="ico" size={14} aria-hidden="true" /></button
        >
        <button
          class="wd-act"
          title={t("workdir.history")}
          aria-label={t("workdir.history_file", { path: f.path })}
          disabled={workdirCtrl.busy || !canBlameWorkdirFile(f)}
          onclick={(e) => {
            e.stopPropagation();
            fileHistoryCtrl.openFor(repo(), null, blameTargetForWorkdirFile(f));
          }}><History class="ico" size={14} aria-hidden="true" /></button
        >
        <button
          class="wd-act"
          title={t("workdir.stage")}
          aria-label={t("workdir.stage_named", { path: f.path })}
          disabled={workdirCtrl.busy}
          onclick={(e) => {
            e.stopPropagation();
            workdirCtrl.stageFile(repo(), f.path);
          }}>&#43;</button
        >
        <button
          class="wd-act danger"
          title={t("workdir.discard")}
          aria-label={t("workdir.discard_named", { path: f.path })}
          disabled={workdirCtrl.busy}
          onclick={(e) => {
            e.stopPropagation();
            workdirCtrl.confirmDiscard(f.path, f.status === "?");
          }}><Trash2 class="ico" size={14} aria-hidden="true" /></button
        >
        <button
          class="wd-act"
          title={t("workdir.open_external_diff")}
          aria-label={t("workdir.open_external_diff_for", { path: f.path })}
          disabled={workdirCtrl.busy || f.status === "?"}
          onclick={(e) => {
            e.stopPropagation();
            externalToolsCtrl.openDiff(repo(), f.path, false);
          }}><ExternalLink class="ico" size={14} aria-hidden="true" /></button
        >
      {/if}
    </div>
  {/each}
{/snippet}
