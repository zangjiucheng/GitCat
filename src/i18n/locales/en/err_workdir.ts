// App-authored backend error strings for the working-tree (stage/unstage/
// discard/commit/stash) and branch (create/checkout/reset/delete/rename)
// commands — see src-tauri/src/workdir.rs and src-tauri/src/git_write.rs.
// Keys become `err_workdir.<key>` and are resolved by `be()` (i18n.svelte.ts)
// from the `i18n:err_workdir.<key>` strings those Rust files return via
// ierr()/ierrp(). English is the SOURCE OF TRUTH; a `{name}` placeholder here
// must match a param the Rust side passes. Raw git stderr is NOT keyed — it
// travels through `be()` verbatim.
export default {
  // Shared helpers (workdir.rs + git_write.rs).
  could_not_run_git: "Could not run git: {detail}",
  cannot_open_repo: "Cannot open repository: {detail}",
  safety_snapshot_failed: "Safety snapshot failed, aborting: {detail}",
  // Pathspec validation.
  file_path_empty: "File path is empty.",
  file_path_looks_like_flag: "Refusing a file path that looks like a flag: {file}",
  file_path_illegal_char: "File path has an illegal NUL/CR/LF character: {file}",
  // File diff.
  no_staged_changes_found: "No staged changes found for {file}.",
  no_unstaged_changes_found: "No unstaged changes found for {file}.",
  // Discard (file + unstaged-rename reversal).
  could_not_back_up_before_discarding: "Could not back up {file} before discarding, refusing: {detail}",
  cannot_restore_old_path: "Cannot restore the old path {old_path}: {detail}",
  refusing_old_path_exists_no_backup:
    "Refusing: {old_path} already exists and could not be backed up before restoring it: {detail}",
  could_not_restore_path: "Could not restore {old_path}: {detail}",
  restored_but_could_not_remove: "Restored {old_path}, but could not remove {new_path}: {detail}",
  // Line/hunk-level staging.
  stale_diff: "This file's diff has changed since you last looked — refresh and try again.",
  typechange_line_staging_unsupported:
    "{file} changed type (file <-> symlink, etc.) — line-level staging isn't supported; stage/discard the whole file instead.",
  binary_line_staging_unsupported:
    "{file} is a binary file — line-level staging isn't supported; stage/discard the whole file instead.",
  invalid_selected_line_kind: 'Invalid selected line kind {kind} — only "+"/"-" rows can be selected.',
  no_lines_selected: "No lines selected.",
  partial_no_newline_unsupported:
    "{file}'s last line doesn't end with a newline on at least one side of this change — partial line selection isn't supported there. Select the whole hunk (or the whole file) instead.",
  could_not_write_patch_stdin: "Could not write the patch to git apply's stdin: {detail}",
  // Commit.
  commit_message_empty: "Commit message is empty.",
  // Stash save / apply / pop / drop.
  nothing_to_stash: "Nothing to stash — the working tree is clean.",
  stash_changed_since:
    "stash@{{index}} has changed since you last looked (was {expected}, now {actual}) — refresh the stash list and try again.",
  stash_no_longer_exists: "stash@{{index}} no longer exists — refresh the stash list and try again.",
  another_op_in_progress:
    "Another operation (merge/rebase/cherry-pick) is already in progress — resolve or abort it first.",
  unresolved_stash_conflicts:
    "There are unresolved conflicts from a previous stash apply/pop — resolve or abort them first.",
  stash_apply_conflict_one:
    "Apply of {stash_ref} hit a conflict in {n} file. Resolve them in the Resolver, then Continue — or Abort. The stash entry is kept.",
  stash_apply_conflict_other:
    "Apply of {stash_ref} hit a conflict in {n} files. Resolve them in the Resolver, then Continue — or Abort. The stash entry is kept.",
  stash_pop_conflict_one:
    "Pop of {stash_ref} hit a conflict in {n} file. Resolve them in the Resolver, then Continue — or Abort. The stash entry is kept.",
  stash_pop_conflict_other:
    "Pop of {stash_ref} hit a conflict in {n} files. Resolve them in the Resolver, then Continue — or Abort. The stash entry is kept.",
  refusing_to_drop_no_backup: "Refusing to drop {stash_ref} — could not back it up first: {detail}",
  // Stash-conflict Abort / Continue.
  no_stash_conflict_to_abort: "No stash conflict in progress to abort.",
  could_not_resolve_snapshot: "Could not resolve the pre-conflict snapshot {backup_ref}: {detail}",
  no_stash_conflict_to_continue: "No stash conflict in progress to continue.",
  still_conflicted_one: "Still conflicted in {n} file. Resolve them, then Continue — or Abort.",
  still_conflicted_other: "Still conflicted in {n} files. Resolve them, then Continue — or Abort.",
  could_not_drop_popped_stash: "Conflict resolved, but could not drop the popped stash entry: {detail}",
  // Stash apply/pop Undo.
  unresolved_conflicts_use_resolver:
    "There are unresolved conflicts from a stash apply/pop — resolve them via the Resolver (Continue/Abort) instead of Undo.",
  working_tree_already_clean: "Working tree is already clean — nothing to undo.",
  // Branch-name / start-point validation (git_write.rs).
  branch_name_empty: "Branch name is empty.",
  branch_name_looks_like_flag: "Refusing a branch name that looks like a flag: {name}",
  branch_name_illegal_whitespace: "Branch name has an illegal whitespace/control character: {name}",
  branch_name_illegal_char: "Branch name has an illegal character '{ch}': {name}",
  not_valid_branch_name: "Not a valid branch name: {name}",
  start_point_empty: "Start point is empty.",
  start_point_looks_like_flag: "Refusing a start point that looks like a flag: {rev}",
  start_point_control_char: "Start point has a control character.",
  // Branch commands (git_write.rs).
  unknown_reset_mode: "Unknown reset mode {mode} (expected soft, mixed, or hard).",
  cannot_resolve_to_commit: "Can't resolve {target} to a commit: {detail}",
  cannot_delete_current_branch: "Cannot delete {name}: it is the current branch. Switch away first.",
};
