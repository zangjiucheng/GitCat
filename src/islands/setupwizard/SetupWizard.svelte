<script lang="ts">
  // Setup wizard — view. Deliberately NO <style> block: reuses the existing
  // global .scrim/.modal/.msteps/.confirm-type/.pl-err/.hero-hint classes
  // (see index.html / FilterRepo.svelte), so this looks consistent with the
  // rest of the app's chrome — plus two new shared classes this wizard
  // motivated: .modal-cta (a prominent "nothing chosen yet" prompt for the
  // pick step, instead of empty space) and .modal-steplist (the welcome
  // step's numbered preview). The wrapper carries its own `.setupwizard`
  // modifier class (see index.html) so it gets an accent2 header/step-dot
  // tint instead of .modal-head's base danger-red, which is tuned for the
  // filter-repo wizard — every OTHER modal already overrides that per its own
  // tone (.resolver = warning, .bisecter = accent); this one had been missing
  // that override. Mounted straight to document.body (like Resolver/Bisect/
  // FilterRepo), as an overlay on top of whatever legacy/main.ts already
  // rendered underneath (the hero card, or the demo graph) — Esc/Skip just
  // reveals what's already there.
  //
  // The pick step's .modal-cta doubles as the *only* affordance for
  // choosing a folder (the `.modal-drop` modifier): clicking or
  // Enter/Space-ing it opens the native picker, same as a real
  // "drag file here, or click to browse" widget, and it also accepts a
  // dropped OS folder (see setupwizard.svelte.ts's armDropZone/
  // acceptDroppedPath) — reusing this one box for the already-selected state
  // too so dropping a different folder onto it re-picks, rather than needing
  // a separate footer button once something's chosen.
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

  function onDropZoneKeydown(e: KeyboardEvent) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (!setupWizardCtrl.busy) setupWizardCtrl.pickDirectory();
  }

  // Arm/disarm the native drag-and-drop listener as the drop zone itself
  // mounts/unmounts, rather than at every individual step-transition call
  // site — one reactive owner instead of scattering arm()/disarm() calls
  // across toPick()/backToPick()/backToWelcome()/validate()/skip().
  $effect(() => {
    if (setupWizardCtrl.open && setupWizardCtrl.step === "pick") setupWizardCtrl.armDropZone();
    else setupWizardCtrl.disarmDropZone();
  });
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" id="setupWizardScrim" class:on={setupWizardCtrl.open}>
  <div class="modal setupwizard">
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
        <div class="modal-steplist">
          <div class="row">
            <span class="n">1</span>
            <span class="txt">Pick a repository<span class="mut">Point me at a folder on your machine</span></span>
          </div>
          <div class="row">
            <span class="n">2</span>
            <span class="txt">Confirm who you are<span class="mut">Only for that repo — your global git identity is never touched</span></span>
          </div>
          <div class="row">
            <span class="n">3</span>
            <span class="txt">Jump into the graph<span class="mut">You're ready to go</span></span>
          </div>
        </div>
      {:else if setupWizardCtrl.step === "pick"}
        <div
          class="modal-cta modal-drop"
          class:dragover={setupWizardCtrl.dragOver}
          class:busy={setupWizardCtrl.busy}
          role="button"
          tabindex="0"
          aria-disabled={setupWizardCtrl.busy}
          onclick={() => setupWizardCtrl.pickDirectory()}
          onkeydown={onDropZoneKeydown}
        >
          <div class="ic">&#128193;</div>
          {#if setupWizardCtrl.repoPath}
            <div class="t mono">{setupWizardCtrl.repoPath}</div>
            <div class="sub">
              {#if setupWizardCtrl.busy}<span class="spinner"></span> Checking&#8230;{:else}Click, or drop another folder, to change it{/if}
            </div>
          {:else}
            <div class="t">Drop a folder here</div>
            <div class="sub">or click to browse for one</div>
          {/if}
        </div>
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
        {#if setupWizardCtrl.finishError}
          <div class="pl-err" style="margin-top:10px">{setupWizardCtrl.finishError}</div>
        {/if}
      {/if}
    </div>

    <div class="modal-foot">
      {#if setupWizardCtrl.step === "welcome"}
        <button class="btn ghost" onclick={() => setupWizardCtrl.skip()}>Skip</button>
        <button class="btn" onclick={() => setupWizardCtrl.toPick()}>Get started</button>
      {:else if setupWizardCtrl.step === "pick"}
        <button class="btn ghost" disabled={setupWizardCtrl.busy} onclick={() => setupWizardCtrl.skip()}>Skip</button>
        <button class="btn ghost" disabled={setupWizardCtrl.busy} onclick={() => setupWizardCtrl.backToWelcome()}>Back</button>
      {:else if setupWizardCtrl.step === "identity"}
        <button class="btn ghost" disabled={setupWizardCtrl.busy} onclick={() => setupWizardCtrl.skip()}>Skip setup</button>
        <button class="btn ghost" disabled={setupWizardCtrl.busy} onclick={() => setupWizardCtrl.backToPick()}>Back</button>
        <button class="btn ghost" disabled={setupWizardCtrl.busy} onclick={() => setupWizardCtrl.skipIdentity()}>Not now</button>
        <button class="btn" disabled={!setupWizardCtrl.canSave} onclick={() => setupWizardCtrl.saveIdentity()}
          >{#if setupWizardCtrl.busy}<span class="spinner"></span> Saving&#8230;{:else}Save &amp; continue{/if}</button
        >
      {:else if setupWizardCtrl.step === "done"}
        <button class="btn ghost" disabled={setupWizardCtrl.busy} onclick={() => setupWizardCtrl.skip()}>Skip</button>
        <button class="btn" disabled={setupWizardCtrl.busy} onclick={() => setupWizardCtrl.finish()}
          >{#if setupWizardCtrl.busy}<span class="spinner"></span> Opening&#8230;{:else}Open repository &#8594;{/if}</button
        >
      {/if}
    </div>
  </div>
</div>
