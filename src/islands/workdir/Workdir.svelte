<script lang="ts">
  import { workdirCtrl } from "./workdir.svelte.ts";
  import * as bridge from "../../legacy/bridge";

  const STATUS_LABEL: Record<string, string> = { A: "A", M: "M", D: "D", R: "R", T: "T", "?": "U" };

  function repo(): string {
    return bridge.CUR_REPO as unknown as string;
  }
</script>

{#if workdirCtrl.selected}
  <section>
    <div class="d-subject">Uncommitted changes</div>
    <div class="d-body" style="margin-top:2px">
      {#if workdirCtrl.status?.branch}
        on <b class="mono">{workdirCtrl.status.branch}</b>
      {:else}
        detached HEAD
      {/if}
    </div>
    <div class="id-strip">
      {#if workdirCtrl.status}
        {@const s = workdirCtrl.status}
        {#if s.conflicted}
          <span class="gpg bad">{s.conflicted} conflicted</span>
        {:else if s.staged.length || s.unstaged.length}
          <span class="hash">{s.staged.length} staged &#183; {s.unstaged.length} unstaged</span>
        {:else}
          <span class="gpg good">&#10003; clean</span>
        {/if}
      {/if}
      {#if workdirCtrl.loading}<span class="spinner"></span>{/if}
    </div>
    {#if workdirCtrl.status?.conflicted}
      <div class="pl-err" style="margin-top:10px">
        {workdirCtrl.status.conflicted} file{workdirCtrl.status.conflicted === 1 ? "" : "s"} conflicted (a stash apply/pop hit a conflict) — resolve it in the Conflict Resolver.
      </div>
    {/if}
  </section>

  <section>
    <h4 class="d-lab">Commit</h4>
    <textarea
      class="wd-msg"
      rows="3"
      placeholder={workdirCtrl.amend ? "Leave empty to keep the previous message…" : "Commit message…"}
      bind:value={workdirCtrl.message}
      disabled={workdirCtrl.busy && workdirCtrl.busyTarget === "__commit__"}
    ></textarea>
    <div class="wd-commit-row">
      <label class="wd-amend"
        ><input type="checkbox" bind:checked={workdirCtrl.amend} disabled={workdirCtrl.busy && workdirCtrl.busyTarget === "__commit__"} /> Amend previous commit</label
      >
      <button
        class="btn"
        disabled={(workdirCtrl.busy && workdirCtrl.busyTarget === "__commit__") || (!workdirCtrl.amend && !workdirCtrl.message.trim())}
        onclick={() => workdirCtrl.commit(repo())}
      >
        {#if workdirCtrl.busy && workdirCtrl.busyTarget === "__commit__"}<span class="spinner"></span>{/if}
        {workdirCtrl.amend ? "Amend" : "Commit"}
      </button>
    </div>
  </section>

  <section>
    <div class="wd-sec-head">
      <h4 class="d-lab" style="margin:0">Staged ({workdirCtrl.status?.staged.length ?? 0})</h4>
    </div>
    {#if !workdirCtrl.status?.staged.length}
      <div class="mut" style="font-size:12px">nothing staged</div>
    {:else}
      <div class="wd-files">
        {#each workdirCtrl.status.staged as f (f.path)}
          <div
            class="wd-file"
            class:active={workdirCtrl.selectedDiffFile === f.path && workdirCtrl.selectedDiffStaged}
            role="button"
            tabindex="0"
            onclick={() => workdirCtrl.selectDiffFile(f.path, true)}
            onkeydown={(e) => (e.key === "Enter" || e.key === " ") && workdirCtrl.selectDiffFile(f.path, true)}
          >
            <span class="st" data-status={f.status}>{STATUS_LABEL[f.status] ?? f.status}</span>
            <span class="wd-path" title={f.path}>{f.oldPath ? f.oldPath + " → " + f.path : f.path}</span>
            {#if workdirCtrl.busyTarget === f.path}
              <span class="spinner"></span>
            {:else}
              <button
                class="wd-act"
                title="Unstage"
                aria-label="Unstage {f.path}"
                disabled={workdirCtrl.busy}
                onclick={(e) => {
                  e.stopPropagation();
                  workdirCtrl.unstageFile(repo(), f.path);
                }}>&#8722;</button
              >
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <section>
    <div class="wd-sec-head">
      <h4 class="d-lab" style="margin:0">Unstaged ({workdirCtrl.status?.unstaged.length ?? 0})</h4>
      {#if workdirCtrl.status?.unstaged.length}
        <button class="wd-stage-all" disabled={workdirCtrl.busy} onclick={() => workdirCtrl.stageAll(repo())}>
          {#if workdirCtrl.busy && workdirCtrl.busyTarget === "__all__"}<span class="spinner"></span>{:else}Stage all{/if}
        </button>
      {/if}
    </div>
    {#if !workdirCtrl.status?.unstaged.length}
      <div class="mut" style="font-size:12px">no unstaged changes</div>
    {:else}
      <div class="wd-files">
        {#each workdirCtrl.status.unstaged as f (f.path)}
          <div
            class="wd-file"
            class:active={workdirCtrl.selectedDiffFile === f.path && !workdirCtrl.selectedDiffStaged}
            role="button"
            tabindex="0"
            onclick={() => workdirCtrl.selectDiffFile(f.path, false)}
            onkeydown={(e) => (e.key === "Enter" || e.key === " ") && workdirCtrl.selectDiffFile(f.path, false)}
          >
            <span class="st" data-status={f.status}>{STATUS_LABEL[f.status] ?? f.status}</span>
            <span class="wd-path" title={f.path}>{f.oldPath ? f.oldPath + " → " + f.path : f.path}</span>
            {#if workdirCtrl.busyTarget === f.path}
              <span class="spinner"></span>
            {:else}
              <button
                class="wd-act"
                title="Stage"
                aria-label="Stage {f.path}"
                disabled={workdirCtrl.busy}
                onclick={(e) => {
                  e.stopPropagation();
                  workdirCtrl.stageFile(repo(), f.path);
                }}>&#43;</button
              >
              <button
                class="wd-act danger"
                title="Discard"
                aria-label="Discard changes to {f.path}"
                disabled={workdirCtrl.busy}
                onclick={(e) => {
                  e.stopPropagation();
                  workdirCtrl.confirmDiscard(f.path, f.status === "?");
                }}>&#128465;</button
              >
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </section>

  {#if workdirCtrl.selectedDiffFile}
    <section>
      <h4 class="d-lab">Diff</h4>
      <div class="diffview">
        {#if workdirCtrl.diffLoading}
          <div class="diff-file-h mut"><span class="spinner"></span> loading diff&#8230;</div>
        {:else}
          <div class="diff-file-h">{workdirCtrl.diffHeader}</div>
          {#each workdirCtrl.diffRows as row}
            {#if row.kind === "hunk"}
              <div class="diff-line hunk"><span class="ln"></span><span class="mk"></span><code>{row.text}</code></div>
            {:else if row.kind === "note"}
              <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut">{row.text}</code></div>
            {:else}
              <div class="diff-line {row.cls}"><span class="ln">{row.ln}</span><span class="mk">{row.mk}</span><code>{@html row.html}</code></div>
            {/if}
          {/each}
        {/if}
      </div>
    </section>
  {/if}

  <section>
    <div class="wd-sec-head">
      <h4 class="d-lab" style="margin:0">Stash</h4>
    </div>
    {#if !workdirCtrl.stashes.length}
      <div class="mut" style="font-size:12px">no stashes</div>
    {:else}
      <div class="wd-stash-list">
        {#each workdirCtrl.stashes as s (s.index)}
          <div class="wd-stash-item">
            <span class="dot" style="background:var(--accent2)"></span>
            <div class="wd-stash-main">
              <span class="wd-stash-msg">{s.message || "(no message)"}</span>
              <span class="wd-stash-meta mut mono">stash@{"{" + s.index + "}"} &#183; {s.sha}{s.branch ? " · " + s.branch : ""}</span>
            </div>
            {#if workdirCtrl.stashBusy && workdirCtrl.stashBusyTarget === s.index}
              <span class="spinner"></span>
            {:else}
              <div class="wd-stash-act">
                <button title="Apply (keep the stash entry)" disabled={workdirCtrl.stashBusy} onclick={() => workdirCtrl.applyStash(repo(), s.index)}>Apply</button>
                <button title="Pop (apply, then drop on success)" disabled={workdirCtrl.stashBusy} onclick={() => workdirCtrl.popStash(repo(), s.index)}>Pop</button>
                <button
                  class="danger"
                  title="Drop"
                  disabled={workdirCtrl.stashBusy}
                  onclick={() => workdirCtrl.confirmDropStash(repo(), s.index)}>&#128465;</button
                >
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if workdirCtrl.stashOpen}
      <div class="wd-stash-form" class:busy={workdirCtrl.busy && workdirCtrl.busyTarget === "__stash__"}>
        <input
          placeholder="stash message (optional)…"
          spellcheck="false"
          autocomplete="off"
          bind:value={workdirCtrl.stashMessage}
          disabled={workdirCtrl.busy && workdirCtrl.busyTarget === "__stash__"}
          onkeydown={(e) => e.key === "Enter" && workdirCtrl.saveStash(repo())}
        />
        <div class="nb-row">
          <label class="wd-amend"
            ><input
              type="checkbox"
              bind:checked={workdirCtrl.stashIncludeUntracked}
              disabled={workdirCtrl.busy && workdirCtrl.busyTarget === "__stash__"}
            /> include untracked</label
          >
          {#if workdirCtrl.busy && workdirCtrl.busyTarget === "__stash__"}
            <span class="spinner"></span>
          {:else}
            <button class="btn ghost" style="padding:4px 10px" onclick={() => workdirCtrl.cancelStashForm()}>Cancel</button>
            <button class="btn" style="padding:4px 10px" onclick={() => workdirCtrl.saveStash(repo())}>Save</button>
          {/if}
        </div>
      </div>
    {:else}
      <button class="wd-stash-new" onclick={() => workdirCtrl.openStashForm()}>&#65291; Stash changes&#8230;</button>
    {/if}
  </section>
{/if}
