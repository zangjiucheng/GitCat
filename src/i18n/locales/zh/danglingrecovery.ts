// 游离提交找回文案。键会变成 `danglingrecovery.<key>`。
export default {
  tama_alt: "Tama,好奇中",
  title: "游离提交 — 找回丢失的提交",
  subtitle:
    "<code>git fsck</code> 找到的、已经没有任何 branch 或 tag 指向的提交 — 常见于 hard reset、amend、被丢弃的 rebase 提交、删除的 branch…… — 在被垃圾回收之前都还在。它们中的大多数在某个 reflog 里仍有踪迹(尤其刚出错时,也值得看看 Reflog 救援);这个列表还能找出 reflog 从未记录过的提交,比如用底层 plumbing 命令创建的那些。找回其中一个会在它上面新建一个分支;你当前的分支和 HEAD 绝不会被改动。",
  loading_fsck: "正在运行 git fsck…… 在大仓库上可能需要一点时间。",
  empty: "没有找到游离提交 — 没有需要找回的内容。",
  recovering_hint: "正在找回 {sha} · 回车创建,Esc 取消",
  create_branch: "创建分支",
  no_message: "(无提交信息)",
  recover_as_branch: "找回为新分支…",
  truncated: "…… 已截断(达到上限)",
  err_fsck: "无法运行 git fsck。",
  err_fsck_reason: "无法运行 git fsck — {reason}",
  recovered_demo: "已将 {sha} 找回为 {name}(演示)。",
  open_repo_first: "请先打开一个仓库。",
  say_recovering: "正在将 {sha} 找回为 {name}…",
  recovered_as: "已找回为 {name}。",
  err_could_not_recover: "无法找回 {sha}。",
  err_recover_reason: "找回失败 — {reason}",
};
