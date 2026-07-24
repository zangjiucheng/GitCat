<script lang="ts">
  // Vim-style navigation — view. Deliberately NO <style> block: reuses the
  // existing global .scrim/.modal/.modal-head/.modal-body/.modal-foot/.pl-kv
  // classes, same convention as every other overlay island. This island has
  // no modal FLOW of its own (unlike FilterRepo/SetupWizard) — the only
  // visible surface is a "?"-triggered help overlay; everything else is a
  // silent window-level keydown listener. See vimnav.svelte.ts for why the
  // whole dispatch decision lives in the controller rather than here.
  import { vimnavCtrl, handleGlobalKeydown } from "./vimnav.svelte.ts";
</script>

<svelte:window on:keydown={handleGlobalKeydown} />

<div class="scrim" id="vimNavHelpScrim" class:on={vimnavCtrl.helpOpen}>
  <div class="modal kbd-help">
    <div class="modal-head">
      <div>
        <h3>Keyboard shortcuts</h3>
        <p>Always on, and never active while you're typing in a field. <span class="mono">⌘</span> = Cmd on macOS, Ctrl on Windows/Linux; <span class="mono">⇧</span> = Shift.</p>
      </div>
    </div>
    <div class="modal-body">
      <div class="kbd-cols">
        <section>
          <h4 class="d-lab">Search</h4>
          <div class="pl-kv">
            <div><span class="mono">/</span> or <span class="mono">⌘K</span> &#8212; command palette (commits, refs, actions)</div>
            <div><span class="mono">⌘F</span> &#8212; search code (find in file contents)</div>
            <div><span class="mono">⌘⇧F</span> &#8212; filter refs (focus the sidebar's ref search)</div>
          </div>
          <h4 class="d-lab" style="margin-top:14px">View &amp; panels</h4>
          <div class="pl-kv">
            <div><span class="mono">⌘⇧U</span> &#8212; jump to Uncommitted changes</div>
            <div><span class="mono">⌘\</span> &#8212; focus mode (collapse both side panels)</div>
            <div><span class="mono">⌘</span>+scroll, or <span class="mono">+</span> / <span class="mono">-</span> &#8212; zoom the graph</div>
          </div>
        </section>
        <section>
          <h4 class="d-lab">Navigate</h4>
          <div class="pl-kv">
            <div><span class="mono">j</span> / <span class="mono">k</span> &#8212; down / up (graph or focused list)</div>
            <div><span class="mono">gg</span> / <span class="mono">G</span> &#8212; first / last commit</div>
            <div><span class="mono">⌘D</span> / <span class="mono">⌘U</span> &#8212; half-page down / up</div>
            <div><span class="mono">↑↓ PgUp PgDn Home End</span> &#8212; scroll (when the graph has focus)</div>
            <div><span class="mono">Enter</span> &#8212; open the selected commit's diff (or activate a focused row)</div>
          </div>
          <h4 class="d-lab" style="margin-top:14px">Actions</h4>
          <div class="pl-kv">
            <div><span class="mono">⌘Z</span> &#8212; undo (rewind to a Safety-Manager snapshot)</div>
            <div><span class="mono">Esc</span> &#8212; close a dialog, cancel a typed-confirm, or exit the big diff</div>
            <div><span class="mono">?</span> &#8212; toggle this help</div>
          </div>
        </section>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick={() => vimnavCtrl.closeHelp()}>Close</button>
    </div>
  </div>
</div>
