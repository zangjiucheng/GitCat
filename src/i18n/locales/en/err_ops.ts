// App-authored backend error strings for repo OPERATIONS — patch export/apply
// (git format-patch --stdout / git am --3way), the 3-way conflict resolver, and
// git bisect. See src-tauri/src/patch.rs, src-tauri/src/conflict.rs, and
// src-tauri/src/git_bisect.rs. Keys become `err_ops.<key>` and are resolved by
// `be()` (i18n.svelte.ts) from the `i18n:err_ops.<key>` strings those Rust files
// return via ierr()/ierrp(). English is the SOURCE OF TRUTH; a `{name}`
// placeholder here must match a param the Rust side passes. Raw git stderr is
// NOT keyed — it travels through `be()` verbatim.
export default {
  // Shared helpers (patch.rs + conflict.rs + git_bisect.rs).
  could_not_run_git: "Could not run git: {detail}",
  cannot_open_repo: "Cannot open repository: {detail}",
  cannot_open_repo_lc: "cannot open repository: {detail}",
  safety_snapshot_failed: "Safety snapshot failed, aborting: {detail}",
  cannot_resolve_revision: "Cannot resolve revision {rev}: {detail}",
  refusing_rev_like_flag: "Refusing a revision that looks like a flag: {rev}",
  rev_control_char: "Revision has a control character.",
  refusing_path_like_flag: "Refusing a path that looks like a flag: {path}",
  path_illegal_nul_newline: "Path has an illegal NUL/newline character.",
  // Patch export / apply (patch.rs).
  could_not_write_am_stdin: "Could not write the patch to git am's stdin: {detail}",
  no_revision_given: "No revision given.",
  no_dest_file_chosen: "No destination file chosen.",
  dest_illegal_nul: "Destination path has an illegal NUL character.",
  no_patch_file_chosen: "No patch file chosen.",
  apply_conflict_one:
    "Applying the patch conflicts in {n} file. Resolve them, then Continue — or Skip this commit, or Abort.",
  apply_conflict_other:
    "Applying the patch conflicts in {n} files. Resolve them, then Continue — or Skip this commit, or Abort.",
  could_not_finish_applying:
    "Could not finish applying the patch: {detail}. Continue to retry, Skip this commit, or Abort.",
  cannot_export_merge_single:
    "Can't export a merge commit as a single patch — format-patch has no single unambiguous diff for a merge (git itself would silently export its FIRST PARENT's commit instead, not the merge). Use Export Patches… with an explicit revision range instead.",
  format_patch_failed: "git format-patch failed.",
  nothing_to_export: "Nothing to export — that range contains no commits.",
  could_not_write_dest: "Could not write {dest}: {detail}",
  another_op_in_progress: "Another operation is already in progress — resolve or abort it first.",
  could_not_read_patch_file: "Couldn't read the patch file: {detail}",
  no_patch_apply_to_continue: "No patch-apply in progress to continue.",
  no_patch_apply_to_skip: "No patch-apply in progress to skip a commit from.",
  // 3-way conflict resolver (conflict.rs).
  cannot_inspect_repo_state: "cannot inspect repository state: {detail}",
  not_in_resolvable_op:
    "Not inside a cherry-pick, merge, rebase, revert, stash, squash-merge, or patch-apply conflict (repository state: {op}). Resolve {op} conflicts with git on the command line.",
  unknown_side: 'Unknown side {side} (expected "ours" or "theirs").',
  no_file_specified: "No file specified.",
  refusing_absolute_path: "Refusing an absolute path.",
  refusing_path_dotdot: 'Refusing a path containing "..".',
  file_not_conflicted: "{file} is not conflicted.",
  cannot_create_scratch_dir: "cannot create scratch dir: {detail}",
  cannot_write_scratch_files: "cannot write scratch files: {detail}",
  merge_file_exited_with_status: "git merge-file exited with status {code}",
  could_not_parse_conflict_markers:
    "could not parse this file's conflict markers — an unterminated conflict region was found.",
  cannot_write_file: "cannot write {file}: {detail}",
  // Bisect (git_bisect.rs).
  no_commit_specified: "No commit specified.",
  not_a_commit: "Not a commit this repository knows: {rev}",
  bisect_already_in_progress: "A bisect is already in progress — reset it before starting a new one.",
  select_known_good: "Select at least one known-good commit to bisect between.",
  cannot_verify_clean: "Cannot verify the working tree is clean, refusing to bisect: {detail}",
  working_tree_dirty: "Working tree has uncommitted changes — commit or stash before bisecting.",
  unknown_mark: 'Unknown mark {mark} (expected "good", "bad", or "skip").',
  no_bisect_in_progress_start: "No bisect in progress — start one first.",
  bisect_run_aborted: "Automated bisect run aborted — {detail}.",
  bisect_run_already_in_progress:
    "An automated bisect run is already in progress — cancel it before starting another.",
};
