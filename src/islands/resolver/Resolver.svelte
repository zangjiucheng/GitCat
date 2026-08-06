<script lang="ts">
  import { resolver } from "./resolver.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import { IN_TAURI } from "../../ipc/env";
  import { t } from "../../i18n/i18n.svelte.ts";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";

  // ext -> highlight grammar key (was langForConflict)
  function langFor(path: string): string {
    const ext = (path || "").split(".").pop()!.toLowerCase();
    return ["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext) ? "ts" : "generic";
  }
  const lines = (txt: string) => (txt || "").split("\n");

  // Abort button copy — op-flavored ("Abort merge"/"Abort pick"/"Abort rebase"/"Abort revert"/"Abort stash"/"Abort squash"/"Abort patch apply").
  function abortLabel(op: string): string {
    if (op === "merge") return t("resolver.abort_merge");
    if (op === "rebase") return t("resolver.abort_rebase");
    if (op === "revert") return t("resolver.abort_revert");
    if (op === "stash") return t("resolver.abort_stash");
    if (op === "merge-squash") return t("resolver.abort_squash");
    if (op === "am") return t("resolver.abort_am");
    return t("resolver.abort_pick");
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
    if (editing) return t("resolver.continue_rebase");
    return op === "stash" || op === "merge-squash" ? t("resolver.continue") : t("resolver.continue_commit");
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
      <div class="modal-tama"><img class="tama-pic" src={resolver.tamaImg} alt={t("resolver.tama_alt")} /></div>
      <div><h3>{resolver.title}</h3><p>{resolver.sub}</p></div>
    </div>
    <div class="modal-body">
      {#if resolver.editing}
        <div class="rb-edit-banner">
          <p>{resolver.sub}</p>
          <button class="btn" onclick={() => resolver.openWorkdirToAmend()}>{t("resolver.open_workdir_amend")}</button>
        </div>
      {:else}
        <div class="cf-layout" class:no-files={!resolver.files.length}>
          {#if resolver.files.length}
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
          {/if}
          <div class="cf-main">
            {#if resolver.current}
              <div class="cf-actions">
                <span class="cf-cur">{resolver.current.path}</span>
                <span class="cf-take">
                  <button class="btn" disabled={!resolver.currentLive || resolver.busy} onclick={() => resolver.take("ours")}
                    >{#if resolver.activeAction === "ours"}<span class="spinner"></span> {t("resolver.taking")}{:else}{t("resolver.take_ours")}{/if}</button
                  ><button class="btn" disabled={!resolver.currentLive || resolver.busy} onclick={() => resolver.take("theirs")}
                    >{#if resolver.activeAction === "theirs"}<span class="spinner"></span> {t("resolver.taking")}{:else}{t("resolver.take_theirs")}{/if}</button
                  ><button
                    class="btn ghost"
                    disabled={!resolver.currentLive || resolver.busy}
                    onclick={() => resolver.resolveWithExternalTool()}
                    >{#if resolver.activeAction === "tool"}<span class="spinner"></span> {t("resolver.resolving")}{:else}{t("resolver.resolve_with_tool")}{/if}</button
                  >
                </span>
              </div>
              {@const lang = langFor(resolver.current.path)}
              <div class="cf-content" id="cfThree">
                <div class="cf-compare">
                  {@render col("ours", t("resolver.col_ours"), resolver.current.ours, lang)}
                  {@render col("theirs", t("resolver.col_theirs"), resolver.current.theirs, lang)}
                </div>
                <div class="cf-result">
                  <div class="cf-result-head">
                    <h6>{t("resolver.result")}</h6>
                    <button class="btn" disabled={resolver.busy || resolver.editBinary || resolver.editLoading} onclick={() => resolver.saveEditResolution()}
                      >{#if resolver.activeAction === "editSave"}<span class="spinner"></span> {t("resolver.saving")}{:else}{t("resolver.save_resolution")}{/if}</button
                    >
                  </div>
                  {#if resolver.editLoading}
                    <div class="cf-edit-loading"><span class="spinner"></span> {t("common.loading")}</div>
                  {:else if resolver.editBinary}
                    <div class="cf-edit-loading"><span class="mut">{t("resolver.binary_file")}</span></div>
                  {:else}
                    <div class="cf-edit">
                      {#each resolver.editHunks as h, i}
                        {#if h.kind === "context"}
                          <pre class="cf-edit-context">{h.context}</pre>
                        {:else}
                          <div class="cf-edit-conflict">
                            <div class="cf-edit-conflict-actions">
                              <button class="btn ghost" onclick={() => resolver.useSide(i, "ours")}>{t("resolver.use_ours")}</button>
                              <button class="btn ghost" onclick={() => resolver.useSide(i, "theirs")}>{t("resolver.use_theirs")}</button>
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
                {#if resolver.stuckMessage}
                  <span class="mut">{t("resolver.couldnt_commit_note")}</span>
                {:else}
                  <span class="mut">{t("resolver.all_resolved_press")}</span>
                {/if}
              </div>
            {/if}
          </div>
        </div>
      {/if}
      {#if resolver.stuckMessage}
        <div class="cf-stuck-note">&#9888;&#65039; {resolver.stuckMessage}</div>
      {/if}
      <div class="backup-note" style="margin-top:12px">
        <RotateCcw class="ico" size={14} aria-hidden="true" /> {t("resolver.snapshot_before", { op: resolver.op })} <code>{resolver.backupRef}</code>{#if !resolver.editing} &#183; {t("resolver.rerere_note")}{/if}
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" id="conflictAbort" disabled={resolver.busy} onclick={() => resolver.abort()}
        >{#if resolver.activeAction === "abort"}<span class="spinner"></span> {t("resolver.aborting")}{:else}{abortLabel(resolver.op)}{/if}</button
      >
      {#if (resolver.op === "rebase" || resolver.op === "am") && !resolver.editing}
        <button class="btn ghost" id="conflictSkip" disabled={resolver.busy} onclick={() => resolver.skip()}
          >{#if resolver.activeAction === "skip"}<span class="spinner"></span> {t("resolver.skipping")}{:else}{t("resolver.skip_commit")}{/if}</button
        >
      {/if}
      {#if !resolver.editing}
        <span class="cf-remain mut"
          >{resolver.remainingCount
            ? (resolver.remainingCount === 1
                ? t("resolver.files_left_one", { n: resolver.remainingCount })
                : t("resolver.files_left_other", { n: resolver.remainingCount }))
            : t("resolver.all_resolved")}</span
        >
      {/if}
      <button
        class="btn"
        style="background:var(--accent2);border-color:var(--accent2)"
        disabled={resolver.remainingCount > 0 || resolver.busy}
        onclick={() => resolver.continue()}
        >{#if resolver.activeAction === "continue"}<span class="spinner"></span> {t("resolver.committing")}{:else}{continueLabel(resolver.op, resolver.editing)}{/if}</button
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
          <h3>{t("resolver.dirty_blocked_title", { verb: block.verb })}</h3>
          <p>{block.message}</p>
        </div>
      </div>
      <div class="modal-body">
        <p class="mut">{t("resolver.dirty_blocked_hint", { verb: block.verb.toLowerCase() })}</p>
        {#if resolver.dirtyBlockStuck}
          <p class="dirty-stuck-note">&#9888;&#65039; {resolver.dirtyBlockStuck}</p>
        {/if}
      </div>
      <div class="modal-foot">
        <button class="btn ghost" disabled={resolver.busy} onclick={() => resolver.cancelDirtyBlock()}>{t("common.cancel")}</button>
        <button class="btn ghost" disabled={resolver.busy} onclick={() => resolver.stashAndRetryDirtyBlock()}
          >{#if resolver.busy}<span class="spinner"></span> {t("resolver.working")}{:else}{t("resolver.stash_retry")}{/if}</button
        >
        <button
          class="btn"
          style="background:var(--accent2);border-color:var(--accent2)"
          disabled={resolver.busy}
          onclick={() => resolver.stashAndRetryDirtyBlockReapply()}
          >{#if resolver.busy}<span class="spinner"></span> {t("resolver.working")}{:else}{t("resolver.stash_retry_reapply")}{/if}</button
        >
      </div>
    </div>
  </div>
{/if}

{#if resolver.editing && !resolver.open}
  <div class="rb-pause-pill" role="status">
    <span class="rb-pause-ic">&#9208;</span>
    <span class="rb-pause-txt">{resolver.sha ? t("resolver.paused_editing", { sha: resolver.sha }) : t("resolver.paused")}</span>
    <button class="btn ghost" style="padding:4px 10px" onclick={() => resolver.reopen()}>{t("resolver.details")}</button>
    <button class="btn ghost" style="padding:4px 10px" disabled={resolver.busy} onclick={() => resolver.abort()}
      >{#if resolver.activeAction === "abort"}<span class="spinner"></span>{:else}{t("resolver.abort_short")}{/if}</button
    >
    <button
      class="btn"
      style="padding:4px 10px;background:var(--accent2);border-color:var(--accent2)"
      disabled={resolver.busy}
      onclick={() => resolver.continue()}
      >{#if resolver.activeAction === "continue"}<span class="spinner"></span>{:else}{t("resolver.continue_rebase")}{/if}</button
    >
  </div>
{/if}

{#snippet col(cls: string, title: string, txt: string, lang: string)}
  <div class="tw-col {cls}">
    <h6>{title}</h6>
    {#each lines(txt) as line}
      <div class="ln"><code>{@html bridge.highlight(line, lang)}</code></div>
    {:else}
      <div class="ln"><span class="mut">{t("resolver.col_empty")}</span></div>
    {/each}
  </div>
{/snippet}
