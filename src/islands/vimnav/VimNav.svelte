<script lang="ts">
  // Vim-style navigation — view. Deliberately NO <style> block: reuses the
  // existing global .scrim/.modal/.modal-head/.modal-body/.modal-foot/.pl-kv
  // classes, same convention as every other overlay island. This island has
  // no modal FLOW of its own (unlike FilterRepo/SetupWizard) — the only
  // visible surface is a "?"-triggered help overlay; everything else is a
  // silent window-level keydown listener. See vimnav.svelte.ts for why the
  // whole dispatch decision lives in the controller rather than here.
  import { vimnavCtrl, handleGlobalKeydown } from "./vimnav.svelte.ts";
  import { t } from "@/i18n/i18n.svelte.ts";
  import { helpGroups } from "@/keymap/help.ts";
  import { BINDINGS } from "@/keymap/bindings.ts";
  import { platform } from "@/keymap/platform.ts";

  // Rebuilt every time the overlay opens rather than once: which scope leads
  // depends on where focus was when "?" was pressed, and t() has to run under
  // the CURRENT locale (the same reason cmdk.svelte.ts rebuilds its action
  // list per open rather than holding a module-level array).
  //
  // helpScope, not activePaneScope(): the body below takes focus on open, and
  // it lives outside every pane — reading the live answer here would be right
  // once and "global" ever after. The controller snapshots it in the keydown.
  const groups = $derived(
    vimnavCtrl.helpOpen ? helpGroups(BINDINGS, vimnavCtrl.helpScope, platform()) : [],
  );

  // The list is longer than the window on a short screen, so the body scrolls.
  // Focus it on open: nothing else in the overlay is focusable, and on macOS
  // WebKit a bare overflow:auto div is not tab-reachable — without this the
  // one surface that teaches keyboard use would need a mouse to read.
  let bodyEl = $state<HTMLDivElement | null>(null);
  $effect(() => {
    if (vimnavCtrl.helpOpen) bodyEl?.focus();
  });
</script>

<svelte:window on:keydown={handleGlobalKeydown} />

<div class="scrim" id="vimNavHelpScrim" class:on={vimnavCtrl.helpOpen}>
  <div class="modal kbd-help">
    <div class="modal-head">
      <div>
        <h3>{t("vimnav.title")}</h3>
        <p>{t("vimnav.subtitle")} <span class="mono">⌘</span> = {t("vimnav.cmd_legend")}; <span class="mono">⇧</span> = {t("vimnav.shift_legend")}.</p>
      </div>
    </div>
    <div class="modal-body" bind:this={bodyEl} tabindex="-1">
      <div class="kbd-cols">
        {#each groups as g (g.titleKey)}
          <section>
            <h4 class="d-lab">{t(g.titleKey)}</h4>
            <div class="pl-kv">
              {#each g.rows as r (g.titleKey + r.chord + r.labelKey)}
                <div><span class="mono">{r.chord}</span> &#8212; {t(r.labelKey)}</div>
              {/each}
            </div>
          </section>
        {/each}
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick={() => vimnavCtrl.closeHelp()}>{t("common.close")}</button>
    </div>
  </div>
</div>
