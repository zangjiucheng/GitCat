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
  import { t } from "../../i18n/i18n.svelte.ts";
  import Folder from "@lucide/svelte/icons/folder";

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
        <h3>{t("setupwizard.title")}</h3>
        <p>
          {#if setupWizardCtrl.step === "welcome"}
            {t("setupwizard.sub_welcome")}
          {:else if setupWizardCtrl.step === "pick"}
            {t("setupwizard.sub_pick")}
          {:else if setupWizardCtrl.step === "identity"}
            {t("setupwizard.sub_identity")}
          {:else}
            {t("setupwizard.sub_done")}
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
            <span class="txt">{t("setupwizard.step1_title")}<span class="mut">{t("setupwizard.step1_sub")}</span></span>
          </div>
          <div class="row">
            <span class="n">2</span>
            <span class="txt">{t("setupwizard.step2_title")}<span class="mut">{t("setupwizard.step2_sub")}</span></span>
          </div>
          <div class="row">
            <span class="n">3</span>
            <span class="txt">{t("setupwizard.step3_title")}<span class="mut">{t("setupwizard.step3_sub")}</span></span>
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
          <div class="ic"><Folder size={30} strokeWidth={1.3} aria-hidden="true" /></div>
          {#if setupWizardCtrl.repoPath}
            <div class="t mono">{setupWizardCtrl.repoPath}</div>
            <div class="sub">
              {#if setupWizardCtrl.busy}<span class="spinner"></span> {t("setupwizard.checking")}{:else}{t("setupwizard.change_hint")}{/if}
            </div>
          {:else}
            <div class="t">{t("setupwizard.drop_here")}</div>
            <div class="sub">{t("setupwizard.or_browse")}</div>
          {/if}
        </div>
        {#if setupWizardCtrl.pathError}
          <div class="pl-err" style="margin-top:10px">{setupWizardCtrl.pathError}</div>
        {/if}
      {:else if setupWizardCtrl.step === "identity"}
        <div class="confirm-type">
          <label for="swName">{t("setupwizard.name_label")}</label>
          <input id="swName" autocomplete="off" spellcheck="false" bind:value={setupWizardCtrl.nameInput} />
          <label for="swEmail" style="margin-top:8px">{t("setupwizard.email_label")}</label>
          <input id="swEmail" autocomplete="off" spellcheck="false" bind:value={setupWizardCtrl.emailInput} />
        </div>
        <p class="hero-hint">{t("setupwizard.identity_hint_pre")}<code>.git/config</code>{t("setupwizard.identity_hint_post")}</p>
        {#if setupWizardCtrl.saveError}
          <div class="pl-err">{setupWizardCtrl.saveError}</div>
        {/if}
      {:else if setupWizardCtrl.step === "done"}
        {#if setupWizardCtrl.identity?.configured}
          <div class="backup-note">{t("setupwizard.done_identity")} <span class="mono">{setupWizardCtrl.identity.name} &lt;{setupWizardCtrl.identity.email}&gt;</span></div>
        {:else}
          <p class="mut">{t("setupwizard.done_no_identity_pre")}<code>git config user.name</code>/<code>user.email</code>{t("setupwizard.done_no_identity_post")}</p>
        {/if}
        {#if setupWizardCtrl.finishError}
          <div class="pl-err" style="margin-top:10px">{setupWizardCtrl.finishError}</div>
        {/if}
      {/if}
    </div>

    <div class="modal-foot">
      {#if setupWizardCtrl.step === "welcome"}
        <button class="btn ghost" onclick={() => setupWizardCtrl.skip()}>{t("setupwizard.skip")}</button>
        <button class="btn" onclick={() => setupWizardCtrl.toPick()}>{t("setupwizard.get_started")}</button>
      {:else if setupWizardCtrl.step === "pick"}
        <button class="btn ghost" disabled={setupWizardCtrl.busy} onclick={() => setupWizardCtrl.skip()}>{t("setupwizard.skip")}</button>
        <button class="btn ghost" disabled={setupWizardCtrl.busy} onclick={() => setupWizardCtrl.backToWelcome()}>{t("setupwizard.back")}</button>
      {:else if setupWizardCtrl.step === "identity"}
        <button class="btn ghost" disabled={setupWizardCtrl.busy} onclick={() => setupWizardCtrl.skip()}>{t("setupwizard.skip_setup")}</button>
        <button class="btn ghost" disabled={setupWizardCtrl.busy} onclick={() => setupWizardCtrl.backToPick()}>{t("setupwizard.back")}</button>
        <button class="btn ghost" disabled={setupWizardCtrl.busy} onclick={() => setupWizardCtrl.skipIdentity()}>{t("setupwizard.not_now")}</button>
        <button class="btn" disabled={!setupWizardCtrl.canSave} onclick={() => setupWizardCtrl.saveIdentity()}
          >{#if setupWizardCtrl.busy}<span class="spinner"></span> {t("setupwizard.saving")}{:else}{t("setupwizard.save_continue")}{/if}</button
        >
      {:else if setupWizardCtrl.step === "done"}
        <button class="btn ghost" disabled={setupWizardCtrl.busy} onclick={() => setupWizardCtrl.skip()}>{t("setupwizard.skip")}</button>
        <button class="btn" disabled={setupWizardCtrl.busy} onclick={() => setupWizardCtrl.finish()}
          >{#if setupWizardCtrl.busy}<span class="spinner"></span> {t("setupwizard.opening")}{:else}{t("setupwizard.open_repo")}{/if}</button
        >
      {/if}
    </div>
  </div>
</div>
