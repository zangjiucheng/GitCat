// err_history 的简体中文翻译（PER-82）。英文为准；此处缺失的键会自动回退到英文。
// {detail}/{ref} 等占位符承载的是逐字透传的 git stderr 或 io/git2 细节，本身不翻译。
export default {
  // 共用的 git 运行 / 打开仓库 / 快照 / 版本校验失败。
  could_not_run_git: "无法运行 git：{detail}",
  cannot_open: "无法打开仓库：{detail}",
  snapshot_failed: "安全快照失败，已中止：{detail}",
  revision_looks_like_flag: "拒绝使用看起来像命令行参数的版本：{rev}",
  revision_control_char: "版本包含控制字符。",

  // 变基。
  no_rebase_target: "没有可供变基的目标。",
  cannot_resolve_revision: "无法解析版本 {rev}：{detail}",
  revision_not_commit: "版本 {rev} 不是一个提交：{detail}",
  cannot_walk_from_head: "无法从 HEAD 遍历：{detail}",
  cannot_resolve_target: "无法解析目标：{detail}",
  bad_commit_id: "无效的提交 ID {sha}：{detail}",
  cannot_find_commit: "找不到提交 {sha}：{detail}",
  could_not_create_todo_dir: "无法创建 rebase-todo 目录：{detail}",
  could_not_write_todo: "无法写入预计算的 todo：{detail}",
  rebase_in_progress: "已有一个变基正在进行——请先解决或中止它。",
  no_rebase_to_continue: "没有正在进行的变基可继续。",
  no_rebase_to_skip: "没有正在进行的变基可跳过其提交。",
  nothing_to_rebase: "无需变基——HEAD 与目标之间没有任何提交。",
  unknown_rebase_action: "未知的变基操作：{action}",
  first_commit_squash: "计划中的第一个提交不能是 squash/fixup——它前面没有可合并进去的提交。",
  plan_out_of_date: "此计划已与仓库不同步——请刷新后重试。",

  // 合并（单个 / 压缩 / 多分支）。
  no_commit_to_merge: "没有可合并的提交。",
  merge_in_progress: "已有一个合并正在进行——请先解决或中止它。",
  unknown_merge_strategy: '未知的合并策略 {strategy}（应为 "auto"、"no-ff" 或 "ff-only"）。',
  no_merge_to_continue: "没有正在进行的合并可继续。",
  other_op_in_progress: "已有另一项操作（合并/变基/拣选/回退）正在进行——请先解决或中止它。",
  unresolved_conflicts_already: "已存在未解决的冲突——请先解决或中止它们。",
  no_squash_conflict_to_abort: "没有正在进行的压缩合并冲突可中止。",
  cannot_resolve_snapshot: "无法解析冲突前的快照 {ref}：{detail}",
  no_squash_conflict_to_continue: "没有正在进行的压缩合并冲突可继续。",
  unknown_merge_mode: '未知的合并模式 {mode}（应为 "octopus" 或 "sequential"）。',
  pick_at_least_two: "请至少选择两个分支进行合并。",
  sequential_queue_in_progress: "已有一个顺序合并队列正在进行——请先继续或中止它。",
  no_sequential_queue: "没有正在进行的顺序合并队列。",
  finish_resolving_first: "请先完成当前合并的冲突解决。",

  // 回退。
  no_commit_to_revert: "没有可回退的提交。",
  revert_in_progress: "已有一个回退正在进行——请先解决或中止它。",
  no_revert_to_continue: "没有正在进行的回退可继续。",

  // 拣选（cherry-pick）。
  no_commit_to_cherry_pick: "没有可拣选的提交。",
  cannot_resolve: "无法解析 {rev}：{detail}",
  cannot_read_commit: "无法读取提交 {rev}：{detail}",
  cherry_pick_in_progress: "已有一个拣选正在进行——请先解决或中止它。",
  no_cherry_pick_to_continue: "没有正在进行的拣选可继续。",

  // 标签创建 / 删除。
  tag_name_empty: "标签名称为空。",
  tag_name_flag: "拒绝使用看起来像命令行参数的标签名称：{name}",
  tag_name_control: "标签名称包含非法的空白/控制字符：{name}",
  tag_name_illegal_char: "标签名称包含非法字符 '{ch}'：{name}",
  tag_name_invalid: "不是有效的标签名称：{name}",
  target_empty: "目标为空。",
  target_flag: "拒绝使用看起来像命令行参数的目标：{rev}",
  target_control: "目标包含控制字符。",
  tag_does_not_exist: "标签 {name} 不存在。",
  refuse_delete_tag_backup: "拒绝删除标签 {name}——无法先对其进行备份：{detail}",
};
