<script lang="ts">
  // Rerere panel — view. Deliberately NO <style> block: reuses the drawer's
  // existing global classes (.rr-row / .h / .rr-badge / .mut / .cp-x) so it
  // looks consistent with the rest of the pane chrome. Mounted directly INTO
  // #pane-rerere (replacing its old static 3-row mockup) — see index.html and
  // src/main.ts.
  import { rerereCtrl } from "./rerere.svelte.ts";
  import { IN_TAURI } from "../../ipc/env";

  function onToggle(e: Event) {
    rerereCtrl.setEnabled((e.currentTarget as HTMLInputElement).checked);
  }
</script>

<div class="rr-row">
  <label class="cp-x" title="git config rerere.enabled — repo-local only, never --global">
    <input type="checkbox" checked={rerereCtrl.enabled} disabled={rerereCtrl.busy || !rerereCtrl.vm} onchange={onToggle} />
    rerere {rerereCtrl.enabled ? "on" : "off"}
  </label>
  {#if rerereCtrl.busy}
    <span class="mut"><span class="spinner"></span> Saving&#8230;</span>
  {:else}
    <span class="mut">{rerereCtrl.sourceNote}</span>
  {/if}
</div>

{#if !rerereCtrl.vm}
  <div class="rr-row">
    <span class="mut"
      >{#if rerereCtrl.busy}<span class="spinner"></span> Loading&#8230;{:else if IN_TAURI}Open a repository to see recorded resolutions.{:else}Loading&#8230;{/if}</span
    >
  </div>
{:else}
  {#if rerereCtrl.vm.liveConflict}
    <div class="rr-row"><span class="mut">Conflict in progress — rerere is tracking {rerereCtrl.vm.livePaths.length} path(s) below.</span></div>
  {/if}
  {#each rerereCtrl.rows as row (row.key)}
    <div class="rr-row">
      <span class="h">{row.label}</span>
      {#if row.resolved}
        <span class="rr-badge">resolution recorded</span>
      {:else}
        <span class="mut">pending &#8212; not yet resolved</span>
      {/if}
      {#if row.isPath}<span class="mut">live</span>{/if}
    </div>
  {:else}
    <div class="rr-row">
      <span class="mut">No resolutions recorded yet &#8212; git rerere records one the first time you resolve a repeatable conflict by hand.</span>
    </div>
  {/each}
{/if}
