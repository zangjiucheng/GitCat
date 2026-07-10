<script lang="ts">
  import { cmdkCtrl, shortSha, CMD_CAP } from "./cmdk.svelte.ts";
  import { isTextInputFocused } from "../vimnav/vimnav.svelte.ts";

  let inputEl: HTMLInputElement | undefined = $state();
  let listEl: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (cmdkCtrl.open) requestAnimationFrame(() => inputEl?.focus());
  });

  // Scroll the selected row into view whenever selection changes (arrow-key
  // nav or a pointer hover re-selecting a row) — mirrors the legacy
  // cmdSetSel's scrollIntoView call.
  $effect(() => {
    void cmdkCtrl.sel; // reactive dependency: re-run this effect when selection changes
    if (!listEl) return;
    const row = listEl.querySelector<HTMLElement>(".cmdk-row.on");
    row?.scrollIntoView({ block: "nearest" });
  });

  function onWindowKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
      if (!cmdkCtrl.open && document.querySelector(".scrim.on")) return; // don't cover an open confirm dialog
      e.preventDefault();
      cmdkCtrl.toggle();
      return;
    }
    // vim-style "/" search — a real typed character elsewhere, so this needs
    // the text-input guard the metaKey/ctrlKey check above doesn't (nobody
    // types Ctrl+K into a text field the same way they'd type a bare "/").
    if (e.key === "/") {
      if (isTextInputFocused(e.target as Element | null)) return;
      if (!cmdkCtrl.open && document.querySelector(".scrim.on")) return;
      e.preventDefault();
      cmdkCtrl.toggle();
    }
  }

  function onInputKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      cmdkCtrl.setSel(cmdkCtrl.sel + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      cmdkCtrl.setSel(cmdkCtrl.sel - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      cmdkCtrl.setSel(0);
    } else if (e.key === "End") {
      e.preventDefault();
      cmdkCtrl.setSel(cmdkCtrl.results.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      cmdkCtrl.jump(cmdkCtrl.results[cmdkCtrl.sel]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cmdkCtrl.close();
    }
  }

  // Pointer hover re-selects a row, but ignore synthetic mousemoves fired by
  // scrollIntoView itself (same "pointer didn't actually move" guard as the
  // legacy IIFE) so keyboard nav isn't hijacked by its own scroll.
  let lastX = -1,
    lastY = -1;
  function onListMousemove(e: MouseEvent) {
    if (e.clientX === lastX && e.clientY === lastY) return;
    lastX = e.clientX;
    lastY = e.clientY;
    const row = (e.target as HTMLElement).closest<HTMLElement>(".cmdk-row");
    if (row) {
      const i = +row.dataset.i!;
      if (i !== cmdkCtrl.sel) cmdkCtrl.setSel(i);
    }
  }

  function onListClick(e: MouseEvent) {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".cmdk-row");
    if (row) cmdkCtrl.jump(cmdkCtrl.results[+row.dataset.i!]);
  }
</script>

<svelte:window on:keydown={onWindowKeydown} />

<div class="cmdk" id="cmdk" class:on={cmdkCtrl.open} aria-hidden={!cmdkCtrl.open}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- Mouse-only dismiss convenience; Escape on the auto-focused input below is the keyboard equivalent (same split as the original vanilla implementation). -->
  <div class="cmdk-scrim" id="cmdkScrim" onclick={() => cmdkCtrl.close()}></div>
  <div class="cmdk-panel" role="dialog" aria-modal="true" aria-label="Command palette">
    <div class="cmdk-inp">
      <span class="mag">&#9906;</span>
      <input
        id="cmdkInput"
        bind:this={inputEl}
        type="text"
        placeholder="Search commits, refs, actions&#8230;"
        spellcheck="false"
        autocomplete="off"
        autocorrect="off"
        value={cmdkCtrl.query}
        oninput={(e) => cmdkCtrl.filter((e.target as HTMLInputElement).value)}
        onkeydown={onInputKeydown}
      />
      <kbd>esc</kbd>
    </div>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <!-- Composite combobox pattern: the input above owns focus + keyboard nav
         (Arrow/Home/End/Enter/Escape); this listbox is mouse/hover-driven only,
         never a separate tab stop. -->
    <div
      class="cmdk-list"
      id="cmdkList"
      role="listbox"
      aria-label="Results"
      bind:this={listEl}
      onclick={onListClick}
      onmousemove={onListMousemove}
    >
      {#if !cmdkCtrl.results.length}
        <div class="cmdk-empty">{cmdkCtrl.hasData ? "No matching commits, refs, or actions" : "No commits loaded — open a repository"}</div>
      {:else}
        {#each cmdkCtrl.results as it, i (it.type + ":" + (it.type === "ref" ? it.name : it.type === "action" ? it.id : it.row))}
          <div class="cmdk-row" class:on={i === cmdkCtrl.sel} data-i={i} role="option" aria-selected={i === cmdkCtrl.sel}>
            {#if it.type === "ref"}
              <span class="kind {it.kind}">{it.kind === "head" ? "branch" : it.kind}</span>
              <div class="main"><div class="ttl">{@html cmdkCtrl.hl(it.name)}</div></div>
              <span class="sha">{shortSha(it.sha)}</span>
            {:else if it.type === "action"}
              <span class="kind action">action</span>
              <div class="main">
                <div class="ttl">{@html cmdkCtrl.hl(it.label)}</div>
                <div class="sub">{it.hint}</div>
              </div>
            {:else}
              <span class="kind">commit</span>
              <div class="main">
                <div class="ttl">{@html cmdkCtrl.hl(it.subject)}</div>
                <div class="sub">{@html cmdkCtrl.hl(it.author)}</div>
              </div>
              <span class="sha">{@html cmdkCtrl.hl(shortSha(it.sha))}</span>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
    <div class="cmdk-foot">
      <span><kbd>&#8593;</kbd><kbd>&#8595;</kbd> navigate</span><span><kbd>&#8629;</kbd> jump</span>
      <span class="sp" id="cmdkCount"
        >{cmdkCtrl.results.length ? cmdkCtrl.results.length + (cmdkCtrl.results.length >= CMD_CAP ? "+" : "") + " result" + (cmdkCtrl.results.length === 1 ? "" : "s") : ""}</span
      >
    </div>
  </div>
</div>
