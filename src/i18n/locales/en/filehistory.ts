// Per-file history modal strings. Keys become `filehistory.<key>`.
export default {
  heading: "History",
  renamed_from: "renamed from",
  as_of: "as of",
  follows_renames: "follows renames",
  caveat: "may be incomplete around a rename that crosses a merge (known git limitation)",
  caveat_title:
    "git's own --follow can lose track of a file's earlier history when a rename on one branch is later combined by a merge with unrelated changes on another — a known git limitation, not a GitCat bug.",
  loading: "loading history…",
  empty: "no history found for this file",
  jump_to: "Jump to {sha}",
  truncated: "… truncated (history capped)",
  open_repo_first: "Open a repository first.",
  err_load: "Could not load this file's history.",
  err_unavailable: "File history unavailable — {reason}",
  warn_not_loaded: "commit not loaded in the current graph",
};
