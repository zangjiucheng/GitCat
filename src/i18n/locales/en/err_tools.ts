// Backend (app-authored) error/status strings for the external-tools,
// code-search and pickaxe modules (PER-82). Keys become `err_tools.<key>` and
// are looked up by `be()` (see src/i18n/i18n.svelte.ts) from the Rust
// `ierr`/`ierrp` machinery. English is the SOURCE OF TRUTH.
export default {
  // Shared across code_search.rs / pickaxe.rs / tool_settings.rs
  cannot_open_repo: "cannot open repository: {detail}",
  cannot_open_repo_cap: "Cannot open repository: {detail}",
  not_a_valid_commit: "Not a valid commit: {rev} ({detail})",
  could_not_run_git: "Could not run git: {detail}",
  git_exited_with_status: "git exited with status {code}",
  enter_search_text: "Enter something to search for.",
  search_text_nul: "Search text has an embedded NUL byte.",

  // pickaxe.rs
  path_does_not_exist: "{path} does not exist at {short}.",
  unknown_pickaxe_mode: 'Unknown pickaxe mode: {mode} (expected "added-removed", "diff-match", or "author").',
  path_nul: "Path has an embedded NUL byte.",

  // tool_settings.rs — persistence
  could_not_resolve_config_dir: "Could not resolve app config dir: {detail}",
  could_not_create_config_dir: "Could not create app config dir: {detail}",
  could_not_read: "Could not read {path}: {detail}",
  could_not_serialize: "Could not serialize: {detail}",
  could_not_write: "Could not write {path}: {detail}",
  could_not_finalize: "Could not finalize {path}: {detail}",

  // tool_settings.rs — validation
  tool_name_charset: "Tool name {name} may only contain letters, digits, '-' and '_'.",
  tool_id_required: "A tool id is required.",
  tool_id_charset:
    "Tool id {id} must start with a lowercase letter or digit and contain only lowercase letters, digits and '-'.",
  tool_name_required: "A tool name is required.",
  tool_command_required: "A tool command is required.",
  no_tool_with_id: "No {kind} tool with id {id} exists.",
  no_value_given: "No value given.",
  value_looks_like_flag: "Refusing a value that looks like a flag: {value}",
  value_illegal_char: "Value has an illegal NUL/newline character.",

  // tool_settings.rs — commit-message generation
  no_commit_command:
    "No commit-message command is set up. Add one in Tools ▸ External Tools (e.g. `aicommit`) — GitCat runs it and drops the output here; it talks to no AI itself.",
  could_not_run_commit_command: "Could not run the commit-message command: {detail}",
  interactive_command:
    'This command is interactive — it tried to prompt for input. GitCat runs it non-interactively and reads the message from its output, so configure a command that just PRINTS a commit message and exits (e.g. pipe the staged diff to a model: `git diff --staged | ollama run <model> "write a commit message"`, or a small script). Interactive \'generate-and-commit\' tools like aicommit2/opencommit own the whole commit themselves — use their git hook, not this box.',
  commit_command_failed: "The commit-message command failed: {detail}",
  commit_command_no_output: "The commit-message command produced no output.",

  // tool_settings.rs — diff/merge tool invocation
  no_diff_tool: "No external diff tool configured. Set one via Tools ▸ External Tools….",
  no_merge_tool: "No external merge tool configured. Set one via Tools ▸ External Tools….",
  could_not_launch_difftool: "Could not launch git difftool: {detail}",
  rev_range_both_or_neither: "fromRev and toRev must both be given, or both omitted.",
  range_and_staged_exclusive: "A specific revision range and `staged` are mutually exclusive.",
  filename_double_quote:
    "{file} contains a double-quote character, which git's own mergetool integration can't handle reliably — resolve this file manually instead.",
  cannot_inspect_repo_state: "cannot inspect repository state: {detail}",
  not_in_conflict_op:
    "Not inside a cherry-pick, merge, rebase, revert, stash, squash-merge, or patch-apply conflict (repository state: {op}). Resolve {op} conflicts with git on the command line.",
  could_not_run_mergetool: "Could not run git mergetool: {detail}",
  tool_changed_nothing:
    "The external tool exited successfully but didn't actually change {file} — nothing was resolved. git may still have marked it as resolved in the index; use Abort to fully restore the original conflict rather than continuing.",
  resolved_all_done: "Resolved {file} with the external tool. All conflicts resolved — Continue to finish.",
  resolved_some_remaining: "Resolved {file} with the external tool. {remaining} file(s) still conflicted.",
  tool_no_success: "The external tool did not report a successful resolution for {file}.",
};
