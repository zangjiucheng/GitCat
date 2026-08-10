// Mainline-parent chooser (cherry-pick a merge commit). Keys become `mainlinepicker.<key>`.
export default {
  title: "Cherry-pick a merge commit",
  merge_desc:
    " is a merge, so git needs to know which parent is the mainline — the changes it brings in are measured against that parent.",
  role_mainline: "the branch merged into (mainline — usually this one)",
  role_merged_in: "the branch merged in",
  role_parent: "parent {n}",
  tama_alt: "Tama, curious",
};
