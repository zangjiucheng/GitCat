// Backend (app-authored) error/status strings for the plugin system (PER-82):
// the on-disk registry (plugin_registry.rs), the command/hook executor
// (plugin_exec.rs), and the embedded Luau runtime (plugin_lua.rs). Keys become
// `err_plugins.<key>` and are looked up by `be()` (see src/i18n/i18n.svelte.ts)
// from the Rust `ierr`/`ierrp` machinery. English is the SOURCE OF TRUTH.
export default {
  // plugin_registry.rs — persistence (plugins.json)
  could_not_resolve_config_dir: "Could not resolve app config dir: {detail}",
  could_not_create_config_dir: "Could not create app config dir: {detail}",
  could_not_read: "Could not read {path}: {detail}",
  could_not_serialize: "Could not serialize: {detail}",
  could_not_write: "Could not write {path}: {detail}",
  could_not_finalize: "Could not finalize {path}: {detail}",

  // plugin_registry.rs — manifest validation
  plugin_id_invalid:
    "Plugin id {id} is invalid — it must start with a lowercase letter or digit and then contain only lowercase letters, digits, and '-'.",
  missing_name: "Plugin manifest is missing a non-empty name.",
  missing_version: "Plugin manifest is missing a non-empty version.",
  needs_newer_gitcat: "This plugin needs GitCat {required} or newer — this copy is {host}. Update GitCat, then install it again.",
  min_version_invalid:
    "Plugin manifest has an unreadable minGitcatVersion {value} — it must look like \"1.3.0\".",
  cmd_exactly_one_both:
    "Plugin command {id} must declare exactly one of a non-empty `run` (shell) or a non-empty `handler` (Luau) — it declares both.",
  cmd_exactly_one_neither:
    "Plugin command {id} must declare exactly one of a non-empty `run` (shell) or a non-empty `handler` (Luau) — it declares neither.",
  cmd_handler_no_lua:
    "Plugin command {id} declares a Luau `handler` but the plugin declares no `lua` script file.",
  hook_exactly_one_both:
    "Plugin hook for event {event} must declare exactly one of a non-empty `run` (shell) or a non-empty `handler` (Luau) — it declares both.",
  hook_exactly_one_neither:
    "Plugin hook for event {event} must declare exactly one of a non-empty `run` (shell) or a non-empty `handler` (Luau) — it declares neither.",
  hook_handler_no_lua:
    "Plugin hook for event {event} declares a Luau `handler` but the plugin declares no `lua` script file.",
  tama_voice_pitch_not_finite:
    "Plugin tama voicePitch {pitch} is not a finite number — it must be a finite value (a finite out-of-range value is clamped to [{min}, {max}]).",
  tama_pose_key_unknown: "Plugin tama pose key {key} is not a built-in pose — it must be one of {keys}.",
  tama_pose_unsafe_path:
    "Plugin tama pose {key} has an unsafe asset path {path} — it must be a relative path inside the plugin dir (no leading '/' and no '..').",
  panel_id_invalid:
    "Plugin panel id {id} is invalid — it must start with a lowercase letter or digit and then contain only lowercase letters, digits, and '-'.",
  panel_id_duplicate: "Plugin has a duplicate panel id {id} — panel ids must be unique within a plugin.",
  panel_missing_title: "Plugin panel {id} is missing a non-empty title.",
  panel_text_empty: "Plugin panel {id} has a text item with empty text.",
  panel_heading_empty: "Plugin panel {id} has a heading item with empty text.",
  panel_button_empty_label: "Plugin panel {id} has a button with an empty label.",
  panel_button_missing_command:
    "Plugin panel {id} has a button referencing command {command}, which is not a command in this plugin.",
  panel_command_output_empty_label: "Plugin panel {id} has a command-output item with an empty label.",
  panel_command_output_missing_command:
    "Plugin panel {id} has a command-output referencing command {command}, which is not a command in this plugin.",

  // plugin_registry.rs — manifest reading (size caps, parse)
  manifest_not_regular_file: "Plugin manifest {path} is not a regular file.",
  manifest_too_large: "Plugin manifest {path} is too large ({bytes} bytes; the limit is {limit} bytes).",
  manifest_too_large_limit: "Plugin manifest {path} is too large (limit {limit} bytes).",
  manifest_invalid: "{path} is not a valid plugin manifest: {detail}",

  // plugin_registry.rs — install / enable / remove / skin lookup
  already_installed: "A plugin with id {id} is already installed.",
  no_plugin_with_id: "No plugin with id {id} is installed.",
  plugin_disabled: "Plugin {id} is disabled.",

  // plugin_registry.rs — Luau script loading (read_plugin_lua)
  lua_no_source_dir: "Plugin has no resolvable source directory for its Luau script.",
  lua_no_script_file: "Plugin declares no `lua` script file.",
  lua_unsafe_path:
    "Plugin `lua` path {path} is unsafe — it must be a relative path inside the plugin dir (no leading '/' and no '..').",
  lua_not_lua_extension: "Plugin `lua` path {path} must name a `.lua` file.",
  lua_cannot_resolve_dir: "Cannot resolve plugin source dir {dir}: {detail}",
  lua_cannot_read: "Cannot read plugin Luau script {path}: {detail}",
  lua_escapes_dir: "Plugin Luau script {path} escapes the plugin directory — refusing to load it.",
  lua_not_regular_file: "Plugin Luau script {path} is not a regular file.",
  lua_too_large: "Plugin Luau script {path} is too large ({bytes} bytes; the limit is {limit} bytes).",
  lua_too_large_limit: "Plugin Luau script {path} is too large (limit {limit} bytes).",

  // plugin_exec.rs — command/hook executor
  could_not_open_repo_snapshot:
    "could not open the repository to snapshot before a mutating plugin action: {detail}",
  windows_cmd_unsafe_value:
    "Refusing to run the plugin command on Windows: the {tok} value contains a character unsafe for cmd.exe (one of & | < > ^ % ! \" or a newline). This is a known Windows limitation of GitCat's plugin executor.",
  could_not_run_command: "Could not run the plugin command: {detail}",
  command_not_found: "Plugin command {plugin_id}/{command_id} was not found or is disabled.",
  no_repo_for_command: "No repository path was provided for the plugin command.",
  no_repo_for_hooks: "No repository path was provided for plugin hooks.",

  // plugin_lua.rs — embedded Luau runtime
  lua_vm_create: "could not create the sandboxed Lua VM: {detail}",
  lua_memory_limit: "could not apply the Lua memory limit: {detail}",
  lua_harden_globals: "could not harden the Lua globals: {detail}",
  lua_enable_sandbox: "could not enable the Lua sandbox: {detail}",
  lua_install_host_api: "could not install the plugin host API: {detail}",
  lua_script_error: "plugin script error: {detail}",
  lua_module_not_table:
    "the plugin's main Lua file must `return` a table of handler functions, but it returned a {type}",
  lua_handler_not_found: "the plugin handler '{handler}' was not found in the table its main file returned",
  lua_handler_not_function: "the plugin handler '{handler}' is a {type}, not a function",
  lua_handler_error: "plugin handler error: {detail}",
};
