<script lang="ts">
  // The submodule navigator strip (breadcrumb + sibling tabs + a 🌳 button that
  // opens the full-tree popover). See submodulenav.svelte.ts for the model; this
  // is purely presentation. Rendered into #submoduleNavMount (a grid row under
  // the topbar) by src/main.ts — the row collapses to nothing when `visible` is
  // false, so a plain repo with no submodules shows no strip at all.
  import { submoduleNavCtrl as ctrl, horizontalWheelDelta, type TreeNode } from "./submodulenav.svelte.ts";
  import { t } from "@/i18n/i18n.svelte.ts";

  // Let a plain vertical mouse wheel scroll the strip left/right when it
  // overflows (lots of sibling submodules). Trackpad horizontal gestures
  // (deltaX) already scroll it natively, so those are left untouched.
  function onStripWheel(e: WheelEvent): void {
    const el = e.currentTarget as HTMLElement;
    const dx = horizontalWheelDelta({
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    });
    if (!dx) return;
    el.scrollLeft += dx;
    e.preventDefault();
  }

  // Human label for a submodule status, reused by the tree popover's tooltip.
  function statusLabel(s: string): string {
    switch (s) {
      case "clean": return t("submodulenav.status_clean");
      case "dirty": return t("submodulenav.status_dirty");
      case "out-of-date": return t("submodulenav.status_out_of_date");
      case "conflicted": return t("submodulenav.status_conflicted");
      case "not-initialized": return t("submodulenav.status_not_initialized");
      case "removed": return t("submodulenav.status_removed");
      case "unreadable": return t("submodulenav.status_unreadable");
      default: return s;
    }
  }
</script>

{#if ctrl.visible}
  <div class="subnav-inner" onwheel={onStripWheel}>
    <button
      class="sn-tree-btn"
      class:on={ctrl.treeOpen}
      title={t("submodulenav.browse_tree")}
      aria-label={t("submodulenav.browse_tree")}
      onclick={() => ctrl.toggleTree()}
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 2v5M8 7 5 9m3-2 3 2" /><circle cx="8" cy="2.4" r="1.4" /><circle cx="4.8" cy="10" r="1.4" /><circle cx="11.2" cy="10" r="1.4" /><path d="M4.8 11.4V14m6.4-2.6V14" />
      </svg>
    </button>

    <!-- Breadcrumb: root › … › current -->
    <nav class="sn-crumbs" aria-label={t("submodulenav.breadcrumb_aria")}>
      {#each ctrl.path as c, i (c.absolutePath + i)}
        {#if i > 0}<span class="sn-sep" aria-hidden="true">›</span>{/if}
        <button
          class="sn-crumb"
          class:current={c.current}
          disabled={c.current || ctrl.busy}
          title={c.current ? t("submodulenav.current_repo") : t("submodulenav.go_to", { name: c.name })}
          onclick={() => ctrl.jumpToCrumb(i)}
        >
          {#if ctrl.busy && ctrl.busyTarget === "crumb:" + i}<span class="spinner"></span>{/if}
          {c.name}
        </button>
      {/each}
    </nav>

    <!-- Sibling / dive-in tabs at the current level -->
    {#if ctrl.siblings.length}
      <div class="sn-tabs" role="tablist" aria-label={t("submodulenav.siblings_aria")}>
        {#each ctrl.siblings as s (s.absolutePath)}
          <button
            class="sn-tab"
            class:current={s.current}
            role="tab"
            aria-selected={s.current}
            disabled={s.current || ctrl.busy || !s.canOpen}
            title={s.current ? t("submodulenav.sibling_current", { name: s.name }) : s.canOpen ? t("submodulenav.switch_to", { name: s.name }) : t("submodulenav.sibling_status", { name: s.name, status: statusLabel(s.status) })}
            onclick={() => ctrl.jumpToSibling(s)}
          >
            {#if ctrl.busy && ctrl.busyTarget === "sib:" + s.absolutePath}
              <span class="spinner"></span>
            {:else}
              <span class="sn-dot" data-status={s.status} aria-hidden="true"></span>
            {/if}
            {s.name}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  {#if ctrl.treeOpen}
    <div class="sn-tree-backdrop" role="presentation" onclick={() => ctrl.closeTree()} oncontextmenu={(e) => { e.preventDefault(); ctrl.closeTree(); }}></div>
    <div class="sn-tree-pop" role="dialog" aria-label={t("submodulenav.tree_aria")}>
      <div class="sn-tree-head">{t("submodulenav.submodules")}</div>
      {#if ctrl.treeLoading}
        <div class="sn-tree-empty"><span class="spinner"></span> {t("submodulenav.reading_tree")}</div>
      {:else if ctrl.tree}
        {@render treeNode(ctrl.tree, 0)}
      {:else}
        <div class="sn-tree-empty">{t("submodulenav.tree_error")}</div>
      {/if}
    </div>
  {/if}
{/if}

{#snippet treeNode(n: TreeNode, depth: number)}
  <button
    class="sn-node"
    class:current={n.current}
    class:disabled={!n.isRoot && !n.canOpen}
    style="padding-left:{8 + depth * 16}px"
    disabled={n.current || (!n.isRoot && !n.canOpen) || ctrl.busy}
    title={n.isRoot ? t("submodulenav.superproject") : statusLabel(n.status)}
    onclick={() => ctrl.jumpToNode(n)}
  >
    {#if n.isRoot}
      <svg class="sn-node-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2 6.5 8 3l6 3.5-6 3.5z" /><path d="M2 6.5V11l6 3.5 6-3.5V6.5" /></svg>
    {:else}
      <span class="sn-dot" data-status={n.status} aria-hidden="true"></span>
    {/if}
    <span class="sn-node-name">{n.name}</span>
    {#if n.current}<span class="sn-here">{t("submodulenav.here")}</span>{/if}
  </button>
  {#each n.children as child (child.absolutePath)}
    {@render treeNode(child, depth + 1)}
  {/each}
{/snippet}
