// App-authored backend error strings for history-rewriting ops: rebase,
// merge (incl. squash + multi/octopus/sequential), revert, tag create/delete,
// and cherry-pick (PER-82). Keys become `err_history.<key>`.
// English is the SOURCE OF TRUTH — text here must match the Rust `ierr`/`ierrp`
// call sites in git_rebase.rs / git_merge.rs / git_revert.rs / git_tag.rs /
// git_pick.rs verbatim. Raw git stderr is NEVER keyed here (these ops surface
// a lot of it after a failed merge/rebase); it passes through unchanged.
export default {
  // Shared git-runner / repo-open / snapshot / revision-validation failures.
  // ({detail} carries the raw io/git2 reason verbatim and is not localized.)
  could_not_run_git: "Could not run git: {detail}",
  cannot_open: "Cannot open repository: {detail}",
  snapshot_failed: "Safety snapshot failed, aborting: {detail}",
  revision_looks_like_flag: "Refusing a revision that looks like a flag: {rev}",
  revision_control_char: "Revision has a control character.",

  // Rebase.
  no_rebase_target: "No target to rebase onto.",
  cannot_resolve_revision: "Cannot resolve revision {rev}: {detail}",
  revision_not_commit: "Revision {rev} is not a commit: {detail}",
  cannot_walk_from_head: "Cannot walk from HEAD: {detail}",
  cannot_resolve_target: "Cannot resolve target: {detail}",
  bad_commit_id: "Bad commit id {sha}: {detail}",
  cannot_find_commit: "Cannot find commit {sha}: {detail}",
  could_not_create_todo_dir: "could not create rebase-todo dir: {detail}",
  could_not_write_todo: "could not write precomputed todo: {detail}",
  rebase_in_progress: "A rebase is already in progress — resolve or abort it first.",
  no_rebase_to_continue: "No rebase in progress to continue.",
  no_rebase_to_skip: "No rebase in progress to skip a commit from.",
  nothing_to_rebase: "Nothing to rebase — no commits between HEAD and the target.",
  unknown_rebase_action: "Unknown rebase action: {action}",
  first_commit_squash:
    "The first commit in the plan can't be squash/fixup — nothing precedes it to combine into.",
  plan_out_of_date: "This plan is out of date with the repository — refresh and try again.",

  // Merge (single / squash / multi).
  no_commit_to_merge: "No commit to merge.",
  merge_in_progress: "A merge is already in progress — resolve or abort it first.",
  unknown_merge_strategy: 'Unknown merge strategy {strategy} (expected "auto", "no-ff", or "ff-only").',
  no_merge_to_continue: "No merge in progress to continue.",
  other_op_in_progress:
    "Another operation (merge/rebase/cherry-pick/revert) is already in progress — resolve or abort it first.",
  unresolved_conflicts_already: "There are unresolved conflicts already — resolve or abort them first.",
  no_squash_conflict_to_abort: "No squash-merge conflict in progress to abort.",
  cannot_resolve_snapshot: "Could not resolve the pre-conflict snapshot {ref}: {detail}",
  no_squash_conflict_to_continue: "No squash-merge conflict in progress to continue.",
  unknown_merge_mode: 'Unknown merge mode {mode} (expected "octopus" or "sequential").',
  pick_at_least_two: "Pick at least two branches to merge.",
  sequential_queue_in_progress:
    "A sequential merge queue is already in progress — continue or abort it first.",
  no_sequential_queue: "No sequential merge queue in progress.",
  finish_resolving_first: "Finish resolving the current merge first.",

  // Revert.
  no_commit_to_revert: "No commit to revert.",
  revert_in_progress: "A revert is already in progress — resolve or abort it first.",
  no_revert_to_continue: "No revert in progress to continue.",

  // Cherry-pick.
  no_commit_to_cherry_pick: "No commit to cherry-pick.",
  cannot_resolve: "Cannot resolve {rev}: {detail}",
  cannot_read_commit: "Cannot read commit {rev}: {detail}",
  cherry_pick_in_progress: "A cherry-pick is already in progress — resolve or abort it first.",
  no_cherry_pick_to_continue: "No cherry-pick in progress to continue.",

  // Tag create / delete.
  tag_name_empty: "Tag name is empty.",
  tag_name_flag: "Refusing a tag name that looks like a flag: {name}",
  tag_name_control: "Tag name has an illegal whitespace/control character: {name}",
  tag_name_illegal_char: "Tag name has an illegal character '{ch}': {name}",
  tag_name_invalid: "Not a valid tag name: {name}",
  target_empty: "Target is empty.",
  target_flag: "Refusing a target that looks like a flag: {rev}",
  target_control: "Target has a control character.",
  tag_does_not_exist: "Tag {name} does not exist.",
  refuse_delete_tag_backup:
    "Refusing to delete tag {name} — could not back it up first: {detail}",
};
