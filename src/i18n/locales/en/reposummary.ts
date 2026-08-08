// Repository Summary strings. Keys become `reposummary.<key>`.
export default {
  title: "Repository Summary",
  subtitle_pre: "A quick orientation from ",
  subtitle_post:
    " itself: which files see the most churn, who's actually maintaining this repo, how active it's been over time, and where the recurring trouble spots are.",
  loading: "Reading git log… this can take a moment on a large repo.",
  none: "No commits in the last {days} days — nothing to summarize yet.",
  churn_title: "Churn Hotspots",
  churn_sub: "most-changed files, last {days} days",
  churn_empty: "No file changes in this window.",
  contributors_title: "Contributors",
  bus_factor: "Bus factor: {n}",
  contributors_empty: "No contributors in this window.",
  monthly_title: "Monthly Activity",
  monthly_empty: "No commits in this window.",
  month_tooltip: "{month}: {n} commits",
  problem_title: "Problem Areas",
  problem_caveat: "heuristic, not a precise classifier",
  problem_caveat_title:
    "Keyword-based heuristic over commit subjects (fix/bug/hotfix/regression/revert/…) — not a classifier. Real false positives and false negatives are expected.",
  problem_reverts: "{n} of {total} commits ({pct}%) were reverts or hotfixes.",
  problem_empty: "No recurring problem files found.",
  truncated: "… truncated (capped) — showing a partial picture of a very large history.",
  err_summarize: "Could not summarize this repository.",
  err_summarize_e: "Could not summarize this repository — {e}",
};
