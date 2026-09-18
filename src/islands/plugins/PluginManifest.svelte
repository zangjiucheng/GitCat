<!--
  What a plugin actually runs — the shared rendering behind both the
  install-time review (#69) and the audit view for an installed plugin (#70).

  One component, two callers, by design: the whole point of showing this is that
  the user can compare what they agreed to at install time with what is on their
  machine now, and two renderings that drift make that comparison a lie.

  docs/plugins.md states the trust model plainly — there is no sandbox for a
  shell `run`, so "a plugin can do anything the command you wrote can do". The
  Plugins panel showed COUNTS ("3 commands"), which is not what that model asks
  the user to judge. This shows the command lines.

  Styles are scoped here, not added to the panel: Svelte's scoped CSS does not
  cross component boundaries, so rules living in Plugins.svelte would simply not
  apply to this markup. The few shared classes it does use (.d-lab, .mut, .mono)
  are global.
-->
<script lang="ts">
  import type { Plugin } from "@/ipc/bindings";
  import { t } from "@/i18n/i18n.svelte.ts";

  let { plugin }: { plugin: Plugin } = $props();

  const commands = $derived(plugin.commands ?? []);
  const hooks = $derived(plugin.hooks ?? []);
  const panels = $derived(plugin.panels ?? []);

  // A command or hook declares EXACTLY ONE of `run` (a shell template) or
  // `handler` (a Luau function in the plugin's own .lua). validate_manifest
  // enforces that at install, so this is a display choice, not a guess.
  function body(x: { run?: string | null; handler?: string | null }) {
    const run = x.run?.trim();
    if (run) return { kind: "shell" as const, text: run };
    const h = x.handler?.trim();
    if (h) return { kind: "handler" as const, text: h };
    return null;
  }

  const anything = $derived(
    commands.length > 0 || hooks.length > 0 || panels.length > 0 || !!plugin.lua || !!plugin.tama,
  );
  // Anything that writes to the repo, gathered up front: it is the single most
  // important thing on this surface and should not have to be hunted for.
  const mutatingCount = $derived(
    commands.filter((c) => c.mutates).length + hooks.filter((h) => h.mutates).length,
  );
</script>

{#if mutatingCount > 0}
  <div class="pm-warn">
    {mutatingCount === 1
      ? t("plugins.audit_mutates_one")
      : t("plugins.audit_mutates_other", { n: mutatingCount })}
  </div>
{/if}

{#if commands.length}
  <div class="d-lab pm-lab">{t("plugins.audit_commands")}</div>
  {#each commands as c (c.id)}
    {@const b = body(c)}
    <div class="pm-item" class:mutates={c.mutates}>
      <div class="pm-item-head">
        <span class="pm-name">{c.label}</span>
        {#if c.mutates}<span class="pm-badge">{t("plugins.audit_mutates_badge")}</span>{/if}
        <span class="mut pm-meta">{c.placement ?? "palette"} &middot; {c.context ?? "none"}</span>
      </div>
      {#if b}
        <!-- The command line itself, verbatim. Placeholders are left unexpanded:
             this is what the manifest says, not what one invocation would
             become — {repo}/{sha} are resolved per run. -->
        <code class="pm-run">{b.kind === "handler" ? t("plugins.audit_handler", { name: b.text }) : b.text}</code>
      {/if}
    </div>
  {/each}
{/if}

{#if hooks.length}
  <!-- Hooks matter more than commands and are listed second only because there
       are usually fewer: a command waits to be chosen, a hook runs on its own
       whenever its event fires. -->
  <div class="d-lab pm-lab">{t("plugins.audit_hooks")}</div>
  {#each hooks as h, i (h.event + i)}
    {@const b = body(h)}
    <div class="pm-item" class:mutates={h.mutates}>
      <div class="pm-item-head">
        <span class="pm-name">{t("plugins.audit_on_event", { event: h.event })}</span>
        {#if h.mutates}<span class="pm-badge">{t("plugins.audit_mutates_badge")}</span>{/if}
      </div>
      {#if b}
        <code class="pm-run">{b.kind === "handler" ? t("plugins.audit_handler", { name: b.text }) : b.text}</code>
      {/if}
    </div>
  {/each}
{/if}

{#if panels.length}
  <div class="d-lab pm-lab">{t("plugins.audit_panels")}</div>
  {#each panels as p (p.id)}
    <div class="pm-item">
      <div class="pm-item-head">
        <span class="pm-name">{p.title}</span>
        <span class="mut pm-meta">{t("plugins.audit_panel_items", { n: (p.items ?? []).length })}</span>
      </div>
    </div>
  {/each}
{/if}

{#if plugin.lua || plugin.tama || plugin.dir}
  <div class="d-lab pm-lab">{t("plugins.audit_files")}</div>
  <div class="pm-files">
    {#if plugin.lua}<div><span class="mut">{t("plugins.audit_lua")}</span> <code class="mono">{plugin.lua}</code></div>{/if}
    {#if plugin.tama}<div><span class="mut">{t("plugins.audit_tama")}</span></div>{/if}
    {#if plugin.dir}
      <!-- Where it all resolves from. Everything above is read relative to this,
           so it is part of what is being trusted. -->
      <div><span class="mut">{t("plugins.audit_dir")}</span> <code class="mono pm-dir">{plugin.dir}</code></div>
    {/if}
  </div>
{/if}

{#if !anything}
  <div class="mut pm-lab">{t("plugins.contrib_nothing")}</div>
{/if}

<style>
  .pm-lab {
    margin-top: 14px;
  }
  /* The sentence the whole feature exists to make true. */
  .pm-trust {
    font-size: 11.5px;
    line-height: 1.5;
    padding: 8px 10px;
    margin: 10px 0 2px;
    border-radius: var(--r-panel);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .pm-warn {
    font-size: 11.5px;
    line-height: 1.5;
    padding: 8px 10px;
    margin: 10px 0 2px;
    border-radius: var(--r-panel);
    background: color-mix(in srgb, var(--warning) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--warning) 40%, transparent);
  }
  .pm-item {
    padding: 7px 0;
    border-bottom: 1px solid var(--border);
  }
  .pm-item:last-child {
    border-bottom: none;
  }
  .pm-item-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .pm-name {
    font-size: 12.5px;
    font-weight: 600;
  }
  .pm-meta {
    font-size: 10.5px;
    margin-left: auto;
  }
  /* The one thing on this surface that must not be skimmed past, so it gets a
     badge AND a rule down the side of the item. */
  .pm-badge {
    font-size: 9.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 1px 6px;
    border-radius: var(--r-pill);
    background: color-mix(in srgb, var(--warning) 22%, transparent);
    color: var(--warning);
  }
  .pm-item.mutates {
    border-left: 2px solid color-mix(in srgb, var(--warning) 55%, transparent);
    padding-left: 8px;
    margin-left: -10px;
  }
  /* The command line, verbatim. pre-wrap + break-word because a real `run` is
     long, and an elided command is exactly the part a reader needs. */
  .pm-run {
    display: block;
    margin-top: 4px;
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.5;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r-panel);
    padding: 6px 8px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .pm-files {
    font-size: 11.5px;
    line-height: 1.7;
  }
  .pm-files code {
    font-size: 10.5px;
  }
  .pm-dir {
    word-break: break-all;
  }
</style>
