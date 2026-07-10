<script lang="ts">
  import { workdirCtrl, canBlameWorkdirFile, blameTargetForWorkdirFile } from "./workdir.svelte.ts";
  import * as bridge from "../../legacy/bridge";
  import { blameCtrl } from "../blame/blame.svelte.ts";

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
                title="Blame"
                aria-label="Blame {f.path}"
                disabled={workdirCtrl.busy || !canBlameWorkdirFile(f)}
                onclick={(e) => {
                  e.stopPropagation();
                  blameCtrl.openFor(repo(), null, blameTargetForWorkdirFile(f), null);
                }}>&#128065;</button
              >
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
                title="Blame"
                aria-label="Blame {f.path}"
                disabled={workdirCtrl.busy || !canBlameWorkdirFile(f)}
                onclick={(e) => {
                  e.stopPropagation();
                  blameCtrl.openFor(repo(), null, blameTargetForWorkdirFile(f), null);
                }}>&#128065;</button
              >
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
    {@const file = workdirCtrl.selectedDiffFile}
    <section>
      <div class="wd-sec-head">
        <h4 class="d-lab" style="margin:0">Diff</h4>
        {#if workdirCtrl.selectedLinesCount}
          <div class="wd-lines-bar">
            <span class="mut" style="font-size:11.5px">{workdirCtrl.selectedLinesCount} line{workdirCtrl.selectedLinesCount === 1 ? "" : "s"} selected</span>
            {#if workdirCtrl.busy && workdirCtrl.busyTarget === file}
              <span class="spinner"></span>
            {:else if !workdirCtrl.selectedDiffStaged}
              <button disabled={workdirCtrl.busy} onclick={() => workdirCtrl.stageLines(repo(), file, workdirCtrl.buildSelectedHunks())}>Stage selected</button>
              <button class="danger" disabled={workdirCtrl.busy} onclick={() => workdirCtrl.confirmDiscardLines(file, workdirCtrl.buildSelectedHunks())}>Discard selected</button>
            {:else}
              <button disabled={workdirCtrl.busy} onclick={() => workdirCtrl.unstageLines(repo(), file, workdirCtrl.buildSelectedHunks())}>Unstage selected</button>
            {/if}
          </div>
        {/if}
      </div>
      <div class="diffview">
        {#if workdirCtrl.diffLoading}
          <div class="diff-file-h mut"><span class="spinner"></span> loading diff&#8230;</div>
        {:else if workdirCtrl.diffError}
          <div class="diff-file-h">{workdirCtrl.diffHeader}</div>
          <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut">{workdirCtrl.diffError}</code></div>
        {:else if workdirCtrl.diffFile}
          <div class="diff-file-h">{workdirCtrl.diffHeader}</div>
          {#if workdirCtrl.diffFile.binary}
            <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut">binary file — not shown</code></div>
          {:else if !workdirCtrl.diffHunks.length}
            <div class="diff-line"><span class="ln"></span><span class="mk"></span><code class="mut">no textual diff</code></div>
          {:else}
            {#each workdirCtrl.diffHunks as hunk (hunk.header)}
              <div class="diff-line hunk">
                <span class="ln"></span><span class="sel"></span><span class="mk"></span><code>{hunk.header}</code>
                <span class="wd-hunk-act">
                  {#if workdirCtrl.busy && workdirCtrl.busyTarget === file}
                    <span class="spinner"></span>
                  {:else if !workdirCtrl.selectedDiffStaged}
                    <button disabled={workdirCtrl.busy} onclick={() => workdirCtrl.stageLines(repo(), file, [workdirCtrl.hunkSelectionFor(hunk)])}>Stage hunk</button>
                    <button class="danger" disabled={workdirCtrl.busy} onclick={() => workdirCtrl.confirmDiscardLines(file, [workdirCtrl.hunkSelectionFor(hunk)])}>Discard hunk</button>
                  {:else}
                    <button disabled={workdirCtrl.busy} onclick={() => workdirCtrl.unstageLines(repo(), file, [workdirCtrl.hunkSelectionFor(hunk)])}>Unstage hunk</button>
                  {/if}
                </span>
              </div>
              {#each hunk.lines as line, idx (line.kind + ":" + line.oldNo + ":" + line.newNo)}
                <div
                  class="diff-line {line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : ''}"
                  class:selected={workdirCtrl.isLineSelected(hunk.header, line)}
                >
                  <span class="ln">{line.kind === "+" ? line.newNo : line.kind === "-" ? line.oldNo : (line.newNo ?? line.oldNo)}</span>
                  <span class="sel">
                    {#if line.kind === "+" || line.kind === "-"}
                      <input
                        type="checkbox"
                        checked={workdirCtrl.isLineSelected(hunk.header, line)}
                        disabled={workdirCtrl.busy}
                        onclick={(e) => {
                          e.stopPropagation();
                          workdirCtrl.toggleLine(hunk.header, hunk.lines, idx, e.shiftKey);
                        }}
                        aria-label="select {line.kind === '+' ? 'added' : 'removed'} line {line.kind === '+' ? line.newNo : line.oldNo}"
                      />
                    {/if}
                  </span>
                  <span class="mk">{line.kind === "+" || line.kind === "-" ? line.kind : ""}</span>
                  <code>{@html line.html}</code>
                </div>
              {/each}
            {/each}
            {#if workdirCtrl.diffFile.truncated}
              <div class="diff-line"><span class="ln"></span><span class="sel"></span><span class="mk"></span><code class="mut">&#8230; diff truncated (file capped)</code></div>
            {/if}
          {/if}
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
