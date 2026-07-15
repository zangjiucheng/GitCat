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
  import { updaterCtrl } from "../updater/updater.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import Link from "@lucide/svelte/icons/link";

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

        <div class="about-update">
          {#if updaterCtrl.phase === "idle"}
            <button class="btn ghost" onclick={() => updaterCtrl.check()}>Check for Updates&#8230;</button>
          {:else if updaterCtrl.phase === "checking"}
            <span class="mut"><span class="spinner"></span> Checking for updates&#8230;</span>
          {:else if updaterCtrl.phase === "up-to-date"}
            <span class="mut">You're up to date. <button class="linklike" onclick={() => updaterCtrl.dismiss()}>OK</button></span>
          {:else if updaterCtrl.phase === "available"}
            <div class="about-update-card">
              <div><b>v{updaterCtrl.version}</b> is available <span class="mut">(you have v{updaterCtrl.currentVersion})</span></div>
              {#if updaterCtrl.notes}
                <p class="about-update-notes">{updaterCtrl.notes}</p>
              {/if}
              <div class="about-update-actions">
                <button class="btn ghost" onclick={() => updaterCtrl.dismiss()}>Not now</button>
                <button class="btn" onclick={() => updaterCtrl.downloadAndInstall()}>Download &amp; Install</button>
              </div>
            </div>
          {:else if updaterCtrl.phase === "downloading"}
            <div class="about-update-card">
              {#if updaterCtrl.progress != null}
                <div class="about-update-bar"><div class="about-update-fill" style="width:{updaterCtrl.progress}%"></div></div>
                <span class="mut">Downloading&#8230; {updaterCtrl.progress}%</span>
              {:else}
                <span class="mut"><span class="spinner"></span> Downloading&#8230;</span>
              {/if}
            </div>
          {:else if updaterCtrl.phase === "ready"}
            <div class="about-update-card">
              <div>Update downloaded &#8212; restart to finish installing.</div>
              <div class="about-update-actions">
                <button class="btn" onclick={() => updaterCtrl.restart()}>Restart Now</button>
              </div>
            </div>
          {:else if updaterCtrl.phase === "error"}
            <span class="mut">{updaterCtrl.error} <button class="linklike" onclick={() => updaterCtrl.dismiss()}>Dismiss</button></span>
          {/if}
        </div>

        <div class="modal-foot" style="justify-content:center;border-top:none;padding-top:16px">
          <button class="btn ghost" onclick={() => aboutCtrl.openWebsite()}><Link class="ico" size={14} aria-hidden="true" /> GitHub</button>
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

  .about-update {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
    font-size: 12.5px;
    display: flex;
    justify-content: center;
  }
  .linklike {
    border: none;
    background: none;
    padding: 0;
    color: var(--accent);
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  .about-update-card {
    width: 100%;
    text-align: left;
  }
  .about-update-notes {
    color: var(--muted);
    font-size: 11.5px;
    line-height: 1.5;
    margin: 8px 0 0;
    max-height: 70px;
    overflow-y: auto;
    white-space: pre-wrap;
  }
  .about-update-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }
  .about-update-bar {
    width: 100%;
    height: 6px;
    border-radius: 999px;
    background: var(--elevated);
    overflow: hidden;
    margin-bottom: 6px;
  }
  .about-update-fill {
    height: 100%;
    background: var(--accent);
    border-radius: inherit;
    transition: width 0.25s ease;
  }

  @media (prefers-reduced-motion: reduce) {
    .about-modal,
    .about-tama,
    .about-sparkle {
      animation: none !important;
    }
  }
</style>
