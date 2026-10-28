// App-authored backend error strings for remote sync (fetch/pull/push),
// remote config CRUD, and submodules (PER-82). Keys become `err_remote.<key>`.
// English is the SOURCE OF TRUTH — text here must match the Rust `ierr`/`ierrp`
// call sites in git_remote.rs / git_remote_manage.rs / submodule.rs verbatim.
// Raw git stderr is NEVER keyed here; it passes through unchanged.
export default {
  // Shared git-runner failures.
  run_git_failed: "Could not run git: {detail}",
  git_wait_failed: "git wait failed: {detail}",
  git_exited_status: "git exited with status {code}",
  // SSH remediation hints appended to git's own failure output ({base} is the
  // raw git stderr, carried through verbatim and not itself localized).
  ssh_publickey_wsl_hint:
    "{base} (WSL skips shell init, so ssh-agent never starts — start one in a WSL terminal, or use a passphrase-less key)",
  host_key_wsl_hint:
    "{base} (run any ssh/git command against this remote from a WSL terminal once to accept its host key, then retry)",
  host_key_hint:
    "{base} (run any ssh/git command against this remote from a terminal once to accept its host key, then retry)",
  // A user-cancelled fetch/pull/push (#133). One flat key per outcome — be()
  // can't nest keys, so each variant carries all of its own params. {locks} is
  // the removed lock files, relative to the git dir; {snapshot} the pre-pull
  // snapshot's short name; {op} the git command that was aborted.
  fetch_cancelled: "Fetch cancelled. Remote-tracking refs may be partly updated; fetch again to finish.",
  fetch_cancelled_locks:
    "Fetch cancelled. Removed the lock files the cancelled git left behind: {locks}. Fetch again to finish.",
  push_cancelled: "Push cancelled. The remote may or may not have received it; fetch to check.",
  push_cancelled_locks:
    "Push cancelled. The remote may or may not have received it; fetch to check. Removed the lock files the cancelled git left behind: {locks}.",
  pull_cancelled: "Pull cancelled. If anything looks half-updated, {undoKey} restores the pre-pull snapshot {snapshot}.",
  pull_cancelled_locks:
    "Pull cancelled. Removed the lock files the cancelled git left behind: {locks}. If anything looks half-updated, {undoKey} restores the pre-pull snapshot {snapshot}.",
  pull_cancelled_aborted:
    "Pull cancelled. Ran git {op} --abort to back out the half-finished {op}. {undoKey} restores the pre-pull snapshot {snapshot} if anything still looks wrong.",
  pull_cancelled_locks_aborted:
    "Pull cancelled. Removed the lock files the cancelled git left behind ({locks}) and ran git {op} --abort to back out the half-finished {op}. {undoKey} restores the pre-pull snapshot {snapshot} if anything still looks wrong.",
  // Repo open / snapshot.
  cannot_open: "Cannot open repository: {detail}",
  snapshot_failed: "Safety snapshot failed, aborting: {detail}",
  // Remote-name validation.
  remote_name_empty: "Remote name is empty.",
  remote_name_flag: "Refusing a remote name that looks like a flag: {name}",
  remote_name_control: "Remote name has an illegal whitespace/control character: {name}",
  // Remote-URL validation (git_remote_manage's lighter URL guard).
  remote_url_empty: "Remote URL is empty.",
  remote_url_flag: "Refusing a URL that looks like a flag: {url}",
  remote_url_control: "Remote URL has a control character.",
  // Branch-name validation.
  branch_name_empty: "Branch name is empty.",
  branch_name_flag: "Refusing a branch name that looks like a flag: {name}",
  branch_name_control: "Branch name has an illegal whitespace/control character: {name}",
  branch_name_illegal_char: "Branch name has an illegal character '{ch}': {name}",
  branch_name_invalid: "Not a valid branch name: {name}",
  // Tag-name validation.
  tag_name_empty: "Tag name is empty.",
  tag_name_flag: "Refusing a tag name that looks like a flag: {name}",
  tag_name_control: "Tag name has an illegal whitespace/control character: {name}",
  tag_name_illegal_char: "Tag name has an illegal character '{ch}': {name}",
  tag_name_invalid: "Not a valid tag name: {name}",
  // Branch / upstream resolution.
  no_local_branch: "No local branch named {branch}.",
  branch_no_upstream_reset: "{branch} has no configured upstream to reset to.",
  upstream_name_not_utf8: "{branch}'s upstream name isn't valid UTF-8.",
  head_not_on_branch_push: "HEAD is not on a branch — nothing to push.",
  head_not_on_branch_force_push: "HEAD is not on a branch — nothing to force-push.",
  no_upstream_use_push: "This branch has no upstream yet — use Push to publish it first.",
  // push_target (git_remote.rs): where Push/Force push goes, resolved as git
  // would for one branch, then pushed with an explicit refspec.
  cannot_read_config: "Could not read this repository's git config: {detail}",
  push_mirror_remote: "Remote \"{remote}\" is configured as a mirror (remote.{remote}.mirror), so a push there sends every ref. GitCat only pushes one branch — push to a mirror from a terminal.",
  push_default_nothing: "push.default is \"nothing\", so git pushes nothing without an explicit destination. Use the branch menu’s “Push to…” to choose one.",
  push_upstream_not_push_remote: "push.default is \"upstream\", but this branch pushes to \"{remote}\" while its upstream is on \"{upstream}\". Use the branch menu’s “Push to…” to choose a destination.",
  push_no_upstream_branch: "This branch's upstream has no branch name (branch.<name>.merge is unset).",
  push_upstream_name_differs: "\"{branch}\" tracks {upstream}, which has a different name, so Push won't update it (git's push.default=simple does the same). Use the branch menu’s “Push to…” to choose a destination.",
  no_such_local_branch: "No such local branch: {branch}",
  // Submodule path / repository-URL validation.
  submodule_path_empty: "Submodule path is empty.",
  submodule_path_flag: "Refusing a submodule path that looks like a flag: {path}",
  submodule_path_control: "Submodule path has a control character: {path}",
  repository_url_empty: "Repository URL is empty.",
  repository_url_flag: "Refusing a repository URL that looks like a flag: {url}",
  repository_url_control: "Repository URL has a control character: {url}",
  // Submodule deinit / remove backup + cleanup ({detail} carries the inner,
  // already-English reason verbatim).
  backup_failed_deinit:
    "Could not back up {path}'s own uncommitted changes before force-deiniting, refusing: {detail}",
  backup_failed_remove: "Could not back up {path}'s own uncommitted changes before removing, refusing: {detail}",
  gitlink_staged_but:
    "{path}'s gitlink was staged for removal, but {detail}. Run `git status` to see the partial state before retrying",
};
