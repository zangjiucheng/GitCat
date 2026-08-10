// “杂项”一组 Rust 模块的后端（应用自撰）错误/状态字符串（PER-82）：git 配置、
// 文件历史、plumbing 试验台、fsck/悬空对象恢复、blame、WSL 路由、内置终端、
// 安全管理器（撤销/快照）、更新器、reflog 救援以及 rerere。键名对应
// `err_misc.<key>`，由 `be()`（见 src/i18n/i18n.svelte.ts）从 Rust 的
// `ierr`/`ierrp` 机制中查找。英文为最终来源，中文为尽力翻译。
export default {
  // 打开仓库失败（小写/首字母大写两种写法，与各调用点原文保持一致）。
  cannot_open_repo: "无法打开仓库：{detail}",
  cannot_open_repo_cap: "无法打开仓库：{detail}",
  not_a_valid_commit: "不是有效的提交：{rev}（{detail}）",
  could_not_run_git: "无法运行 git：{detail}",
  git_exited_with_status: "git 退出，状态码 {code}",

  // file_history.rs
  path_does_not_exist: "{path} 在 {short} 处不存在。",
  file_is_a_directory: "{path} 在 {short} 处是一个目录 —— 请选择一个文件。",
  no_file_for_history: "没有要查看历史的文件。",
  path_nul: "路径包含内嵌的 NUL 字节。",

  // blame.rs
  file_is_binary_no_blame: "{path} 是二进制文件 —— 无法对二进制内容进行逐行溯源（blame）。",

  // plumbing.rs
  enter_rev_to_inspect: "请输入要查看的 rev、sha 或引用。",
  not_a_valid_rev: "在此仓库中不是有效的 rev：{rev}（{detail}）",
  resolved_not_a_tag: "解析出的对象声称是 Tag 类型，但实际并非如此。",
  unsupported_object_kind: "不支持的对象类型（{kind}），对应 {rev} —— 应为提交、树、blob 或标签。",

  // git_config.rs —— 校验
  config_key_empty: "配置键不能为空。",
  config_key_malformed: '{key} 看起来不像是一个 git 配置键（应形如 "section.key"）。',
  config_key_charset:
    "{key} 含有 git 配置键在此处不允许的字符 —— 每个以点分隔的部分只能使用字母、数字、'-' 和 '_'。",
  value_looks_like_flag: "拒绝一个看起来像命令行选项的值：{value}",

  // git_config.rs —— 设置/取消设置的结果（作用域写入键名，作为整句一起翻译）。
  config_set_local: "已设置 {key} = {value}（本仓库）。",
  config_set_global: "已设置 {key} = {value}（全局）。",
  config_unset_local: "已取消设置 {key}（本仓库）。",
  config_unset_global: "已取消设置 {key}（全局）。",
  config_already_unset_local: "{key} 原本就未设置（本仓库）。",
  config_already_unset_global: "{key} 原本就未设置（全局）。",

  // wsl.rs
  wsl_status_timed_out: "WSL 状态检查在 {timeout} 后超时 —— 请在终端运行 `wsl --shutdown`，然后重新打开此仓库",
  unexpected_rev_list_output: "`git rev-list --left-right --count` 的输出异常：{output}",
  wsl_ahead_behind_timed_out: "WSL 领先/落后检查在 {timeout} 后超时",

  // terminal.rs
  terminal_session_ended: "该终端会话已结束。",

  // updater.rs
  bad_nightly_endpoint: "无效的 nightly 更新地址：{detail}",
  updater_endpoint_error: "更新地址出错：{detail}",
  updater_init_failed: "更新器初始化失败：{detail}",
  update_check_failed: "检查更新失败：{detail}",

  // reflog.rs
  restore_needs_worktree: "恢复需要一个工作区（不支持裸仓库）",
  cannot_verify_clean_refusing_restore: "无法确认工作区是否干净，拒绝恢复：{detail}",
  worktree_has_uncommitted_restore: "工作区有未提交的更改 —— 请先提交或贮藏后再恢复。",
  cannot_read_head_reflog_cap: "无法读取 HEAD 的 reflog：{detail}",
  cannot_read_head_reflog: "无法读取 HEAD 的 reflog：{detail}",
  reflog_stale_selection_one: "{ref} 已不存在 —— reflog 现在有 {count} 条记录。拒绝恢复到已失效的选择。",
  reflog_stale_selection_many: "{ref} 已不存在 —— reflog 现在有 {count} 条记录。拒绝恢复到已失效的选择。",
  restore_aborted_snapshot_failed: "恢复已中止 —— 无法先为当前状态创建快照：{detail}",
  restore_failed: "恢复失败：{detail}",
  restored_to: "已恢复到 {ref}（{sha}）。",

  // safety.rs —— 快照 / 撤销
  snapshot_created_not_found: "已创建快照，但未能找到",
  nothing_to_undo: "没有可撤销的操作 —— 还没有任何快照。",
  undo_needs_worktree: "撤销需要一个工作区（不支持裸仓库）",
  cannot_verify_clean_refusing_undo: "无法确认工作区是否干净，拒绝撤销：{detail}",
  worktree_has_uncommitted_undo: "工作区有未提交的更改 —— 请先提交或贮藏后再撤销。",
  undo_aborted_snapshot_failed: "撤销已中止 —— 无法先为当前状态创建快照：{detail}",
  undo_failed_restoring_head: "撤销失败，无法恢复 HEAD：{detail}",
  undo_failed: "撤销失败：{detail}",
  undo_failed_detaching_head: "撤销失败，无法分离 HEAD：{detail}",
  couldnt_stash_before_undo: "撤销前无法贮藏你的更改 —— {detail}",

  // rerere.rs
  rerere_enabled: "已为本仓库启用 rerere。",
  rerere_disabled: "已为本仓库禁用 rerere。",
};
