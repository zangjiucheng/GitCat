// Tama's line when a destructive/rewrite operation is cancelled before it runs
// (emitted by the `mutation.cancel` event in legacy/main.ts's TamaMascot).
// Keys become `mutation.<key>`.
export default {
  cancel: "Cancelled — nothing was changed.",
  caution: "Heads up — this rewrites {cnt}. Backup {ref} saved first.",
  destructive: "{label} can't be undone. Backup {ref} is pinned — type the ref name to go on.",
  commit_one: "{n} commit",
  commit_many: "{n} commits",
  commit_some: "a few commits",
  this_label: "This",
};
