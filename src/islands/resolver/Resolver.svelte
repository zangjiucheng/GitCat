<script lang="ts">
  import { resolver } from "./resolver.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import { IN_TAURI } from "../../ipc/env";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";

  // ext -> highlight grammar key (was langForConflict)
  function langFor(path: string): string {
    const ext = (path || "").split(".").pop()!.toLowerCase();
    return ["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext) ? "ts" : "generic";
  }
  const lines = (txt: string) => (txt || "").split("\n");

  // Abort button copy — op-flavored ("Abort merge"/"Abort pick"/"Abort rebase"/"Abort revert"/"Abort stash"/"Abort squash"/"Abort patch apply").
  function abortLabel(op: string): string {
    if (op === "merge") return "Abort merge";
    if (op === "rebase") return "Abort rebase";
    if (op === "revert") return "Abort revert";
    if (op === "stash") return "Abort stash";
    if (op === "merge-squash") return "Abort squash";
    if (op === "am") return "Abort patch apply";
    return "Abort pick";
  }

  // Continue button copy — every other op's continue step creates a commit;
  // finishing a stash conflict doesn't (apply leaves the entry as-is, a
  // resolved pop only drops it — see stash_conflict_continue's doc comment),
  // so "& commit" would be misleading there. Finishing a merge-squash
  // conflict doesn't commit either — it only finishes STAGING (see
  // merge_squash_continue's doc comment); the actual commit is the Workdir
  // hand-off that follows. An interactive-rebase "editing" pause is its own
  // third case: Continue just advances the sequencer (any commit already
  // happened via the Workdir panel's amend, or nothing changed at all), so
  // neither "& commit" nor plain "Continue" reads quite right.
  function continueLabel(op: string, editing: boolean): string {
    if (editing) return "Continue rebase";
    return op === "stash" || op === "merge-squash" ? "Continue" : "Continue & commit";
  }

  // Escape closes only a design-mode (browser) resolver — never a live real pick.
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape" || !resolver.open) return;
    if (IN_TAURI) return; // don't strand a live pick — use Abort
    resolver.close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" id="conflictScrim" class:on={resolver.open}>
  <div class="modal resolver">
    <div class="modal-head">
      <div class="modal-tama"><img class="tama-pic" src={resolver.tamaImg} alt="Tama, cautioning" /></div>
      <div><h3>{resolver.title}</h3><p>{resolver.sub}</p></div>
    </div>
    <div class="modal-body">
      {#if resolver.editing}
        <div class="rb-edit-banner">
          <p>{resolver.sub}</p>
          <button class="btn" onclick={() => resolver.openWorkdirToAmend()}>Open Workdir to amend&#8230;</button>
        </div>
      {:else}
        <div class="cf-layout">
          <div class="cf-files" data-vimnav-list>
            {#each resolver.files as f (f.path)}
              {@const resolved = !resolver.remaining.has(f.path)}
              <div
                class="cf-file"
                class:sel={f.path === resolver.selected}
                class:done={resolved}
                role="button"
                tabindex="0"
                onclick={() => resolver.select(f.path)}
                onkeydown={(e) => (e.key === "Enter" || e.key === " ") && resolver.select(f.path)}
              >
                <span class="cf-mk">{resolved ? "✓" : "●"}</span><span class="cf-name">{f.path}</span>
              </div>
            {/each}
          </div>
          <div class="cf-main">
            {#if resolver.current}
              <div class="cf-actions">
                <span class="cf-cur">{resolver.current.path}</span>
                <span class="cf-take">
                  <button class="btn" disabled={!resolver.currentLive || resolver.busy} onclick={() => resolver.take("ours")}
                    >{#if resolver.activeAction === "ours"}<span class="spinner"></span> Taking…{:else}Take ours{/if}</button
                  ><button class="btn" disabled={!resolver.currentLive || resolver.busy} onclick={() => resolver.take("theirs")}
                    >{#if resolver.activeAction === "theirs"}<span class="spinner"></span> Taking…{:else}Take theirs{/if}</button
                  ><button
                    class="btn ghost"
                    disabled={!resolver.currentLive || resolver.busy}
                    onclick={() => resolver.resolveWithExternalTool()}
                    >{#if resolver.activeAction === "tool"}<span class="spinner"></span> Resolving…{:else}Resolve with tool{/if}</button
                  >
                </span>
              </div>
              {@const lang = langFor(resolver.current.path)}
              <div class="cf-content" id="cfThree">
                <div class="cf-compare">
                  {@render col("ours", "Ours (HEAD)", resolver.current.ours, lang)}
                  {@render col("theirs", "Theirs (picked)", resolver.current.theirs, lang)}
                </div>
                <div class="cf-result">
                  <div class="cf-result-head">
                    <h6>Result</h6>
                    <button class="btn" disabled={resolver.busy || resolver.editBinary || resolver.editLoading} onclick={() => resolver.saveEditResolution()}
                      >{#if resolver.activeAction === "editSave"}<span class="spinner"></span> Saving…{:else}Save resolution{/if}</button
                    >
                  </div>
                  {#if resolver.editLoading}
                    <div class="cf-edit-loading"><span class="spinner"></span> Loading…</div>
                  {:else if resolver.editBinary}
                    <div class="cf-edit-loading"><span class="mut">This file is binary — use Take ours/theirs or Resolve with tool instead.</span></div>
                  {:else}
                    <div class="cf-edit">
                      {#each resolver.editHunks as h, i}
                        {#if h.kind === "context"}
                          <pre class="cf-edit-context">{h.context}</pre>
                        {:else}
                          <div class="cf-edit-conflict">
                            <div class="cf-edit-conflict-actions">
                              <button class="btn ghost" onclick={() => resolver.useSide(i, "ours")}>Use ours</button>
                              <button class="btn ghost" onclick={() => resolver.useSide(i, "theirs")}>Use theirs</button>
                            </div>
                            <textarea
                              class="cf-edit-textarea"
                              spellcheck="false"
                              value={resolver.editValues[i]}
                              oninput={(e) => resolver.setEditValue(i, (e.target as HTMLTextAreaElement).value)}
                            ></textarea>
                          </div>
                        {/if}
                      {/each}
                    </div>
                  {/if}
                </div>
              </div>
            {:else}
              <div class="cf-all-resolved">
                <span class="mut">All files resolved — press Continue &amp; commit.</span>
              </div>
            {/if}
          </div>
        </div>
      {/if}
      <div class="backup-note" style="margin-top:12px">
        <RotateCcw class="ico" size={14} aria-hidden="true" /> Snapshot before {resolver.op}: <code>{resolver.backupRef}</code>{#if !resolver.editing} &#183; rerere may auto-apply a recorded resolution.{/if}
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" id="conflictAbort" disabled={resolver.busy} onclick={() => resolver.abort()}
        >{#if resolver.activeAction === "abort"}<span class="spinner"></span> Aborting…{:else}{abortLabel(resolver.op)}{/if}</button
      >
      {#if (resolver.op === "rebase" || resolver.op === "am") && !resolver.editing}
        <button class="btn ghost" id="conflictSkip" disabled={resolver.busy} onclick={() => resolver.skip()}
          >{#if resolver.activeAction === "skip"}<span class="spinner"></span> Skipping…{:else}Skip this commit{/if}</button
        >
      {/if}
      {#if !resolver.editing}
        <span class="cf-remain mut"
          >{resolver.remainingCount
            ? resolver.remainingCount + " file" + (resolver.remainingCount === 1 ? "" : "s") + " left"
            : "all resolved"}</span
        >
      {/if}
      <button
        class="btn"
        style="background:var(--accent2);border-color:var(--accent2)"
        disabled={resolver.remainingCount > 0 || resolver.busy}
        onclick={() => resolver.continue()}
        >{#if resolver.activeAction === "continue"}<span class="spinner"></span> Committing…{:else}{continueLabel(resolver.op, resolver.editing)}{/if}</button
      >
    </div>
  </div>
</div>

{#if resolver.dirtyBlock}
  {@const block = resolver.dirtyBlock}
  <div class="scrim on">
    <div class="modal">
      <div class="modal-head">
        <div>
          <h3>{block.verb} blocked by local changes</h3>
          <p>{block.message}</p>
        </div>
      </div>
      <div class="modal-body">
        <p class="mut">
          Stash your uncommitted changes, then retry the {block.verb.toLowerCase()} — or leave it and sort the working
          tree out yourself.
        </p>
        {#if resolver.dirtyBlockStuck}
          <p class="dirty-stuck-note">&#9888;&#65039; {resolver.dirtyBlockStuck}</p>
        {/if}
      </div>
      <div class="modal-foot">
        <button class="btn ghost" disabled={resolver.busy} onclick={() => resolver.cancelDirtyBlock()}>Cancel</button>
        <button class="btn ghost" disabled={resolver.busy} onclick={() => resolver.stashAndRetryDirtyBlock()}
          >{#if resolver.busy}<span class="spinner"></span> Working…{:else}Stash &amp; retry{/if}</button
        >
        <button
          class="btn"
          style="background:var(--accent2);border-color:var(--accent2)"
          disabled={resolver.busy}
          onclick={() => resolver.stashAndRetryDirtyBlockReapply()}
          >{#if resolver.busy}<span class="spinner"></span> Working…{:else}Stash, retry &amp; reapply{/if}</button
        >
      </div>
    </div>
  </div>
{/if}

{#if resolver.editing && !resolver.open}
  <div class="rb-pause-pill" role="status">
    <span class="rb-pause-ic">&#9208;</span>
    <span class="rb-pause-txt">Rebase paused{resolver.sha ? " — editing " + resolver.sha : ""}</span>
    <button class="btn ghost" style="padding:4px 10px" onclick={() => resolver.reopen()}>Details</button>
    <button class="btn ghost" style="padding:4px 10px" disabled={resolver.busy} onclick={() => resolver.abort()}
      >{#if resolver.activeAction === "abort"}<span class="spinner"></span>{:else}Abort{/if}</button
    >
    <button
      class="btn"
      style="padding:4px 10px;background:var(--accent2);border-color:var(--accent2)"
      disabled={resolver.busy}
      onclick={() => resolver.continue()}
      >{#if resolver.activeAction === "continue"}<span class="spinner"></span>{:else}Continue rebase{/if}</button
    >
  </div>
{/if}

{#snippet col(cls: string, title: string, txt: string, lang: string)}
  <div class="tw-col {cls}">
    <h6>{title}</h6>
    {#each lines(txt) as line}
      <div class="ln"><code>{@html bridge.highlight(line, lang)}</code></div>
    {:else}
      <div class="ln"><span class="mut">— empty —</span></div>
    {/each}
  </div>
{/snippet}
