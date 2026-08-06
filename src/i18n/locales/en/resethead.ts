// Reset HEAD to a commit. Keys become `resethead.<key>`.
export default {
  open_repo_first: "Open a repository first.",
  reset_mode_head: "Reset mode",
  mode_soft: "<b>Soft</b> — move HEAD only; keep the index and every working-tree change.",
  mode_mixed: "<b>Mixed</b> — move HEAD and unstage, but keep your working-tree files <em>(git's default)</em>.",
  mode_hard:
    "<b>Hard</b> — move HEAD and <b>discard every staged &amp; unstaged change</b>. Uncommitted work is lost with no Undo.",
  note_snapshot:
    "I snapshot where HEAD is now first, so ⌘Z/Undo can move it back — as long as your working tree is clean.",
  note_hard:
    "A <b>hard</b> reset additionally throws away uncommitted changes, and those are NOT covered by the snapshot.",
  arm_say_known: "Resetting HEAD to {sha} — type the short sha to arm it.",
  title_known: "Reset HEAD to {sha}",
  desc_known:
    "Moves the current branch (HEAD) to {sha}{subject}. Any commits currently ahead of it stop being on your branch (they stay recoverable until git eventually prunes them). Pick how much of your working state to keep below.",
  confirm: "Reset HEAD",
  arm_say_hash: 'Reset HEAD to any commit — paste a hash, pick a mode, type "reset" to arm.',
  title_hash: "Reset HEAD to a commit",
  desc_hash:
    "Moves the current branch (HEAD) to the commit you name below. Accepts a full or abbreviated hash, or any ref like HEAD~2 or origin/main — I resolve it and refuse anything that isn't a commit.",
  commit_to_reset: "Commit to reset to",
  hash_placeholder: "commit hash or ref — a1b2c3d, HEAD~2, origin/main",
  enter_hash: "Enter a commit hash or ref to reset to.",
  demo_reset: "Reset HEAD to {label} ({mode}, demo).",
  resetting: "Resetting HEAD to {label}…",
  reset_done: "Reset HEAD to {label}.",
  reset_failed: "Couldn't reset to {label}.",
  reset_failed_e: "Reset failed — {error}",
};
