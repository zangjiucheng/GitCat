// 对比两个提交的浮层（#49）。键会变成 `rangesummary.<key>`。
export default {
  title: "对比",
  commits: "中间有 {n} 个提交",
  diverged: "已分叉 —— 领先 {ahead}，落后 {behind}",
  fork_point: "分叉于 {sha}",
  no_common_ancestor: "这两个提交没有共同历史 —— 不存在共同祖先。",
  same_commit: "是同一个提交 —— 中间没有任何提交。",
  files_changed: "{n} 个文件",
  truncated: "只显示前 {n} 个 —— 实际范围更长。",
};
