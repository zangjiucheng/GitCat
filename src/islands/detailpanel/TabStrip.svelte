<!--
  Renders a tab registry. Knows nothing about what any tab contains — the
  panel decides that — so a new tab is an entry in detailpanel.svelte.ts and
  nothing here changes.
-->
<script lang="ts">
  import { t } from "../../i18n/i18n.svelte.ts";
  import type { PanelTab, PanelTabId } from "./detailpanel.svelte.ts";

  let {
    tabs,
    active,
    onselect,
  }: {
    tabs: PanelTab[];
    active: PanelTabId;
    onselect: (id: PanelTabId) => void;
  } = $props();
</script>

<div class="d-tabs" role="tablist">
  {#each tabs as tab (tab.id)}
    <button
      class="d-tab"
      class:on={tab.id === active}
      role="tab"
      aria-selected={tab.id === active}
      onclick={() => onselect(tab.id)}>{t(tab.labelKey)}</button
    >
  {/each}
</div>
