// Dangling-commit recovery strings. Keys become `danglingrecovery.<key>`.
export default {
  tama_alt: "Tama, curious",
  title: "Dangling Commits — recover a lost commit",
  subtitle:
    "Commits <code>git fsck</code> finds with no branch or tag pointing at them anymore — after a hard reset, an amend, a dropped rebase commit, a deleted branch, … — until garbage collected. Most of these still have a trace in some reflog (often worth checking Reflog Rescue too, especially right after a mistake); this list also catches commits a reflog never recorded at all, like ones made with raw plumbing commands. Recovering one creates a brand-new branch at it; your current branch and HEAD are never touched.",
  loading_fsck: "Running git fsck… this can take a moment on a large repo.",
  empty: "No dangling commits found — nothing to recover.",
  recovering_hint: "recovering {sha} · Enter to create, Esc to cancel",
  create_branch: "Create branch",
  no_message: "(no message)",
  recover_as_branch: "Recover as new branch…",
  truncated: "… truncated (capped)",
  err_fsck: "Could not run git fsck.",
  err_fsck_reason: "Could not run git fsck — {reason}",
  recovered_demo: "Recovered {sha} as {name} (demo).",
  open_repo_first: "Open a repository first.",
  say_recovering: "Recovering {sha} as {name}…",
  recovered_as: "Recovered as {name}.",
  err_could_not_recover: "Could not recover {sha}.",
  err_recover_reason: "Recover failed — {reason}",
};
