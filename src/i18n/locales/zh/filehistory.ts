// 单文件历史弹窗文案。键会变成 `filehistory.<key>`。
export default {
  heading: "History(文件历史)",
  renamed_from: "重命名自",
  as_of: "截至",
  follows_renames: "跟随重命名",
  caveat: "在跨越 merge 的重命名附近可能不完整(git 的已知限制)",
  caveat_title:
    "当一个分支上的重命名后来通过 merge 与另一个分支上不相关的改动合并时,git 自带的 --follow 可能会跟丢文件更早的历史 — 这是 git 的已知限制,而非 GitCat 的 bug。",
  loading: "正在加载历史…",
  empty: "没有找到该文件的历史",
  jump_to: "跳转到 {sha}",
  truncated: "… 已截断(历史达到上限)",
  open_repo_first: "请先打开一个仓库。",
  err_load: "无法加载该文件的历史。",
  err_unavailable: "文件历史不可用 — {reason}",
  warn_not_loaded: "该提交未加载到当前图中",
};
