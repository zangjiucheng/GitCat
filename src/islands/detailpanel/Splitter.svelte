<!--
  The divider between two panes, used by the expanded-diff modal and by both
  of the detail panel's "changes" tabs. Extracted from the modal, where it was
  inline and would otherwise have been copied twice.

  `axis` is the direction the panes are laid out: "x" puts them side by side
  and the divider drags left/right; "y" stacks them and it drags up/down. The
  detail panel picks the axis from the placement, which is what lets one
  internal layout serve both placements.
-->
<script lang="ts">
  import { clampSplit, loadSplitSize, saveSplitSize } from "./splitter.ts";

  let {
    axis = "x",
    size = $bindable(),
    min,
    max,
    defaultSize,
    label,
    storageKey,
  }: {
    axis?: "x" | "y";
    size: number;
    min: number;
    max: number;
    defaultSize: number;
    label: string;
    storageKey: string;
  } = $props();

  // Seed from storage once, on creation, rather than in an $effect: an effect
  // writing this $bindable would re-run on every dependency change (e.g. if a
  // caller's min/max ever became reactive) and stomp a size the user just
  // dragged. A plain initializer runs exactly once, which is what "read the
  // stored size on mount" actually means.
  size = loadSplitSize(storageKey, min, max, defaultSize);

  let dragging = $state(false);

  function onPointerDown(e: PointerEvent) {
    e.preventDefault();
    const startPos = axis === "x" ? e.clientX : e.clientY;
    const startSize = size;
    dragging = true;
    document.body.style.userSelect = "none";
    function move(ev: PointerEvent) {
      const d = (axis === "x" ? ev.clientX : ev.clientY) - startPos;
      size = clampSplit(startSize + d, min, max);
    }
    function up() {
      dragging = false;
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      saveSplitSize(storageKey, size);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function onKeyDown(e: KeyboardEvent) {
    const step = e.shiftKey ? 32 : 8;
    const back = axis === "x" ? "ArrowLeft" : "ArrowUp";
    const fwd = axis === "x" ? "ArrowRight" : "ArrowDown";
    if (e.key === back) size = clampSplit(size - step, min, max);
    else if (e.key === fwd) size = clampSplit(size + step, min, max);
    else return;
    e.preventDefault();
    saveSplitSize(storageKey, size);
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="d-splitter"
  class:active={dragging}
  class:vert={axis === "y"}
  role="separator"
  tabindex="0"
  aria-orientation={axis === "x" ? "vertical" : "horizontal"}
  aria-label={label}
  aria-valuenow={Math.round(size)}
  aria-valuemin={min}
  aria-valuemax={max}
  onpointerdown={onPointerDown}
  onkeydown={onKeyDown}
  ondblclick={() => {
    size = defaultSize;
    saveSplitSize(storageKey, size);
  }}
></div>
