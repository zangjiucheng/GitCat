// 合并提交的主线父选择器。键会变成 `mainlinepicker.<key>`。
export default {
  title: "Cherry-pick 一个 merge 提交",
  merge_desc:
    " 是一个 merge 提交,所以 git 需要知道哪个 parent 是主线 —— 它带入的改动是相对那个 parent 计算的。",
  role_mainline: "被合并到的分支(主线,通常选这个)",
  role_merged_in: "被合并进来的分支",
  role_parent: "父提交 {n}",
  tama_alt: "Tama,好奇",
};
