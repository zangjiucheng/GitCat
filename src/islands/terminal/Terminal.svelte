<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { terminalCtrl } from "./terminal.svelte.ts";
  import { IN_TAURI } from "../../ipc/env";
  import { t } from "@/i18n/i18n.svelte.ts";
  import { Terminal as XTerm } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import { keymap } from "@/keymap/registry.ts";
  import type { ScopeHandle } from "@/keymap/scopes.ts";

  let containerEl: HTMLDivElement;
  let xterm: XTerm | undefined;
  let fitAddon: FitAddon | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let scope: ScopeHandle | null = null;

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

    // #142. Two different listener PHASES shadow the shell, so this is half the
    // fix and the `terminal` scope (scopedefs.ts) is the other half.
    //
    // The keymap dispatcher listens at window CAPTURE (host.ts:50), upstream of
    // this entirely — nothing done here can stop it, which is what the modal
    // scope is for. Everything else in the app listens on the BUBBLE phase
    // (`svelte:window on:keydown` in the islands, `document.addEventListener`
    // in legacy/main.ts — verified: there is not one capture listener among
    // them). xterm attaches its own handler to the helper textarea and does not
    // stop those, so `Ctrl+K` in the shell reached the app. stopPropagation
    // here is upstream of every one of them, at once, instead of a `.term-drawer`
    // bail per handler.
    //
    // Returning true means "xterm, go ahead and process this" — the shell still
    // gets the key. The exception is the one key that has to leave: returning
    // false makes xterm ignore it and lets it propagate, so the app can act on
    // it (see actions/terminal.ts).
    xterm.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.key === "Escape" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) return false;
      e.stopPropagation();
      return true;
    });
    // attachOutput, not a bare assignment: anything the shell said before this
    // component existed is still queued, and this is what flushes it.
    terminalCtrl.attachOutput((bytes) => xterm?.write(bytes));

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

    // Scope activation follows FOCUS, not the drawer's open state: with the
    // drawer open but the graph focused, app chords must still work. focusin /
    // focusout bubble, so one pair on the container covers xterm's helper
    // textarea without reaching into its internals.
    //
    // No autoFocus (focus is already here, that is what just fired), no
    // restoreFocus (focusout means something else has already taken it, and
    // putting it back would fight the user), no trapTab (ScopeOpts' own doc:
    // "the terminal must hand it to the shell").
    const onFocusIn = () => {
      scope ??= keymap.pushScope("terminal", { el: containerEl, autoFocus: false, restoreFocus: false, trapTab: false });
    };
    const onFocusOut = (e: FocusEvent) => {
      // relatedTarget still inside the drawer means focus moved WITHIN the
      // terminal (the close button, the resize handle), not out of it.
      if (containerEl.contains(e.relatedTarget as Node | null)) return;
      scope?.release();
      scope = null;
    };
    containerEl.addEventListener("focusin", onFocusIn);
    containerEl.addEventListener("focusout", onFocusOut);

    return () => {
      themeObserver.disconnect();
      containerEl.removeEventListener("focusin", onFocusIn);
      containerEl.removeEventListener("focusout", onFocusOut);
    };
  });

  onDestroy(() => {
    // Before the xterm is disposed: a scope left on the stack would keep the
    // walk terminating at a terminal that no longer exists.
    scope?.release();
    scope = null;
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
    <span class="term-title"><span class="term-ic" aria-hidden="true">&gt;_</span> {t("terminal.title")}</span>
    <!-- #142 asked for a way out that is "documented, discoverable". The help
         sheet covers documented (terminal.focusOut carries a help entry);
         this is discoverable — it is in front of the one person who needs it,
         at the moment they need it. Escape is not offered because the shell
         owns it. -->
    <span class="term-hint mut">{t("terminal.focus_out_hint")} <kbd>⇧esc</kbd></span>
    {#if terminalCtrl.exited}
      <span class="term-exited">{t("terminal.exited")}</span>
      <button class="term-btn" onclick={() => terminalCtrl.restart()}>&#8635; {t("terminal.restart_btn")}</button>
    {/if}
    <button class="term-x" title={t("common.close")} aria-label={t("terminal.aria_close")} onclick={() => terminalCtrl.closeSession()}>&#10005;</button>
  </div>
  <div class="term-body">
    <div class="term-xterm" bind:this={containerEl}></div>
    {#if !IN_TAURI}
      <div class="term-overlay mut">{t("terminal.demo_pre")}<b>{terminalCtrl.repo}</b>{t("terminal.demo_post")}</div>
    {:else if terminalCtrl.busy}
      <div class="term-overlay mut"><span class="spinner"></span> {t("terminal.starting")}</div>
    {/if}
  </div>
</div>
