// Plumbing 探查台文案。键会变成 `plumbing.<key>`。原始 git 对象字段名
// (tree/parents/target)在视图里保留为字面文本 —— 它们指代 git 对象模型
// 本身,不是可翻译的文案。
export default {
  tama_alt: "Tama,好奇中",
  title: "Plumbing — 查看原始对象",
  subtitle: "输入 rev、sha、branch 或 tag,查看它解析到的原始 commit、tree、blob 或 tag 对象。",
  input_placeholder: "rev、sha、branch、tag… 例如 HEAD~2、HEAD:path/to/file、a1b2c3d",
  inspect_btn: "查看",
  inspecting: "正在查看…",
  author: "作者",
  committer: "提交者",
  tagger: "标签创建者",
  no_tagger: "(未记录标签创建者)",
  root_commit: "(根提交 — 没有父提交)",
  empty_tree: "空 tree",
  size: "大小",
  binary: "二进制",
  yes: "是",
  no: "否",
  binary_not_shown: "二进制内容不予显示。",
  truncated: "(已截断)",
  empty_hint: "在上方输入 rev、sha、branch 或 tag 并点击“查看”,即可看到它解析到的原始 commit、tree、blob 或 tag 对象。",
  err_enter_rev: "请输入要查看的 rev、sha 或 ref。",
  open_repo_first: "请先打开一个仓库。",
};
