// Backend (app-authored) error/status strings for the "misc" cluster of Rust
// modules (PER-82): git config, file history, the plumbing playground,
// fsck/dangling recovery, blame, WSL routing, the built-in terminal, the
// Safety Manager (undo / snapshots), the updater, reflog rescue, and rerere.
// Keys become `err_misc.<key>` and are looked up by `be()` (see
// src/i18n/i18n.svelte.ts) from the Rust `ierr`/`ierrp` machinery. English is
// the SOURCE OF TRUTH.
export default {
  // Shared repo-open failures (lowercase / capitalized variants, verbatim per
  // each call site's own wording).
  cannot_open_repo: "cannot open repository: {detail}",
  cannot_open_repo_cap: "Cannot open repository: {detail}",
  not_a_valid_commit: "Not a valid commit: {rev} ({detail})",
  could_not_run_git: "Could not run git: {detail}",
  git_exited_with_status: "git exited with status {code}",

  // file_history.rs
  path_does_not_exist: "{path} does not exist at {short}.",
  file_is_a_directory: "{path} is a directory at {short} — pick a file.",
  no_file_for_history: "No file to show history for.",
  path_nul: "Path has an embedded NUL byte.",

  // blame.rs
  file_is_binary_no_blame: "{path} is a binary file — blame is not available for binary content.",

  // plumbing.rs
  enter_rev_to_inspect: "Enter a rev, sha, or ref to inspect.",
  not_a_valid_rev: "Not a valid rev in this repository: {rev} ({detail})",
  resolved_not_a_tag: "Resolved object claims kind Tag but is not one.",
  unsupported_object_kind: "Unsupported object kind ({kind}) for {rev} — expected a commit, tree, blob, or tag.",

  // git_config.rs — validation
  config_key_empty: "Config key must not be empty.",
  config_key_malformed: '{key} doesn\'t look like a git config key (expected e.g. "section.key").',
  config_key_charset:
    "{key} contains characters a git config key can't have here — each dot-separated part may only use letters, digits, '-' and '_'.",
  value_looks_like_flag: "Refusing a value that looks like a flag: {value}",

  // git_config.rs — set/unset outcomes (scope word baked into the key so it
  // localizes as part of the sentence).
  config_set_local: "Set {key} = {value} (this repository).",
  config_set_global: "Set {key} = {value} (global).",
  config_unset_local: "Unset {key} (this repository).",
  config_unset_global: "Unset {key} (global).",
  config_already_unset_local: "{key} was already unset (this repository).",
  config_already_unset_global: "{key} was already unset (global).",

  // wsl.rs
  wsl_status_timed_out: "WSL status check timed out after {timeout} — try `wsl --shutdown` in a terminal, then reopen this repo",
  unexpected_rev_list_output: "unexpected `git rev-list --left-right --count` output: {output}",
  wsl_ahead_behind_timed_out: "WSL ahead/behind check timed out after {timeout}",

  // terminal.rs
  terminal_session_ended: "This terminal session has already ended.",

  // updater.rs
  bad_nightly_endpoint: "bad nightly endpoint: {detail}",
  updater_endpoint_error: "updater endpoint error: {detail}",
  updater_init_failed: "updater init failed: {detail}",
  update_check_failed: "update check failed: {detail}",

  // reflog.rs
  restore_needs_worktree: "Restore needs a working tree (bare repo not supported)",
  cannot_verify_clean_refusing_restore: "Cannot verify the working tree is clean, refusing restore: {detail}",
  worktree_has_uncommitted_restore: "Working tree has uncommitted changes — commit or stash before restoring.",
  cannot_read_head_reflog_cap: "Cannot read HEAD reflog: {detail}",
  cannot_read_head_reflog: "cannot read HEAD reflog: {detail}",
  reflog_stale_selection_one: "{ref} no longer exists — the reflog now has {count} entry. Refusing to restore a stale selection.",
  reflog_stale_selection_many: "{ref} no longer exists — the reflog now has {count} entries. Refusing to restore a stale selection.",
  restore_aborted_snapshot_failed: "Restore aborted — could not snapshot current state first: {detail}",
  restore_failed: "Restore failed: {detail}",
  restored_to: "Restored to {ref} ({sha}).",

  // safety.rs — snapshots / undo
  snapshot_created_not_found: "snapshot created but not found",
  nothing_to_undo: "Nothing to undo — no snapshots yet.",
  undo_needs_worktree: "undo needs a working tree (bare repo not supported)",
  cannot_verify_clean_refusing_undo: "Cannot verify the working tree is clean, refusing undo: {detail}",
  worktree_has_uncommitted_undo: "Working tree has uncommitted changes — commit or stash before undo.",
  undo_aborted_snapshot_failed: "Undo aborted — could not snapshot current state first: {detail}",
  undo_failed_restoring_head: "Undo failed restoring HEAD: {detail}",
  undo_failed: "Undo failed: {detail}",
  undo_failed_detaching_head: "Undo failed detaching HEAD: {detail}",
  couldnt_stash_before_undo: "Couldn't stash your changes before undo — {detail}",

  // rerere.rs
  rerere_enabled: "rerere enabled for this repository.",
  rerere_disabled: "rerere disabled for this repository.",
};
