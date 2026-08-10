// Force-push danger flows. Keys become `forcepush.<key>`.
export default {
  open_repo_first: "Open a repository first.",
  no_branch: "HEAD isn't on a branch — nothing to force-push.",
  arm_say_lease:
    "Force-pushing {branch} — type the branch name to arm it. This refuses if the remote moved since my last fetch.",
  title_lease: "Force push (safe) — {branch}",
  desc_lease:
    "This overwrites {branch}'s position on the remote with your local history — the usual fix after rebasing or amending a commit you'd already pushed. Unlike a raw force, it refuses instead of overwriting if the remote has anything this repo doesn't already know about (e.g. someone else pushed since your last fetch).",
  lose_lease:
    "<h5>What happens</h5><ul><li>Overwrites <code>{branch}</code> on the remote to match your local branch</li><li>Refuses cleanly, with no changes made, if the remote moved since your last fetch — fetch and reconcile first, then retry</li><li>Nothing local changes — HEAD, your branch, and your working tree are untouched</li></ul>",
  note_lease:
    "This only touches the REMOTE — there's nothing local for ⌘Z/Undo to protect here. If it succeeds and it did overwrite prior remote commits, they have no in-app recovery path.",
  confirm_lease: "Force push",
  arm_say_override:
    "Force-pushing {branch} — type the branch name to arm it. This overwrites the remote NO MATTER WHAT is there.",
  title_override: "Force push — override remote — {branch}",
  desc_override:
    "This unconditionally overwrites {branch} on the remote with your local history, even if someone else has pushed commits your local repo doesn't have. Those commits can be permanently discarded with NO recovery path from inside GitCat — only use this if you're certain nobody else's work is on the line.",
  lose_override:
    "<h5>What happens</h5><ul><li>Overwrites <code>{branch}</code> on the remote to match your local branch, no matter what is currently there</li><li>Any commits on the remote that your local repo doesn't have are discarded, permanently, the moment this succeeds</li><li>Nothing local changes — HEAD, your branch, and your working tree are untouched</li></ul>",
  note_override:
    "This can destroy OTHER PEOPLE'S work on the remote with no way back from inside GitCat — Safety Manager/Undo only ever protects this repo's own LOCAL refs, never anything already pushed. Prefer Force Push (Safe) unless you specifically need to override someone else's changes.",
  confirm_override: "Force push (override)",
  pushing: "Force-pushing {branch}…",
  pushed: "Force-pushed {branch}.",
  demo_pushed: "Force-pushed {branch} (demo).",
  failed: "Force push failed.",
  failed_e: "Force push failed — {error}",
};
