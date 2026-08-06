// 把 HEAD 重置到某个提交。键会变成 `resethead.<key>`。
export default {
  open_repo_first: "请先打开一个仓库。",
  reset_mode_head: "重置模式",
  mode_soft: "<b>Soft(软)</b> —— 只移动 HEAD;保留暂存区和所有工作区改动。",
  mode_mixed:
    "<b>Mixed(混合)</b> —— 移动 HEAD 并取消暂存,但保留你的工作区文件 <em>(git 的默认值)</em>。",
  mode_hard:
    "<b>Hard(硬)</b> —— 移动 HEAD 并<b>丢弃所有已暂存和未暂存的改动</b>。未提交的工作会丢失且无法撤销。",
  note_snapshot: "我会先给 HEAD 当前的位置拍一张快照,所以 ⌘Z/撤销 能把它移回来 —— 前提是你的工作区是干净的。",
  note_hard: "<b>hard</b> 重置还会丢弃未提交的改动,而这些并不在快照的保护范围内。",
  arm_say_known: "正在把 HEAD 重置到 {sha} —— 输入短 sha 以解锁。",
  title_known: "把 HEAD 重置到 {sha}",
  desc_known:
    "把当前分支(HEAD)移动到 {sha}{subject}。当前领先于它的提交会不再属于你的分支(在 git 最终清理它们之前仍可恢复)。在下方选择要保留多少工作状态。",
  confirm: "重置 HEAD",
  arm_say_hash: '把 HEAD 重置到任意提交 —— 粘贴哈希、选择模式,输入 "reset" 以解锁。',
  title_hash: "把 HEAD 重置到某个提交",
  desc_hash:
    "把当前分支(HEAD)移动到你在下方指定的提交。接受完整或简写的哈希,也接受 HEAD~2、origin/main 之类的引用 —— 我会解析它,并拒绝任何不是提交的东西。",
  commit_to_reset: "要重置到的提交",
  hash_placeholder: "提交哈希或引用 —— a1b2c3d、HEAD~2、origin/main",
  enter_hash: "请输入要重置到的提交哈希或引用。",
  demo_reset: "已把 HEAD 重置到 {label}({mode},演示)。",
  resetting: "正在把 HEAD 重置到 {label}……",
  reset_done: "已把 HEAD 重置到 {label}。",
  reset_failed: "无法重置到 {label}。",
  reset_failed_e: "重置失败 —— {error}",
};
