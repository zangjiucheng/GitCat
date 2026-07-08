<script lang="ts">
  import { resolver } from "./resolver.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import { IN_TAURI } from "../../ipc/env";

  // ext -> highlight grammar key (was langForConflict)
  function langFor(path: string): string {
    const ext = (path || "").split(".").pop()!.toLowerCase();
    return ["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext) ? "ts" : "generic";
  }
  const lines = (txt: string) => (txt || "").split("\n");

  // Abort button copy — op-flavored ("Abort merge"/"Abort pick"/"Abort rebase").
  function abortLabel(op: string): string {
    if (op === "merge") return "Abort merge";
    if (op === "rebase") return "Abort rebase";
    return "Abort pick";
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
      <div class="cf-layout">
        <div class="cf-files">
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
          <div class="cf-actions">
            <span class="cf-cur">{resolver.current?.path ?? ""}</span>
            <span class="cf-take">
              <button class="btn" disabled={!resolver.currentLive || resolver.busy} onclick={() => resolver.take("ours")}
                >{#if resolver.activeAction === "ours"}<span class="spinner"></span> Taking…{:else}Take ours{/if}</button
              ><button class="btn" disabled={!resolver.currentLive || resolver.busy} onclick={() => resolver.take("theirs")}
                >{#if resolver.activeAction === "theirs"}<span class="spinner"></span> Taking…{:else}Take theirs{/if}</button
              >
            </span>
          </div>
          <div class="three-way" id="cfThree">
            {#if resolver.current}
              {@const lang = langFor(resolver.current.path)}
              {@render col("ours", "Ours (HEAD)", resolver.current.ours, lang)}
              {@render col("", "Base", resolver.current.base, lang)}
              {@render col("theirs", "Theirs (picked)", resolver.current.theirs, lang)}
            {:else}
              <div class="tw-col" style="grid-column:1/4;padding:14px">
                <span class="mut">All files resolved — press Continue &amp; commit.</span>
              </div>
            {/if}
          </div>
        </div>
      </div>
      <div class="backup-note" style="margin-top:12px">
        &#128257; Snapshot before {resolver.op}: <code>{resolver.backupRef}</code> &#183; rerere may auto-apply a recorded resolution.
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" id="conflictAbort" disabled={resolver.busy} onclick={() => resolver.abort()}
        >{#if resolver.activeAction === "abort"}<span class="spinner"></span> Aborting…{:else}{abortLabel(resolver.op)}{/if}</button
      >
      {#if resolver.op === "rebase"}
        <button class="btn ghost" id="conflictSkip" disabled={resolver.busy} onclick={() => resolver.skip()}
          >{#if resolver.activeAction === "skip"}<span class="spinner"></span> Skipping…{:else}Skip this commit{/if}</button
        >
      {/if}
      <span class="cf-remain mut"
        >{resolver.remainingCount
          ? resolver.remainingCount + " file" + (resolver.remainingCount === 1 ? "" : "s") + " left"
          : "all resolved"}</span
      >
      <button
        class="btn"
        style="background:var(--accent2);border-color:var(--accent2)"
        disabled={resolver.remainingCount > 0 || resolver.busy}
        onclick={() => resolver.continue()}
        >{#if resolver.activeAction === "continue"}<span class="spinner"></span> Committing…{:else}Continue &amp; commit{/if}</button
      >
    </div>
  </div>
</div>

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
