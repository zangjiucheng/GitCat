// 外部工具、代码搜索与 pickaxe 模块的后端（应用自撰）错误/状态字符串（PER-82）。
// 键名对应 `err_tools.<key>`，由 `be()`（见 src/i18n/i18n.svelte.ts）从 Rust 的
// `ierr`/`ierrp` 机制中查找。英文为最终来源，中文为尽力翻译。
export default {
  // code_search.rs / pickaxe.rs / tool_settings.rs 共用
  cannot_open_repo: "无法打开仓库：{detail}",
  cannot_open_repo_cap: "无法打开仓库：{detail}",
  not_a_valid_commit: "不是有效的提交：{rev}（{detail}）",
  could_not_run_git: "无法运行 git：{detail}",
  git_exited_with_status: "git 退出，状态码 {code}",
  enter_search_text: "请输入要搜索的内容。",
  search_text_nul: "搜索文本包含内嵌的 NUL 字节。",

  // pickaxe.rs
  path_does_not_exist: "{path} 在 {short} 处不存在。",
  unknown_pickaxe_mode: '未知的 pickaxe 模式：{mode}（应为 "added-removed"、"diff-match" 或 "author"）。',
  path_nul: "路径包含内嵌的 NUL 字节。",

  // tool_settings.rs —— 持久化
  could_not_resolve_config_dir: "无法解析应用配置目录：{detail}",
  could_not_create_config_dir: "无法创建应用配置目录：{detail}",
  could_not_read: "无法读取 {path}：{detail}",
  could_not_serialize: "无法序列化：{detail}",
  could_not_write: "无法写入 {path}：{detail}",
  could_not_finalize: "无法完成写入 {path}：{detail}",

  // tool_settings.rs —— 校验
  tool_name_charset: "工具名称 {name} 只能包含字母、数字、'-' 和 '_'。",
  tool_id_required: "工具 id 是必填项。",
  tool_id_charset: "工具 id {id} 必须以小写字母或数字开头，且只能包含小写字母、数字和 '-'。",
  tool_name_required: "工具名称是必填项。",
  tool_command_required: "工具命令是必填项。",
  no_tool_with_id: "不存在 id 为 {id} 的 {kind} 工具。",
  no_value_given: "未提供值。",
  value_looks_like_flag: "拒绝一个看起来像选项标志的值：{value}",
  value_illegal_char: "值包含非法的 NUL/换行符。",

  // tool_settings.rs —— 提交信息生成
  no_commit_command:
    "尚未设置提交信息命令。请在 工具 ▸ 外部工具 中添加一个（例如 `aicommit`）—— GitCat 会运行它并把输出填入此处；它本身不连接任何 AI。",
  could_not_run_commit_command: "无法运行提交信息命令：{detail}",
  interactive_command:
    '该命令是交互式的 —— 它尝试提示输入。GitCat 以非交互方式运行它并从其输出中读取信息，因此请配置一个只“打印”提交信息然后退出的命令（例如把暂存的 diff 通过管道传给模型：`git diff --staged | ollama run <model> "write a commit message"`，或者一个小脚本）。像 aicommit2/opencommit 这样的交互式“生成并提交”工具会自己接管整个提交流程 —— 请使用它们的 git 钩子，而不是这个输入框。',
  commit_command_failed: "提交信息命令失败：{detail}",
  commit_command_no_output: "提交信息命令没有产生任何输出。",

  // tool_settings.rs —— diff/合并工具调用
  no_diff_tool: "尚未配置外部 diff 工具。请通过 工具 ▸ 外部工具… 设置一个。",
  no_merge_tool: "尚未配置外部合并工具。请通过 工具 ▸ 外部工具… 设置一个。",
  could_not_launch_difftool: "无法启动 git difftool：{detail}",
  rev_range_both_or_neither: "fromRev 和 toRev 必须同时提供，或都不提供。",
  range_and_staged_exclusive: "指定的修订范围与 `staged` 互斥。",
  filename_double_quote:
    "{file} 包含双引号字符，git 自身的 mergetool 集成无法可靠处理它 —— 请改为手动解决此文件。",
  cannot_inspect_repo_state: "无法检查仓库状态：{detail}",
  not_in_conflict_op:
    "当前不处于 cherry-pick、合并、变基、还原、贮藏、压缩合并或补丁应用冲突中（仓库状态：{op}）。请在命令行使用 git 解决 {op} 冲突。",
  could_not_run_mergetool: "无法运行 git mergetool：{detail}",
  tool_changed_nothing:
    "外部工具成功退出，但实际上并未修改 {file} —— 没有解决任何冲突。git 可能仍在索引中将其标记为已解决；请使用“中止”来完全恢复原始冲突，而不是继续。",
  resolved_all_done: "已使用外部工具解决 {file}。所有冲突均已解决 —— 点击“继续”以完成。",
  resolved_some_remaining: "已使用外部工具解决 {file}。仍有 {remaining} 个文件存在冲突。",
  tool_no_success: "外部工具未报告 {file} 已成功解决。",
};
