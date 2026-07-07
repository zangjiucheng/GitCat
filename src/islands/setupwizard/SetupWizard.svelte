<script lang="ts">
  // Setup wizard — view. Deliberately NO <style> block: reuses the existing
  // global .scrim/.modal/.msteps/.confirm-type/.pl-err/.pl-kv/.hero-hint
  // classes (see index.html / FilterRepo.svelte), so this looks consistent
  // with the rest of the app's chrome. Mounted straight to document.body
  // (like Resolver/Bisect/FilterRepo), as an overlay on top of whatever
  // legacy/main.ts already rendered underneath (the hero card, or the demo
  // graph) — Esc/Skip just reveals what's already there.
  import { setupWizardCtrl, type SetupWizardStep } from "./setupwizard.svelte.ts";

  const STEP_ORDER: SetupWizardStep[] = ["welcome", "pick", "identity", "done"];

  function stepIndex(): number {
    return STEP_ORDER.indexOf(setupWizardCtrl.step);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape" || !setupWizardCtrl.open) return;
    if (setupWizardCtrl.busy) return; // don't strand an in-flight dialog/save/open
    setupWizardCtrl.skip();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" id="setupWizardScrim" class:on={setupWizardCtrl.open}>
  <div class="modal">
    <div class="modal-head">
      <div class="modal-tama"><img class="tama-pic" src={setupWizardCtrl.tamaImg} alt="Tama" /></div>
      <div>
        <h3>Let's get you set up</h3>
        <p>
          {#if setupWizardCtrl.step === "welcome"}
            はじめまして! I'll help you open your first repository.
          {:else if setupWizardCtrl.step === "pick"}
            Choose the folder that has the repository you want to work in.
          {:else if setupWizardCtrl.step === "identity"}
            This repository has no commit identity yet — I can set one just for it.
          {:else}
            All set — ready to open the graph.
          {/if}
        </p>
      </div>
    </div>

    <div class="msteps" id="setupWizardSteps">
      {#each STEP_ORDER as _s, i}
        <span class="s" class:done={i < stepIndex()} class:now={i === stepIndex()}></span>
      {/each}
    </div>

    <div class="modal-body">
      {#if setupWizardCtrl.step === "welcome"}
        <p class="mut">Three quick steps: pick a repository, confirm who you are (only for that repo), then jump into the graph.</p>
      {:else if setupWizardCtrl.step === "pick"}
        {#if setupWizardCtrl.repoPath}
          <div class="pl-kv"><div><span class="mut">selected</span> <span class="mono">{setupWizardCtrl.repoPath}</span></div></div>
        {/if}
        {#if setupWizardCtrl.pathError}
          <div class="pl-err" style="margin-top:10px">{setupWizardCtrl.pathError}</div>
        {/if}
      {:else if setupWizardCtrl.step === "identity"}
        <div class="confirm-type">
          <label for="swName">Name</label>
          <input id="swName" autocomplete="off" spellcheck="false" bind:value={setupWizardCtrl.nameInput} />
          <label for="swEmail" style="margin-top:8px">Email</label>
          <input id="swEmail" autocomplete="off" spellcheck="false" bind:value={setupWizardCtrl.emailInput} />
        </div>
        <p class="hero-hint">Written only to this repository's <code>.git/config</code> — your global git identity is never touched.</p>
        {#if setupWizardCtrl.saveError}
          <div class="pl-err">{setupWizardCtrl.saveError}</div>
        {/if}
      {:else if setupWizardCtrl.step === "done"}
        {#if setupWizardCtrl.identity?.configured}
          <div class="backup-note">Identity: <span class="mono">{setupWizardCtrl.identity.name} &lt;{setupWizardCtrl.identity.email}&gt;</span></div>
        {:else}
          <p class="mut">No identity set — you can add one later with <code>git config user.name</code>/<code>user.email</code>.</p>
        {/if}
      {/if}
    </div>

    <div class="modal-foot">
      {#if setupWizardCtrl.step === "welcome"}
        <button class="btn ghost" onclick={() => setupWizardCtrl.skip()}>Skip</button>
        <button class="btn" onclick={() => setupWizardCtrl.toPick()}>Get started</button>
      {:else if setupWizardCtrl.step === "pick"}
        <button class="btn ghost" onclick={() => setupWizardCtrl.skip()}>Skip</button>
        <button class="btn ghost" onclick={() => setupWizardCtrl.backToWelcome()}>Back</button>
        <button class="btn" disabled={setupWizardCtrl.busy} onclick={() => setupWizardCtrl.pickDirectory()}>Choose folder&#8230;</button>
      {:else if setupWizardCtrl.step === "identity"}
        <button class="btn ghost" onclick={() => setupWizardCtrl.skip()}>Skip setup</button>
        <button class="btn ghost" onclick={() => setupWizardCtrl.backToPick()}>Back</button>
        <button class="btn ghost" onclick={() => setupWizardCtrl.skipIdentity()}>Not now</button>
        <button class="btn" disabled={!setupWizardCtrl.canSave} onclick={() => setupWizardCtrl.saveIdentity()}>Save &amp; continue</button>
      {:else if setupWizardCtrl.step === "done"}
        <button class="btn ghost" onclick={() => setupWizardCtrl.skip()}>Skip</button>
        <button class="btn" disabled={setupWizardCtrl.busy} onclick={() => setupWizardCtrl.finish()}>Open repository &#8594;</button>
      {/if}
    </div>
  </div>
</div>
