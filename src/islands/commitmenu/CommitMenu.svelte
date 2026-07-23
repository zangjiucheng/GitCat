<script lang="ts">
  import { commitMenuCtrl } from "./commitmenu.svelte.ts";

  let popEl: HTMLDivElement | undefined = $state();
  let branchInputEl: HTMLInputElement | undefined = $state();
  let tagInputEl: HTMLInputElement | undefined = $state();

  // Outside-click-to-close — this island's OWN handler (not nested inside
  // Sidebar.svelte's onWindowPointerdown the way the branch/tag/submodule
  // popovers are): a new top-level island gets a new <svelte:window> listener,
  // same as Sidebar.svelte's own is the one for ITS three popovers. Blocked
  // while busy so an in-flight create-branch/create-tag request's spinner
  // can't be dismissed out from under it (mirrors onWindowPointerdown's own
  // busy guard on the New Branch/New Tag forms).
  function onWindowPointerdown(e: PointerEvent) {
    if (commitMenuCtrl.open && !commitMenuCtrl.busy && popEl && !popEl.contains(e.target as Node)) commitMenuCtrl.close();
  }

  // Escape steps back ONE level: from the branch/tag sub-form back to the
  // menu (cancelBranchForm/cancelTagForm), or — already at the menu — closes
  // the whole popover. Blocked while busy, same rationale as the outside-click
  // guard above.
  function onWindowKeydown(e: KeyboardEvent) {
    if (!commitMenuCtrl.open || e.key !== "Escape" || commitMenuCtrl.busy) return;
    if (commitMenuCtrl.view === "branch") commitMenuCtrl.cancelBranchForm();
    else if (commitMenuCtrl.view === "tag") commitMenuCtrl.cancelTagForm();
    else commitMenuCtrl.close();
  }

  // Enter confirms — same as Sidebar.svelte's onNewBranchKeydown/
  // onNewTagKeydown. Escape is NOT duplicated here: a keydown on a focused
  // input bubbles up to the window listener above, which already handles it.
  function onBranchKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") commitMenuCtrl.confirmBranch();
  }
  function onTagKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") commitMenuCtrl.confirmTag();
  }

  $effect(() => {
    if (commitMenuCtrl.view === "branch") requestAnimationFrame(() => branchInputEl?.focus());
  });
  $effect(() => {
    if (commitMenuCtrl.view === "tag") requestAnimationFrame(() => tagInputEl?.focus());
  });
</script>

<svelte:window onpointerdown={onWindowPointerdown} onkeydown={onWindowKeydown} />

{#if commitMenuCtrl.open}
  <div class="ref-pop cm-pop" bind:this={popEl} style="left:{commitMenuCtrl.x}px;top:{commitMenuCtrl.y}px">
    <div class="cm-head">
      <span class="sha mono">{commitMenuCtrl.shortSha}</span>
      <span class="subject">{commitMenuCtrl.subject}</span>
    </div>
    {#if commitMenuCtrl.view === "menu"}
      {#if commitMenuCtrl.busy}
        <!-- cherryPick/merge/revert loading state: the popover used to close
             the instant one of these was clicked, so the whole real IPC
             round-trip (checkout, sequencer, snapshot) had ZERO visible
             feedback beyond Tama's easy-to-miss corner animation — see
             commitmenu.svelte.ts's pendingLabel doc comment. Stays open,
             spinnered, same convention every other mutating surface in this
             app already uses (branch/tag rows, the New Branch/Tag forms
             below). -->
        <div class="cm-pending">
          <span class="spinner"></span><span class="mut">{commitMenuCtrl.pendingLabel}</span>
        </div>
      {:else}
        <button
          disabled={commitMenuCtrl.isMerge}
          title={commitMenuCtrl.isMerge ? "Can't cherry-pick a merge commit" : undefined}
          onclick={() => commitMenuCtrl.cherryPick()}>Cherry-pick onto HEAD</button
        >
        <button onclick={() => commitMenuCtrl.merge()}>Merge into HEAD</button>
        <button
          disabled={commitMenuCtrl.isMerge}
          title={commitMenuCtrl.isMerge ? "Can't revert a merge commit (needs --mainline, which isn't supported)" : undefined}
          onclick={() => commitMenuCtrl.revert()}>Revert commit</button
        >
        <button class="danger" onclick={() => commitMenuCtrl.resetHere()}>Reset HEAD to here&#8230;</button>
        <button
          disabled={commitMenuCtrl.isMerge}
          title={commitMenuCtrl.isMerge
            ? "Can't export a merge commit as a single patch — use Export Patches\u{2026} with an explicit range instead"
            : undefined}
          onclick={() => commitMenuCtrl.exportAsPatch()}>Export as Patch&#8230;</button
        >
        <button onclick={() => commitMenuCtrl.startBranchHere()}>Create branch here&#8230;</button>
        <button onclick={() => commitMenuCtrl.startTagHere()}>Create tag here&#8230;</button>
        <button onclick={() => commitMenuCtrl.copyShortSha()}>Copy SHA (short)</button>
        <button onclick={() => commitMenuCtrl.copyFullSha()}>Copy full SHA</button>
        <button onclick={() => commitMenuCtrl.copyMessage()}>Copy commit message</button>
      {/if}
    {:else if commitMenuCtrl.view === "branch"}
      <div class="nb-form" class:busy={commitMenuCtrl.busy}>
        <input
          class="nb-input"
          bind:this={branchInputEl}
          bind:value={commitMenuCtrl.branchName}
          placeholder="branch name&#8230;"
          spellcheck="false"
          autocomplete="off"
          disabled={commitMenuCtrl.busy}
          onkeydown={onBranchKeydown}
        />
        <div class="nb-row">
          <span class="mut">at {commitMenuCtrl.shortSha} &#183; Enter to create, Esc to cancel</span>
          {#if commitMenuCtrl.busy}<span class="spinner"></span>{/if}
        </div>
      </div>
    {:else if commitMenuCtrl.view === "tag"}
      <div class="nb-form" class:busy={commitMenuCtrl.busy}>
        <input
          class="nb-input"
          bind:this={tagInputEl}
          bind:value={commitMenuCtrl.tagName}
          placeholder="tag name&#8230;"
          spellcheck="false"
          autocomplete="off"
          disabled={commitMenuCtrl.busy}
          onkeydown={onTagKeydown}
        />
        <input
          class="nb-input"
          bind:value={commitMenuCtrl.tagMessage}
          placeholder="message (optional &#8212; annotated tag)&#8230;"
          spellcheck="false"
          autocomplete="off"
          disabled={commitMenuCtrl.busy}
          onkeydown={onTagKeydown}
        />
        <div class="nb-row">
          <span class="mut">at {commitMenuCtrl.shortSha} &#183; Enter to create, Esc to cancel</span>
          {#if commitMenuCtrl.busy}<span class="spinner"></span>{/if}
        </div>
      </div>
    {/if}
  </div>
{/if}
