<script lang="ts">
  import { commitMenuCtrl } from "./commitmenu.svelte.ts";
  import { t } from "@/i18n/i18n.svelte.ts";

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
        <button onclick={() => commitMenuCtrl.cherryPick()}>{t("commitmenu.cherry_pick")}</button>
        <button onclick={() => commitMenuCtrl.merge()}>{t("commitmenu.merge")}</button>
        <button
          disabled={commitMenuCtrl.isMerge}
          title={commitMenuCtrl.isMerge ? t("commitmenu.revert_disabled_title") : undefined}
          onclick={() => commitMenuCtrl.revert()}>{t("commitmenu.revert")}</button
        >
        <button class="danger" onclick={() => commitMenuCtrl.resetHere()}>{t("commitmenu.reset_here")}</button>
        <button
          disabled={commitMenuCtrl.isMerge}
          title={commitMenuCtrl.isMerge ? t("commitmenu.export_disabled_title") : undefined}
          onclick={() => commitMenuCtrl.exportAsPatch()}>{t("commitmenu.export_patch")}</button
        >
        <button onclick={() => commitMenuCtrl.startBranchHere()}>{t("commitmenu.create_branch")}</button>
        <button onclick={() => commitMenuCtrl.startTagHere()}>{t("commitmenu.create_tag")}</button>
        <button onclick={() => commitMenuCtrl.copyShortSha()}>{t("commitmenu.copy_short")}</button>
        <button onclick={() => commitMenuCtrl.copyFullSha()}>{t("commitmenu.copy_full")}</button>
        <button onclick={() => commitMenuCtrl.copyMessage()}>{t("commitmenu.copy_message")}</button>
      {/if}
    {:else if commitMenuCtrl.view === "branch"}
      <div class="nb-form" class:busy={commitMenuCtrl.busy}>
        <input
          class="nb-input"
          bind:this={branchInputEl}
          bind:value={commitMenuCtrl.branchName}
          placeholder={t("commitmenu.ph_branch")}
          spellcheck="false"
          autocomplete="off"
          disabled={commitMenuCtrl.busy}
          onkeydown={onBranchKeydown}
        />
        <div class="nb-row">
          <span class="mut">{t("commitmenu.at_hint", { sha: commitMenuCtrl.shortSha })}</span>
          {#if commitMenuCtrl.busy}<span class="spinner"></span>{/if}
        </div>
      </div>
    {:else if commitMenuCtrl.view === "tag"}
      <div class="nb-form" class:busy={commitMenuCtrl.busy}>
        <input
          class="nb-input"
          bind:this={tagInputEl}
          bind:value={commitMenuCtrl.tagName}
          placeholder={t("commitmenu.ph_tag")}
          spellcheck="false"
          autocomplete="off"
          disabled={commitMenuCtrl.busy}
          onkeydown={onTagKeydown}
        />
        <input
          class="nb-input"
          bind:value={commitMenuCtrl.tagMessage}
          placeholder={t("commitmenu.ph_tag_message")}
          spellcheck="false"
          autocomplete="off"
          disabled={commitMenuCtrl.busy}
          onkeydown={onTagKeydown}
        />
        <div class="nb-row">
          <span class="mut">{t("commitmenu.at_hint", { sha: commitMenuCtrl.shortSha })}</span>
          {#if commitMenuCtrl.busy}<span class="spinner"></span>{/if}
        </div>
      </div>
    {/if}
  </div>
{/if}
