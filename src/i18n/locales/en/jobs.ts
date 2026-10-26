// Running-jobs indicator in the topbar (#133). Keys become `jobs.<key>`.
export default {
  running: "{n} running",
  title: "Running jobs",
  empty: "Nothing running.",
  cancel_aria: "Cancel {label}",
  // job-progress fires only on change, so {secs} is the threshold, not a live counter.
  stalled: "Looks stuck — no output for over {secs}s",
  stalled_prompt: "{label} looks stuck. Cancel it from the jobs menu?",
  cancelled_toast: "Cancelled {label}.",
  kind_fetch: "Fetch",
  kind_pull: "Pull",
  kind_push: "Push",
  toggle_shortcut: "Show running jobs",
};
