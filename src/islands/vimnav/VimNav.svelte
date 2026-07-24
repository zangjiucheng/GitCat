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
  <div class="modal">
    <div class="modal-head">
      <div>
        <h3>Keyboard shortcuts</h3>
        <p>Vim-style navigation — always on, and never active while typing into a text field.</p>
      </div>
    </div>
    <div class="modal-body">
      <div class="pl-kv">
        <div><span class="mono">j</span> / <span class="mono">k</span> &#8212; move down/up (the commit graph, or whichever list has focus)</div>
        <div><span class="mono">gg</span> &#8212; jump to the first commit</div>
        <div><span class="mono">G</span> &#8212; jump to the last commit</div>
        <div><span class="mono">Ctrl+D</span> / <span class="mono">Ctrl+U</span> &#8212; half-page down/up</div>
        <div><span class="mono">/</span> &#8212; open search (same as Ctrl/Cmd+K)</div>
        <div><span class="mono">Ctrl/Cmd+F</span> &#8212; search code (find in file contents)</div>
        <div><span class="mono">Ctrl/Cmd+Shift+F</span> &#8212; filter refs (focus the sidebar's ref search)</div>
        <div><span class="mono">Ctrl/Cmd+Shift+U</span> &#8212; jump to Uncommitted changes (the working tree)</div>
        <div><span class="mono">Enter</span> &#8212; open the selected commit's diff (or activate the focused list row)</div>
        <div><span class="mono">?</span> &#8212; toggle this help</div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick={() => vimnavCtrl.closeHelp()}>Close</button>
    </div>
  </div>
</div>
