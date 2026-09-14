<script lang="ts">
  import { tamaConfirmCtrl } from "./tamaconfirm.svelte.ts";
  import * as bridge from "../../legacy/bridge";

  // Tama's face matches the tone: alarmed for a warning/danger, curious for info.
  const face = $derived(
    tamaConfirmCtrl.kind === "info" ? bridge.TAMA_IMG.curious : bridge.TAMA_IMG.alarm,
  );

  function onKeydown(e: KeyboardEvent) {
    if (!tamaConfirmCtrl.open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      tamaConfirmCtrl.cancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      // This listener is on <svelte:window> and tests only `open`, never where
      // focus is — so an Enter typed into the commit textarea, the ref filter
      // or a rename field reaches here. workdir's discardAll raises this dialog
      // with kind:"danger", which made that stray Enter discard the whole
      // working tree. A destructive prompt therefore resolves CANCEL on Enter;
      // confirming it has to be a deliberate click or a focused button.
      if (tamaConfirmCtrl.kind === "danger") tamaConfirmCtrl.cancel();
      else tamaConfirmCtrl.confirm();
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<!-- data-modal-blocking marks a scrim that nothing may open on top of. `.scrim.on`
     alone can't carry that meaning: the in-panel expanded-diff overlay is also a
     .scrim, so guarding on it blocks ⌘K merely because a diff is expanded, while
     failing to distinguish a scrim that is holding an armed destructive action. -->
<div class="scrim" data-modal-blocking class:on={tamaConfirmCtrl.open}>
  <div class="modal tamaconfirm">
    <div class="modal-head">
      <div class="modal-tama"><img class="tama-pic" src={face} alt="Tama" /></div>
      <div>
        <h3>{tamaConfirmCtrl.title}</h3>
      </div>
    </div>
    <div class="modal-body">
      <p class="tc-msg">{tamaConfirmCtrl.message}</p>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" onclick={() => tamaConfirmCtrl.cancel()}>{tamaConfirmCtrl.cancelLabel}</button>
      <button
        class="btn"
        class:danger={tamaConfirmCtrl.kind === "danger"}
        onclick={() => tamaConfirmCtrl.confirm()}>{tamaConfirmCtrl.confirmLabel}</button
      >
    </div>
  </div>
</div>
