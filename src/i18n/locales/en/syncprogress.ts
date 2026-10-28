// Live git sync-progress modal (fetch/pull/push). Keys become `syncprogress.<key>`.
export default {
  title: "Syncing…",
  body: "Live output from git. This can take a while on a large remote or a WSL repo. Hide keeps it running in the background; Cancel stops it.",
  starting: "Starting…",
  done: "Done.",
  hide: "Hide",
  cancelling: "Cancelling…",
  cancelled: "Cancelled.",
  // job-progress fires only on change, so {secs} is the threshold, not a live counter.
  stalled: "No progress from git for over {secs}s — it looks stuck. Cancel?",
  // Appended to the log when a hidden modal is shown again: what git printed
  // while it was hidden was not kept.
  hidden_gap: "… (output while hidden was not kept)",
  // Tooltip on the topbar button of the op that is running.
  show_progress: "Show progress",
};
