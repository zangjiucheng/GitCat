// Settings modal strings. Keys become `settings.<key>`.
export default {
  title: "Settings",
  subtitle: "Theme, cherry-pick defaults, update checks, and this repository's git identity.",
  tab_general: "General",
  tab_tama: "Tama",
  tab_identity: "Git Identity",
  tab_gitconfig: "Git Config",
  language: "Language",
  language_hint: "The app's display language. Applies immediately.",
  cli_h4: "Command line",
  cli_desc:
    "Add a <code>gitcat</code> command to your PATH so you can open a repository from any terminal, the way <code>code .</code> works in VS Code. It opens the app without blocking your terminal. On macOS you may be asked for your password.",
  cli_installing: "Installing…",
  cli_install_btn: "Install 'gitcat' command",
  cli_ok: "Installed at {path}. Open a new terminal and run gitcat . inside any repo.",
  cli_err: "Couldn't install the gitcat command.",
  cli_err_e: "Couldn't install the gitcat command. {e}",

  // Appearance
  appearance: "Appearance",
  theme_system: "Match system",
  theme_light: "Light",
  theme_dark: "Dark",

  // Graph
  graph: "Graph",
  show_all_tags_hint: "When a commit has more than one tag, draw all of them instead of just the first",
  show_all_tags: "Show all tags on a commit",
  label_priority_desc:
    "When a commit's labels don't all fit, show this kind first. Click a row's <b>+N</b> chip to cycle the rest into view.",
  label_priority_tags: "Tags first",
  label_priority_branches: "Branches first",
  label_layout_desc:
    "Inline draws a commit's ref chips right before its subject text; Left column keeps them in a separate, resizable column.",
  label_layout_inline: "Inline (before the subject)",
  label_layout_column: "Left column",

  // Cherry-pick
  cherrypick: "Cherry-pick",
  cherrypick_origin_hint: "Append '(cherry picked from …)' to the resulting commit message",
  cherrypick_record_origin: "Record origin (-x) on cherry-pick",

  // Updates
  updates: "Updates",
  auto_check_updates: "Automatically check for updates on launch",
  use_nightly: "Use nightly builds",
  nightly_hint:
    "Unstable daily builds with verbose debug logging. You can switch back to the latest stable release at any time.",
  check_updates_now: "Check for updates now",
  checking_updates: "Checking for updates…",
  up_to_date: "You're up to date.",
  up_to_date_ok: "OK",
  update_available: "<b>v{version}</b> is available <span class=\"mut\">(you have v{current})</span>",
  not_now: "Not now",
  download_install: "Download & Install",
  downloading_pct: "Downloading… {progress}%",
  downloading: "Downloading…",
  update_downloaded: "Update downloaded — restart to finish installing.",
  restart_now: "Restart Now",
  dismiss: "Dismiss",

  // Auto-fetch
  autofetch: "Auto-fetch",
  autofetch_hint:
    "Runs git fetch --all --prune on a timer while a repo is open, so ahead/behind counts and incoming remote changes stay current without a manual Pull",
  autofetch_toggle: "Periodically fetch from all remotes",
  autofetch_every: "Every {m} minutes",

  // Maintenance
  maintenance: "Maintenance",
  maintenance_hint:
    "Runs 'git maintenance run --auto' in the background while GitCat is idle, keeping the repo's object database tidy (commit-graph, gc, repack) so the graph and status stay fast. --auto only does work that's actually due; it never changes history, the working tree, or touches a remote.",
  maintenance_toggle: "Run git maintenance in the background when idle",
  maintenance_desc:
    "Keeps the repository's object database tidy (commit-graph, gc, repack) so everyday operations stay fast — only while the app sits idle, and only the work git decides is actually due. Off by default.",

  // Snapshots
  snapshots: "Snapshots",
  snapshots_desc:
    "Every history-changing action pins a recoverable backup — this is what powers ⌘Z Undo and the Snapshots ribbon. Without cleanup they build up over time. Auto-cleanup prunes old ones each time a repo opens; the single most recent snapshot is always kept.",
  snapshot_keep_all: "Keep everything (no cleanup)",
  snapshot_keep_count: "Keep the newest N",
  snapshot_keep_age: "Keep the last N days",
  snapshot_keep_hybrid: "Hybrid — newest N or last N days",
  snapshot_count_before: "Keep the newest",
  snapshot_count_after: "snapshots",
  snapshot_days_before: "Keep snapshots from the last",
  snapshot_days_after: "days",
  snapshot_hybrid_note: "A snapshot survives if it's among the newest {count} <b>or</b> from the last {days} days.",

  // Tama
  tama: "Tama",
  tama_show_hint:
    "Hides Tama's portraits everywhere she appears (the corner mascot, the empty-state greeting, modal headers, the undo popover) for a plainer, more focused look. Status/error messages in the corner still show — just without the character.",
  tama_show: "Show Tama",
  sound_hint:
    "A few short synthesized chimes for her more significant moments — warnings, danger, celebrating, a copy-to-clipboard tick",
  sound_toggle: "Play sound effects",
  sound_volume_aria: "Sound effects volume",
  sound_test: "Test",

  // Skin
  skin: "Skin",
  skin_desc:
    "Choose a look — and voice — for Tama: her default painted portraits, one of the bundled characters, or a skin shipped by an installed plugin.",
  skin_default: "Default (built-in)",

  // Motion
  motion: "Motion",
  motion_desc: "How lively Tama's idle motion and reactions feel. <b>Default</b> keeps her current behavior.",

  // Expressions
  expressions: "Expressions",
  expressions_desc: "Pick which face Tama makes for each moment. Leave one on <b>Default</b> to keep her built-in look.",
  expressions_pose_default: "Default ({pose})",
  reset_expressions: "Reset expressions",

  // Git identity
  git_identity: "Git identity",
  identity_no_repo: "Open a repository to view or edit its git identity.",
  identity_loading: "Loading git identity…",
  identity_global_note:
    "No identity set for this repository specifically — showing your <b>global</b> git identity below. Save to set one just for this repo instead.",
  identity_name: "Name",
  identity_email: "Email",
  identity_local_note:
    "Written only to this repository's <code>.git/config</code> — your global git identity is never touched.",

  // Git config
  git_config: "Git config",
  config_no_repo: "Open a repository to view or edit its git configuration.",
  config_scope_local: "This repository (.git/config)",
  config_scope_global: "Global (~/.gitconfig — every repository)",
  config_loading: "Loading git configuration…",
  show_advanced: "Show advanced (any key)…",
  hide_advanced: "Hide advanced",
  loading: "Loading…",
  filter_placeholder: "Filter keys or values…",
  edit: "Edit",
  remove: "Remove",
  no_entries_match: "No entries match \"{filter}\".",
  no_config_entries: "No {scope} config entries.",
  advanced_add_hint: "Add a key, or click Edit on an existing row to update its value.",
  advanced_key_placeholder: "section.key",
  advanced_value_placeholder: "value",
  set: "Set",

  // Footer
  saving: "Saving…",
  save_identity: "Save Identity",
};
