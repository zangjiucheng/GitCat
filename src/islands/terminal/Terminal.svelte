<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { terminalCtrl } from "./terminal.svelte.ts";
  import { IN_TAURI } from "../../ipc/env";
  import { Terminal as XTerm } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";

  let containerEl: HTMLDivElement;
  let xterm: XTerm | undefined;
  let fitAddon: FitAddon | undefined;
  let resizeObserver: ResizeObserver | undefined;

  // Reads the app's own CSS custom properties (same `getComputedStyle`
  // technique legacy/main.ts's readTheme() uses for the canvas) so the
  // embedded terminal's colors track the current light/dark theme instead
  // of a hardcoded palette that would clash with whichever one is active.
  function xtermTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string) => cs.getPropertyValue(name).trim() || undefined;
    return {
      background: v("--bg"),
      foreground: v("--text"),
      cursor: v("--accent"),
      cursorAccent: v("--bg"),
      selectionBackground: v("--elevated"),
      black: v("--bg"),
      brightBlack: v("--muted"),
      white: v("--text"),
      brightWhite: v("--text"),
      red: v("--danger"),
      brightRed: v("--danger"),
      green: v("--success"),
      brightGreen: v("--success"),
      yellow: v("--warning"),
      brightYellow: v("--warning"),
      blue: v("--accent"),
      brightBlue: v("--accent"),
      magenta: v("--accent2"),
      brightMagenta: v("--accent2"),
      cyan: v("--accent2"),
      brightCyan: v("--accent2"),
    };
  }

  onMount(() => {
    xterm = new XTerm({ fontFamily: "var(--mono)", fontSize: 12.5, cursorBlink: true, theme: xtermTheme() });
    fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(containerEl);
    xterm.onData((data) => terminalCtrl.write(data));
    terminalCtrl.onData = (bytes) => xterm?.write(bytes);

    // Re-theme on a light/dark toggle — same "no change event exists,
    // observe the attribute directly" approach the rest of this codebase
    // has no precedent for yet, since every other themed surface is CSS
    // custom properties the browser recomputes on its own; xterm.js's
    // colors are baked into its own renderer at construction time instead.
    const themeObserver = new MutationObserver(() => {
      if (xterm) xterm.options.theme = xtermTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    resizeObserver = new ResizeObserver(() => {
      if (!terminalCtrl.open || !fitAddon || !xterm) return;
      fitAddon.fit();
      terminalCtrl.resize(xterm.cols, xterm.rows);
    });
    resizeObserver.observe(containerEl);

    return () => themeObserver.disconnect();
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    terminalCtrl.onData = null;
    xterm?.dispose();
  });

  // A brand-new session (a fresh id, including after `restart()`) starts
  // its view CLEAN — otherwise the new shell's output would land right
  // after the old one's leftover scrollback, reading as one garbled session
  // instead of two distinct ones. Opening the drawer (first spawn OR
  // re-showing after `hide()`) re-fits and re-focuses — deferred a frame so
  // `fit()` measures the drawer's real, already-visible size rather than a
  // mid-transition one.
  let lastSessionId: string | null = null;
  $effect(() => {
    const sid = terminalCtrl.sessionId;
    const isOpen = terminalCtrl.open;
    if (sid && sid !== lastSessionId) {
      xterm?.reset();
      lastSessionId = sid;
    }
    if (!sid) lastSessionId = null;
    if (isOpen) {
      requestAnimationFrame(() => {
        if (!terminalCtrl.open || !fitAddon || !xterm) return;
        fitAddon.fit();
        terminalCtrl.resize(xterm.cols, xterm.rows);
        xterm.focus();
      });
    }
  });

  let dragStartY = 0;
  let dragStartH = 0;
  // Same "CSS custom property + pointer drag" idiom legacy/main.ts's
  // wireResizeHandle() uses for the sidebar/detail panes, reimplemented
  // locally rather than reusing that function — it's legacy/main.ts-scoped
  // (module-private, column-resize only) and this is a brand-new island.
  function onDragStart(e: PointerEvent) {
    e.preventDefault();
    dragStartY = e.clientY;
    dragStartH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--term-h")) || 280;
    document.addEventListener("pointermove", onDragMove);
    document.addEventListener("pointerup", onDragEnd);
  }
  function onDragMove(e: PointerEvent) {
    const dy = dragStartY - e.clientY;
    const h = Math.max(140, Math.min(window.innerHeight * 0.8, dragStartH + dy));
    document.documentElement.style.setProperty("--term-h", h + "px");
  }
  function onDragEnd() {
    document.removeEventListener("pointermove", onDragMove);
    document.removeEventListener("pointerup", onDragEnd);
  }
</script>

<div class="term-drawer" class:on={terminalCtrl.open}>
  <div class="term-drag" role="separator" aria-orientation="horizontal" onpointerdown={onDragStart}></div>
  <div class="term-head">
    <span class="term-title"><span class="term-ic" aria-hidden="true">&gt;_</span> Terminal</span>
    {#if terminalCtrl.exited}
      <span class="term-exited">process exited</span>
      <button class="term-btn" onclick={() => terminalCtrl.restart()}>&#8635; Restart</button>
    {/if}
    <button class="term-x" title="Close" aria-label="Close terminal" onclick={() => terminalCtrl.closeSession()}>&#10005;</button>
  </div>
  <div class="term-body">
    <div class="term-xterm" bind:this={containerEl}></div>
    {#if !IN_TAURI}
      <div class="term-overlay mut">This is where a real shell would run, at <b>{terminalCtrl.repo}</b> (demo).</div>
    {:else if terminalCtrl.busy}
      <div class="term-overlay mut"><span class="spinner"></span> starting a shell&#8230;</div>
    {/if}
  </div>
</div>
