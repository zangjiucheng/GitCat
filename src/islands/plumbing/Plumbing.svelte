<script lang="ts">
  import { plumbing } from "./plumbing.svelte.ts";
  import * as bridge from "../../legacy/bridge";

  let revInput = $state("");

  async function doInspect() {
    // Read bridge.CUR_REPO via property access at call time (never destructure
    // it into a local const) — it's a live re-export of a plain mutable `let`
    // in legacy/main.ts, so this is the only way to see the current value.
    await plumbing.inspect((bridge as any).CUR_REPO ?? null, revInput);
  }

  function onSubmit(e: Event) {
    e.preventDefault();
    void doInspect();
  }

  function fmtTime(t: number): string {
    try {
      return new Date(t * 1000).toLocaleString();
    } catch {
      return String(t);
    }
  }

  function fmtBytes(n: number): string {
    if (n < 1024) return n + " B";
    const kb = n / 1024;
    if (kb < 1024) return kb.toFixed(1) + " KB";
    return (kb / 1024).toFixed(1) + " MB";
  }

  // Tree entries: a short, non-diff-status letter so we don't borrow the
  // `.st.M/.A/.D` colour semantics (those mean modified/added/deleted, which
  // would mislabel a plain directory or submodule entry).
  function kindLetter(k: string): string {
    if (k === "tree") return "D";
    if (k === "commit") return "S";
    if (k === "tag") return "T";
    return "F";
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && plumbing.open) plumbing.close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="scrim" class:on={plumbing.open}>
  <div class="modal plumbing">
    <div class="modal-head">
      <div class="modal-tama"><img class="tama-pic" src={bridge.TAMA_IMG.curious} alt="Tama, curious" /></div>
      <div>
        <h3>Plumbing &#8212; inspect a raw object</h3>
        <p>Type a rev, sha, branch, or tag to see the raw commit, tree, blob, or tag object it resolves to.</p>
      </div>
    </div>
    <div class="modal-body">
      <div class="pl-wrap">
        <form class="pl-bar" onsubmit={onSubmit}>
    <input
      class="pl-input mono"
      type="text"
      placeholder="rev, sha, branch, tag… e.g. HEAD~2, HEAD:path/to/file, a1b2c3d"
      spellcheck="false"
      autocomplete="off"
      autocorrect="off"
      bind:value={revInput}
    />
    <button class="btn" type="submit" disabled={plumbing.busy}>
      {plumbing.busy ? "Inspecting…" : "Inspect"}
    </button>
  </form>

  {#if plumbing.error}
    <div class="pl-err">{plumbing.error}</div>
  {/if}

  {#if plumbing.result}
    {@const r = plumbing.result}
    <div class="pl-result">
      <div class="pl-head">
        <span class="row-chip" style="text-transform:uppercase">{r.kind}</span>
        <span class="hash mono">{r.sha}</span>
      </div>

      {#if r.kind === "commit"}
        <div class="who-split">
          <div class="who">
            <h4>Author</h4>
            <div class="nm">{r.author.name}</div>
            <div class="em">{r.author.email}</div>
            <div class="dt">{fmtTime(r.author.time)}</div>
          </div>
          <div class="who">
            <h4>Committer</h4>
            <div class="nm">{r.committer.name}</div>
            <div class="em">{r.committer.email}</div>
            <div class="dt">{fmtTime(r.committer.time)}</div>
          </div>
        </div>
        <div class="pl-kv">
          <div><span class="mut">tree</span> <span class="mono">{r.tree}</span></div>
          <div>
            <span class="mut">parents</span>
            {#if r.parents.length}
              {#each r.parents as p (p)}<span class="mono pl-parent">{p}</span>{/each}
            {:else}
              <span class="mut">(root commit — no parents)</span>
            {/if}
          </div>
        </div>
        <pre class="pl-msg">{r.message}</pre>
      {:else if r.kind === "tree"}
        <div class="tree pl-tree">
          {#each r.entries as e (e.oid + e.name)}
            <div class="file">
              <span class="st">{kindLetter(e.kind)}</span>
              <span>{e.name}</span>
              <span class="badge mono">{e.mode} · {e.kind} · {e.oid.slice(0, 10)}</span>
            </div>
          {:else}
            <div class="mut" style="padding:8px">empty tree</div>
          {/each}
        </div>
      {:else if r.kind === "blob"}
        <div class="pl-kv">
          <div><span class="mut">size</span> {fmtBytes(r.size)}</div>
          <div><span class="mut">binary</span> {r.isBinary ? "yes" : "no"}</div>
        </div>
        {#if r.isBinary}
          <div class="mut" style="padding:10px 0">Binary content not shown.</div>
        {:else}
          <pre class="pl-msg pl-blob">{r.content ?? ""}</pre>
          {#if r.truncated}<div class="mut" style="margin-top:4px">(truncated)</div>{/if}
        {/if}
      {:else if r.kind === "tag"}
        <div class="who-split single">
          <div class="who">
            <h4>Tagger</h4>
            {#if r.tagger}
              <div class="nm">{r.tagger.name}</div>
              <div class="em">{r.tagger.email}</div>
              <div class="dt">{fmtTime(r.tagger.time)}</div>
            {:else}
              <div class="mut">(no tagger recorded)</div>
            {/if}
          </div>
        </div>
        <div class="pl-kv">
          <div>
            <span class="mut">target</span>
            <span class="row-chip">{r.targetKind}</span>
            <span class="mono">{r.targetOid}</span>
          </div>
        </div>
        <pre class="pl-msg">{r.message}</pre>
      {/if}
    </div>
  {:else if !plumbing.error}
    <div class="mut pl-empty">
      Type a rev, sha, branch, or tag above and press Inspect to see the raw commit, tree, blob, or tag object it
      resolves to.
    </div>
  {/if}
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" onclick={() => plumbing.close()}>Close</button>
    </div>
  </div>
</div>
