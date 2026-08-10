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
    <div class="modal-body">
      <div class="kbd-cols">
        <section>
          <h4 class="d-lab">{t("vimnav.sec_search")}</h4>
          <div class="pl-kv">
            <div><span class="mono">/</span> or <span class="mono">⌘K</span> &#8212; {t("vimnav.palette")}</div>
            <div><span class="mono">⌘F</span> &#8212; {t("vimnav.search_code")}</div>
            <div><span class="mono">⌘⇧F</span> &#8212; {t("vimnav.filter_refs")}</div>
          </div>
          <h4 class="d-lab" style="margin-top:14px">{t("vimnav.sec_sync")}</h4>
          <div class="pl-kv">
            <div><span class="mono">⌘⇧D</span> &#8212; {t("vimnav.fetch")}</div>
            <div><span class="mono">⌘⇧L</span> &#8212; {t("vimnav.pull")}</div>
            <div><span class="mono">⌘⇧P</span> &#8212; {t("vimnav.push")}</div>
          </div>
          <h4 class="d-lab" style="margin-top:14px">{t("vimnav.sec_view")}</h4>
          <div class="pl-kv">
            <div><span class="mono">⌘⇧U</span> &#8212; {t("vimnav.jump_uncommitted")}</div>
            <div><span class="mono">⌘⇧H</span> &#8212; {t("vimnav.jump_head")}</div>
            <div><span class="mono">⌘\</span> &#8212; {t("vimnav.focus_mode")}</div>
            <div><span class="mono">⌘</span>+scroll, or <span class="mono">+</span> / <span class="mono">-</span> &#8212; {t("vimnav.zoom")}</div>
          </div>
        </section>
        <section>
          <h4 class="d-lab">{t("vimnav.sec_navigate")}</h4>
          <div class="pl-kv">
            <div><span class="mono">j</span> / <span class="mono">k</span> &#8212; {t("vimnav.down_up")}</div>
            <div><span class="mono">gg</span> / <span class="mono">G</span> &#8212; {t("vimnav.first_last")}</div>
            <div><span class="mono">⌘D</span> / <span class="mono">⌘U</span> &#8212; {t("vimnav.half_page")}</div>
            <div><span class="mono">↑↓ PgUp PgDn Home End</span> &#8212; {t("vimnav.scroll")}</div>
            <div><span class="mono">Enter</span> &#8212; {t("vimnav.enter")}</div>
          </div>
          <h4 class="d-lab" style="margin-top:14px">{t("vimnav.sec_actions")}</h4>
          <div class="pl-kv">
            <div><span class="mono">⌘Z</span> &#8212; {t("vimnav.undo")}</div>
            <div><span class="mono">Esc</span> &#8212; {t("vimnav.esc")}</div>
            <div><span class="mono">?</span> &#8212; {t("vimnav.toggle_help")}</div>
          </div>
        </section>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick={() => vimnavCtrl.closeHelp()}>{t("common.close")}</button>
    </div>
  </div>
</div>
