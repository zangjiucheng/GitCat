<script lang="ts">
  import { rebasePlanCtrl } from "./rebaseplan.svelte.ts";
  import type { PlanAction } from "./rebaseplan.svelte.ts";
  import * as bridge from "../../legacy/bridge";

  const ACTIONS: { value: PlanAction; label: string }[] = [
    { value: "pick", label: "Pick" },
    { value: "edit", label: "Edit" },
    { value: "squash", label: "Squash" },
    { value: "fixup", label: "Fixup" },
    { value: "drop", label: "Drop" },
  ];

  const ACTION_GLYPH: Record<PlanAction, string> = {
    pick: "●", // ●
    edit: "✎", // ✎
    squash: "⇓", // ⇓
    fixup: "⇊", // ⇊
    drop: "✕", // ✕
  };

  // Native HTML5 drag-and-drop — no new dependency, consistent with this
  // codebase's general avoidance of extra npm packages for interaction
  // primitives it can express directly (see setupwizard.svelte.ts's
  // armDropZone for the OS-drag-and-drop precedent). Purely local component
  // state (not the controller's) — it's transient interaction state, not app
  // state the rest of the island cares about.
  let dragIndex = $state<number | null>(null);
  let overIndex = $state<number | null>(null);

  function onDragStart(e: DragEvent, i: number) {
    dragIndex = i;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(i));
    }
  }
  function onDragOver(e: DragEvent, i: number) {
    e.preventDefault(); // required for ondrop to fire at all
    overIndex = i;
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  }
  function onDrop(e: DragEvent, i: number) {
    e.preventDefault();
    if (dragIndex != null) rebasePlanCtrl.reorder(dragIndex, i);
    dragIndex = null;
    overIndex = null;
  }
  function onDragEnd() {
    dragIndex = null;
    overIndex = null;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && rebasePlanCtrl.open && !rebasePlanCtrl.busy) rebasePlanCtrl.close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={rebasePlanCtrl.open}>
  <div class="modal rebaseplan">
    <div class="modal-head">
      <div class="modal-tama"><img class="tama-pic" src={bridge.TAMA_IMG.alarm} alt="Tama, alarmed" /></div>
      <div>
        <h3>Interactive rebase onto {rebasePlanCtrl.onto}</h3>
        <p>Drag to reorder, pick an action per commit, then Start.</p>
      </div>
    </div>
    <div class="modal-body">
      <div class="rbp-list" class:busy={rebasePlanCtrl.busy}>
        {#each rebasePlanCtrl.rows as row, i (row.sha)}
          <div
            class="rbp-row"
            class:drop-target={overIndex === i && dragIndex !== null && dragIndex !== i}
            class:dragging={dragIndex === i}
            class:dropped={row.action === "drop"}
            draggable={!rebasePlanCtrl.busy}
            role="listitem"
            ondragstart={(e) => onDragStart(e, i)}
            ondragover={(e) => onDragOver(e, i)}
            ondrop={(e) => onDrop(e, i)}
            ondragend={onDragEnd}
          >
            <span class="rbp-handle" title="Drag to reorder" aria-hidden="true">&#8942;&#8942;</span>
            <span class="rbp-mk" data-action={row.action} aria-hidden="true">{ACTION_GLYPH[row.action]}</span>
            <span class="rbp-sha mono">{row.shortSha}</span>
            <span class="rbp-subject" title={row.subject}>{row.subject}</span>
            <select
              class="rbp-action"
              value={row.action}
              disabled={rebasePlanCtrl.busy}
              aria-label="Action for {row.shortSha}"
              onchange={(e) =>
                rebasePlanCtrl.setAction(row.sha, (e.currentTarget as HTMLSelectElement).value as PlanAction)}
            >
              {#each ACTIONS as a}
                <option value={a.value} disabled={i === 0 && (a.value === "squash" || a.value === "fixup")}
                  >{a.label}</option
                >
              {/each}
            </select>
          </div>
        {:else}
          <div class="rbp-empty mut">No plannable commits between here and the target.</div>
        {/each}
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" disabled={rebasePlanCtrl.busy} onclick={() => rebasePlanCtrl.close()}>Cancel</button>
      <button
        class="btn"
        style="background:var(--accent2);border-color:var(--accent2)"
        disabled={!rebasePlanCtrl.canStart}
        onclick={() => rebasePlanCtrl.start()}
        >{#if rebasePlanCtrl.busy}<span class="spinner"></span> Starting…{:else}Start interactive rebase{/if}</button
      >
    </div>
  </div>
</div>
