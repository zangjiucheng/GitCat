// Static top-bar / toolbar + loading chrome (lives in index.html, not an
// island, so it's applied imperatively by legacy/main.ts's applyStaticI18n).
// Keys become `topbar.<key>`.
export default {
  repo_pick_empty: "Open a repository…",
  wsl_tip: "This repository lives inside WSL — network commands route through wsl.exe for credential resolution",
  goto_head: "Jump to the current commit (HEAD)  ⌘⇧H",
  goto_head_aria: "Jump to current commit (HEAD)",
  cmd_palette: "Command palette",
  search_hint: "Search commits, refs, actions…",
  fetch: "Fetch",
  pull: "Pull",
  push: "Push",
  fetch_tip: "Fetch — update remote-tracking refs (⌘⇧D)",
  pull_tip: "Pull (fast-forward only) (⌘⇧L)",
  push_tip: "Push (⌘⇧P)",
  fetching: "Fetching…",
  pulling: "Pulling…",
  pushing: "Pushing…",
  refresh_tip: "Refresh — resync with the repo on disk",
  undo: "Undo",
  undo_tip: "Global Undo — Safety Manager (⌘Z)",
  theme_tip: "Toggle theme",
  loading_repo: "Loading repository…",
  loading: "Loading…",
};
