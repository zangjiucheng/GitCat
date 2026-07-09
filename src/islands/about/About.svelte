<script lang="ts">
  // About panel — view. Unlike every other overlay island in this app, this
  // one uses {#if aboutCtrl.open} (mount/unmount) rather than the usual
  // class:on={ctrl.open} (always-in-DOM, display:none toggle) — deliberately,
  // so the entrance animation below actually REPLAYS on every open instead
  // of running once and never again (a CSS `animation` doesn't restart on a
  // display:none -> flex flip of an ancestor, only on the node's own
  // creation). Nothing here needs to persist state while closed (aboutCtrl's
  // `info` cache lives on the controller, not local view state), so
  // unmounting is free.
  import { aboutCtrl } from "./about.svelte.ts";
  import * as bridge from "../../legacy/bridge";

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape" || !aboutCtrl.open) return;
    aboutCtrl.close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if aboutCtrl.open}
  <div class="scrim on">
    <div class="modal about-modal">
      <button class="about-close" aria-label="Close" onclick={() => aboutCtrl.close()}>&#10005;</button>

      <div class="about-tama-wrap">
        <span class="about-sparkle s1">&#10022;</span>
        <span class="about-sparkle s2">&#10022;</span>
        <span class="about-sparkle s3">&#10022;</span>
        <img class="about-tama" src={bridge.TAMA_IMG.happy} alt="Tama, GitCat's guardian" />
      </div>

      {#if aboutCtrl.loading}
        <p class="mut" style="margin-top:14px">loading&#8230;</p>
      {:else if aboutCtrl.info}
        {@const info = aboutCtrl.info}
        <h2 class="about-name">{info.name}</h2>
        <span class="about-version mono">v{info.version}</span>
        <p class="about-desc">{info.description}</p>

        <div class="about-meta">
          <div>{info.authors.join(", ")}</div>
          <div class="mut">{info.copyright}</div>
        </div>

        <div class="modal-foot" style="justify-content:center;border-top:none;padding-top:16px">
          <button class="btn ghost" onclick={() => aboutCtrl.openWebsite()}>&#128279; GitHub</button>
          <button class="btn" onclick={() => aboutCtrl.close()}>Close</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .about-modal {
    position: relative;
    text-align: center;
    padding: 30px 26px 20px;
    animation: about-in 0.38s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes about-in {
    from {
      opacity: 0;
      transform: translateY(6px) scale(0.97);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .about-close {
    position: absolute;
    top: 10px;
    right: 12px;
    border: none;
    background: none;
    color: var(--muted);
    font-size: 13px;
    cursor: pointer;
    padding: 4px;
    line-height: 1;
  }
  .about-close:hover {
    color: var(--text);
  }

  .about-tama-wrap {
    position: relative;
    display: inline-block;
    margin-bottom: 4px;
  }
  .about-tama {
    /* Source art is 320x429 (portrait) — width-only + height:auto keeps its
       natural aspect ratio; forcing an explicit height here squashed it. */
    width: 84px;
    height: auto;
    display: block;
    animation: about-bob 2.6s ease-in-out infinite;
  }
  @keyframes about-bob {
    0%,
    100% {
      transform: translateY(0) rotate(0deg);
    }
    50% {
      transform: translateY(-3px) rotate(-1deg);
    }
  }

  .about-sparkle {
    position: absolute;
    font-size: 13px;
    color: var(--accent);
    opacity: 0;
    animation: about-sparkle 2.6s ease-in-out infinite;
  }
  .s1 {
    top: 2px;
    left: -6px;
    animation-delay: 0s;
  }
  .s2 {
    top: 14px;
    right: -10px;
    animation-delay: 0.6s;
  }
  .s3 {
    bottom: 8px;
    left: 2px;
    animation-delay: 1.3s;
  }
  @keyframes about-sparkle {
    0%,
    100% {
      opacity: 0;
      transform: scale(0.4) rotate(0deg);
    }
    50% {
      opacity: 0.9;
      transform: scale(1) rotate(45deg);
    }
  }

  .about-name {
    font-family: var(--display);
    font-size: 22px;
    margin: 6px 0 0;
  }
  .about-version {
    display: inline-block;
    font-size: 11px;
    color: var(--muted);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border-radius: 999px;
    padding: 2px 9px;
    margin-top: 6px;
  }
  .about-desc {
    color: var(--muted);
    font-size: 13px;
    margin: 12px 0 0;
    line-height: 1.5;
  }
  .about-meta {
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
    font-size: 11.5px;
  }

  @media (prefers-reduced-motion: reduce) {
    .about-modal,
    .about-tama,
    .about-sparkle {
      animation: none !important;
    }
  }
</style>
