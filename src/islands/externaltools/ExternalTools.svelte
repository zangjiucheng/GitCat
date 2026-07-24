<script lang="ts">
  // External Tools settings modal — view. Deliberately no bespoke <style>
  // block: reuses `.scrim`/`.modal`/`.modal-head`/`.modal-body`/`.modal-foot`/
  // `.btn`/`.btn.ghost`/`.rm-form`/`.nb-row`/`.mono`/`.mut`/`.spinner` verbatim
  // (same shared chrome Remotes/Rerere/Reflog reuse — see index.html's own
  // doc comment on the MODALS section), the two-input-per-row shape mirroring
  // Remotes' own "name" + "URL" add-row.
  import { externalToolsCtrl } from "./externaltools.svelte.ts";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && externalToolsCtrl.open) externalToolsCtrl.close();
  }

  function onFieldKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") void externalToolsCtrl.save();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={externalToolsCtrl.open}>
  <div class="modal external-tools">
    <div class="modal-head">
      <div>
        <h3>External Tools</h3>
        <p>Configure a diff and merge tool (Meld, Beyond Compare, VS Code, kdiff3, opendiff, &#8230;) to open from GitCat's own UI.</p>
      </div>
    </div>
    <div class="modal-body">
      {#if externalToolsCtrl.loading}
        <div class="log-row"><span class="spinner"></span><span class="msg mut">Loading external tool settings&#8230;</span></div>
      {:else}
        {#if externalToolsCtrl.error}
          <div class="log-row"><span class="ic">&#9888;</span><span class="msg mut">{externalToolsCtrl.error}</span></div>
        {/if}
        <h4 class="d-lab">Diff tool</h4>
        <div class="rm-form">
          <input
            type="text"
            placeholder="name&#8230; e.g. meld, opendiff, vscode"
            bind:value={externalToolsCtrl.diffName}
            disabled={externalToolsCtrl.saving}
            spellcheck="false"
            autocomplete="off"
            onkeydown={onFieldKeydown}
          />
          <input
            type="text"
            class="mono"
            placeholder="custom command&#8230; (optional — leave blank to use a git-known tool)"
            bind:value={externalToolsCtrl.diffCmd}
            disabled={externalToolsCtrl.saving}
            spellcheck="false"
            autocomplete="off"
            onkeydown={onFieldKeydown}
          />
        </div>
        <p class="mut" style="font-size:11.5px;margin:2px 0 14px">
          Leave blank to fall back to this repository's own <code>git config diff.tool</code>, if any.
        </p>

        <h4 class="d-lab">Merge tool</h4>
        <div class="rm-form">
          <input
            type="text"
            placeholder="name&#8230; e.g. kdiff3, opendiff, vscode"
            bind:value={externalToolsCtrl.mergeName}
            disabled={externalToolsCtrl.saving}
            spellcheck="false"
            autocomplete="off"
            onkeydown={onFieldKeydown}
          />
          <input
            type="text"
            class="mono"
            placeholder="custom command&#8230; (optional — leave blank to use a git-known tool)"
            bind:value={externalToolsCtrl.mergeCmd}
            disabled={externalToolsCtrl.saving}
            spellcheck="false"
            autocomplete="off"
            onkeydown={onFieldKeydown}
          />
        </div>
        <p class="mut" style="font-size:11.5px;margin:2px 0 0">
          Leave blank to fall back to this repository's own <code>git config merge.tool</code>, if any. A custom command may use git's own
          <code>$BASE</code>/<code>$LOCAL</code>/<code>$REMOTE</code>/<code>$MERGED</code> placeholders.
        </p>

        <h4 class="d-lab" style="margin-top:16px">Commit message command</h4>
        <div class="rm-form">
          <input
            type="text"
            class="mono"
            placeholder="command&#8230; e.g. aicommit, opencommit --dry-run"
            bind:value={externalToolsCtrl.commitCmd}
            disabled={externalToolsCtrl.saving}
            spellcheck="false"
            autocomplete="off"
            onkeydown={onFieldKeydown}
          />
        </div>
        <p class="mut" style="font-size:11.5px;margin:2px 0 0">
          Must <b>print the message and exit</b> (non-interactive) &#8212; GitCat runs it in the repo and its output fills the commit box (the
          &#10024; button). GitCat talks to no AI itself; the command is entirely yours. Works: <code>opencommit --dry-run</code>, a script/LLM
          CLI. Won't work: interactive tools like <code>aicommit2</code> that prompt you and commit themselves.
        </p>
      {/if}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" disabled={externalToolsCtrl.saving} onclick={() => externalToolsCtrl.close()}>Close</button>
      <button class="btn" disabled={externalToolsCtrl.loading || externalToolsCtrl.saving} onclick={() => externalToolsCtrl.save()}>
        {#if externalToolsCtrl.saving}<span class="spinner"></span> Saving&#8230;{:else}Save{/if}
      </button>
    </div>
  </div>
</div>
