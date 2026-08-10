// Plumbing playground strings. Keys become `plumbing.<key>`. Raw git object
// field labels (tree/parents/target) are left as literal text in the view —
// they name the git object model, not translatable prose.
export default {
  tama_alt: "Tama, curious",
  title: "Plumbing — inspect a raw object",
  subtitle: "Type a rev, sha, branch, or tag to see the raw commit, tree, blob, or tag object it resolves to.",
  input_placeholder: "rev, sha, branch, tag… e.g. HEAD~2, HEAD:path/to/file, a1b2c3d",
  inspect_btn: "Inspect",
  inspecting: "Inspecting…",
  author: "Author",
  committer: "Committer",
  tagger: "Tagger",
  no_tagger: "(no tagger recorded)",
  root_commit: "(root commit — no parents)",
  empty_tree: "empty tree",
  size: "size",
  binary: "binary",
  yes: "yes",
  no: "no",
  binary_not_shown: "Binary content not shown.",
  truncated: "(truncated)",
  empty_hint: "Type a rev, sha, branch, or tag above and press Inspect to see the raw commit, tree, blob, or tag object it resolves to.",
  err_enter_rev: "Enter a rev, sha, or ref to inspect.",
  open_repo_first: "Open a repository first.",
};
