// Backend (app-authored) error/status strings for opening & registering repos,
// reading repo-root files, the repo summary, the graph load, and the `gitcat`
// CLI install (PER-82). Keys become `err_repo.<key>` and are resolved by `be()`
// (see src/i18n/i18n.svelte.ts) from the `i18n:err_repo.<key>` strings the Rust
// side returns via `ierr`/`ierrp`. English is the SOURCE OF TRUTH.
export default {
  // Shared across repo_files.rs / repo_summary.rs / commands.rs (graph load)
  cannot_open_repo: "cannot open repository: {detail}",
  // identity.rs (set_git_identity)
  cannot_open_repo_cap: "Cannot open repository: {detail}",
  // identity.rs (get_git_identity — doubles as the setup wizard's dir check)
  not_a_git_repository: "That doesn't look like a git repository — {detail}",
  name_and_email_required: "Name and email must not be empty.",
  set_identity_success: "Set identity for this repository: {name} <{email}>.",

  // Shared git-runner fallbacks (identity.rs / repo_summary.rs). The detail
  // travels verbatim (git's own exit code / debug of an Option), not localized.
  git_exited_with_status: "git exited with status {code}",
  could_not_run_git: "Could not run git: {detail}",

  // repo_registry.rs — tracked-repos JSON persistence
  could_not_resolve_config_dir: "Could not resolve app config dir: {detail}",
  could_not_create_config_dir: "Could not create app config dir: {detail}",
  could_not_read: "Could not read {path}: {detail}",
  could_not_serialize: "Could not serialize: {detail}",
  could_not_write: "Could not write {path}: {detail}",
  could_not_finalize: "Could not finalize {path}: {detail}",

  // repo_files.rs — .gitignore/.mailmap editors
  not_editable_repo_file: "Not an editable repo file: {name} (only .gitignore and .mailmap are supported).",
  no_working_tree: "This repository has no working tree.",
  file_is_symlink: "{name} is a symlink — refusing to read or write through it for safety.",
  saved_file: "Saved {name}.",

  // cli_shim.rs — installing the `gitcat` command into PATH
  cli_unsupported_platform: "Installing the gitcat command from the app isn't supported on this platform yet.",
  couldnt_find_own_program: "Couldn't find GitCat's own program file: {detail}",
  cli_macos_needs_bundle:
    "This only works from an installed GitCat.app. It looks like you're running an unbundled build (for example `cargo tauri dev`).",
  install_path_not_utf8: "GitCat's install path isn't valid UTF-8.",
  couldnt_write: "Couldn't write {path}: {detail}",
  couldnt_create: "Couldn't create {path}: {detail}",
  couldnt_stage_launcher: "Couldn't stage the launcher: {detail}",
  temp_path_not_utf8: "Temp path isn't valid UTF-8.",
  couldnt_run_admin_helper: "Couldn't run the admin helper (osascript): {detail}",
  installation_cancelled: "Installation was cancelled.",
  couldnt_install_with_admin: "Couldn't install with administrator privileges: {detail}",
  couldnt_find_home: "Couldn't find your home directory ($HOME).",
  couldnt_find_localappdata: "Couldn't find %LOCALAPPDATA%.",
};
