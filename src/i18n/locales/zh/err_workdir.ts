// err_workdir 的简体中文翻译。英文是权威来源（en/err_workdir.ts）；缺失的键会
// 自动回退到英文。占位符 {name} 必须与英文一致，`stash@{{index}}` 的双大括号
// 写法也必须保留，插值才能正确工作。
export default {
  // 共用辅助函数（workdir.rs + git_write.rs）。
  could_not_run_git: "无法运行 git：{detail}",
  cannot_open_repo: "无法打开仓库：{detail}",
  safety_snapshot_failed: "安全快照失败，已中止：{detail}",
  // 路径校验。
  file_path_empty: "文件路径为空。",
  file_path_looks_like_flag: "拒绝看起来像命令行参数的文件路径：{file}",
  file_path_illegal_char: "文件路径包含非法的 NUL/CR/LF 字符：{file}",
  // 文件差异。
  no_staged_changes_found: "未找到 {file} 的已暂存改动。",
  no_unstaged_changes_found: "未找到 {file} 的未暂存改动。",
  // 丢弃（文件 + 撤销未暂存的重命名）。
  could_not_back_up_before_discarding: "丢弃前无法备份 {file}，已拒绝：{detail}",
  cannot_restore_old_path: "无法恢复旧路径 {old_path}：{detail}",
  refusing_old_path_exists_no_backup: "已拒绝：{old_path} 已存在，且在恢复前无法备份：{detail}",
  could_not_restore_path: "无法恢复 {old_path}：{detail}",
  restored_but_could_not_remove: "已恢复 {old_path}，但无法移除 {new_path}：{detail}",
  // 按行/按块暂存。
  stale_diff: "此文件的差异自你上次查看后已发生变化——请刷新后重试。",
  typechange_line_staging_unsupported:
    "{file} 的类型已改变（文件 <-> 符号链接等）——不支持按行暂存；请改为暂存/丢弃整个文件。",
  binary_line_staging_unsupported: "{file} 是二进制文件——不支持按行暂存；请改为暂存/丢弃整个文件。",
  invalid_selected_line_kind: '无效的所选行类型 {kind}——只能选择 "+"/"-" 行。',
  no_lines_selected: "未选择任何行。",
  partial_no_newline_unsupported:
    "{file} 的最后一行在此改动的至少一侧没有以换行符结尾——该处不支持部分行选择。请选择整个块（或整个文件）。",
  could_not_write_patch_stdin: "无法将补丁写入 git apply 的标准输入：{detail}",
  // 提交。
  commit_message_empty: "提交信息为空。",
  // 贮藏 保存 / 应用 / 弹出 / 丢弃。
  nothing_to_stash: "没有可贮藏的内容——工作区是干净的。",
  stash_changed_since:
    "stash@{{index}} 自你上次查看后已发生变化（原为 {expected}，现为 {actual}）——请刷新贮藏列表后重试。",
  stash_no_longer_exists: "stash@{{index}} 已不存在——请刷新贮藏列表后重试。",
  another_op_in_progress: "已有另一项操作（合并/变基/拣选）正在进行——请先解决或中止它。",
  unresolved_stash_conflicts: "上一次贮藏应用/弹出仍有未解决的冲突——请先解决或中止它们。",
  stash_apply_conflict_one:
    "应用 {stash_ref} 时在 {n} 个文件中遇到冲突。请在冲突解决器中解决，然后点击“继续”——或“中止”。贮藏条目会保留。",
  stash_apply_conflict_other:
    "应用 {stash_ref} 时在 {n} 个文件中遇到冲突。请在冲突解决器中解决，然后点击“继续”——或“中止”。贮藏条目会保留。",
  stash_pop_conflict_one:
    "弹出 {stash_ref} 时在 {n} 个文件中遇到冲突。请在冲突解决器中解决，然后点击“继续”——或“中止”。贮藏条目会保留。",
  stash_pop_conflict_other:
    "弹出 {stash_ref} 时在 {n} 个文件中遇到冲突。请在冲突解决器中解决，然后点击“继续”——或“中止”。贮藏条目会保留。",
  refusing_to_drop_no_backup: "拒绝丢弃 {stash_ref}——无法先对其进行备份：{detail}",
  // 贮藏冲突的 中止 / 继续。
  no_stash_conflict_to_abort: "没有正在进行的贮藏冲突可供中止。",
  could_not_resolve_snapshot: "无法解析冲突前的快照 {backup_ref}：{detail}",
  no_stash_conflict_to_continue: "没有正在进行的贮藏冲突可供继续。",
  still_conflicted_one: "仍有 {n} 个文件存在冲突。请解决它们，然后点击“继续”——或“中止”。",
  still_conflicted_other: "仍有 {n} 个文件存在冲突。请解决它们，然后点击“继续”——或“中止”。",
  could_not_drop_popped_stash: "冲突已解决，但无法丢弃已弹出的贮藏条目：{detail}",
  // 贮藏 应用/弹出 的撤销。
  unresolved_conflicts_use_resolver:
    "贮藏应用/弹出仍有未解决的冲突——请通过冲突解决器（继续/中止）来处理，而不是使用撤销。",
  working_tree_already_clean: "工作区已经是干净的——没有可撤销的内容。",
  // 分支名 / 起点 校验（git_write.rs）。
  branch_name_empty: "分支名为空。",
  branch_name_looks_like_flag: "拒绝看起来像命令行参数的分支名：{name}",
  branch_name_illegal_whitespace: "分支名包含非法的空白/控制字符：{name}",
  branch_name_illegal_char: "分支名包含非法字符 '{ch}'：{name}",
  not_valid_branch_name: "不是有效的分支名：{name}",
  start_point_empty: "起点为空。",
  start_point_looks_like_flag: "拒绝看起来像命令行参数的起点：{rev}",
  start_point_control_char: "起点包含控制字符。",
  // 分支命令（git_write.rs）。
  unknown_reset_mode: "未知的重置模式 {mode}（应为 soft、mixed 或 hard）。",
  cannot_resolve_to_commit: "无法将 {target} 解析为一个提交：{detail}",
  cannot_delete_current_branch: "无法删除 {name}：它是当前分支。请先切换到其他分支。",
};
