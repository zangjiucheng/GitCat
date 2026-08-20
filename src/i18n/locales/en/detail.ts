// Commit detail panel strings. Keys become `detail.<key>`.
export default {
  // Tama hero / empty state.
  hero_alt: "Tama, GitCat's guardian",
  hero_bubble_loaded:
    'はじめまして! I\'m <b>Tama</b>, GitCat\'s guardian. I pin a snapshot before every mutation — so your history is always safe with me. <span class="jp">にゃ〜♪</span>',
  hero_bubble_loaded_plain: "A snapshot is taken before every mutation — your history is always safe.",
  hero_stat: '<span class="n">{n}</span> commits laid out in <b>{ms} ms</b>',
  hero_hint_loaded: "Click a commit to inspect it · drag a dot onto another to cherry-pick · ⌘Z to rewind",
  hero_bubble_empty:
    'はじめまして! I\'m <b>Tama</b>. Open a Git repository and I\'ll lay out its whole history in a blink. <span class="jp">にゃ〜♪</span>',
  hero_bubble_empty_plain: "Open a Git repository to get started.",
  open_repo: "Open a repository…",
  hero_hint_open: "or click the repo name <b>▾</b> in the top bar",
  // Commit body / id strip / revert.
  loading: "loading…",
  show_less: "Show less",
  show_more: "Show more",
  click_to_copy: "Click to copy the full hash",
  copied: "copied ✓",
  row_of: "row {row} / {total}",
  cant_revert_merge: "Can't revert a merge commit",
  revert_commit: "Revert commit",
  // Author / committer.
  author: "Author",
  committer: "Committer",
  author_ne_committer: "⚠ author ≠ committer (patch applied / rebased) — the teaching point cherry-pick & rebase create.",
  // Refs + snapshot coverage.
  refs_pointing_here: "Refs pointing here",
  no_refs: "no refs point here",
  covered:
    'Covered by snapshot <b>backup/…{ago} ago</b><br /><span class="mut">reachable via a Safety-Manager backup ref — ⌘Z can rewind here.</span>',
  // Changes / diffstat / tree.
  changes: "Changes",
  loading_diff: "loading diff…",
  file: "file",
  files_plural: "files",
  capped_suffix: " (capped)",
  loading_files: "loading files…",
  no_file_changes: "no file changes",
  diff: "Diff",
  expand_diff: "Expand diff",
  expand_diff_aria: "Expand diff to full page",
  files_label: "Files",
  resize_file_list: "Resize file list",
  collapse_all_folders: "Collapse all folders",
  expand_all_folders: "Expand all folders",
  // File-row actions.
  blame: "Blame",
  blame_file: "Blame {path}",
  history: "History",
  history_file: "History {path}",
  open_external_diff: "Open in external diff",
  open_external_diff_for: "Open in external diff for {path}",
  // Tama toasts.
  parent_blame_failed: "Couldn't resolve the parent commit to blame a deleted file.",
  parent_history_failed: "Couldn't resolve the parent commit to show history for a deleted file.",
  parent_resolve_failed: "Couldn't resolve the parent commit — {e}",
};
