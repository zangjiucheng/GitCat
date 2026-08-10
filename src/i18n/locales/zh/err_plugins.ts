// 插件系统的后端（应用自撰）错误/状态字符串（PER-82）：磁盘上的注册表
// （plugin_registry.rs）、命令/钩子执行器（plugin_exec.rs）以及内嵌的 Luau
// 运行时（plugin_lua.rs）。键名对应 `err_plugins.<key>`，由 `be()`
//（见 src/i18n/i18n.svelte.ts）从 Rust 的 `ierr`/`ierrp` 机制中查找。
// 英文为最终来源，中文为尽力翻译。
export default {
  // plugin_registry.rs —— 持久化（plugins.json）
  could_not_resolve_config_dir: "无法解析应用配置目录：{detail}",
  could_not_create_config_dir: "无法创建应用配置目录：{detail}",
  could_not_read: "无法读取 {path}：{detail}",
  could_not_serialize: "无法序列化：{detail}",
  could_not_write: "无法写入 {path}：{detail}",
  could_not_finalize: "无法完成写入 {path}：{detail}",

  // plugin_registry.rs —— 清单校验
  plugin_id_invalid:
    "插件 id {id} 无效 —— 它必须以小写字母或数字开头，且随后只能包含小写字母、数字和 '-'。",
  missing_name: "插件清单缺少非空的 name。",
  missing_version: "插件清单缺少非空的 version。",
  cmd_exactly_one_both:
    "插件命令 {id} 必须只声明非空的 `run`（shell）或非空的 `handler`（Luau）之一 —— 但它两者都声明了。",
  cmd_exactly_one_neither:
    "插件命令 {id} 必须只声明非空的 `run`（shell）或非空的 `handler`（Luau）之一 —— 但它两者都未声明。",
  cmd_handler_no_lua: "插件命令 {id} 声明了 Luau `handler`，但插件并未声明 `lua` 脚本文件。",
  hook_exactly_one_both:
    "针对事件 {event} 的插件钩子必须只声明非空的 `run`（shell）或非空的 `handler`（Luau）之一 —— 但它两者都声明了。",
  hook_exactly_one_neither:
    "针对事件 {event} 的插件钩子必须只声明非空的 `run`（shell）或非空的 `handler`（Luau）之一 —— 但它两者都未声明。",
  hook_handler_no_lua: "针对事件 {event} 的插件钩子声明了 Luau `handler`，但插件并未声明 `lua` 脚本文件。",
  tama_voice_pitch_not_finite:
    "插件 tama 的 voicePitch {pitch} 不是有限数值 —— 它必须是有限值（有限但超出范围的值会被钳制到 [{min}, {max}]）。",
  tama_pose_key_unknown: "插件 tama 的姿势键 {key} 不是内置姿势 —— 它必须是 {keys} 之一。",
  tama_pose_unsafe_path:
    "插件 tama 姿势 {key} 的资源路径 {path} 不安全 —— 它必须是插件目录内的相对路径（不得以 '/' 开头，也不得包含 '..'）。",
  panel_id_invalid:
    "插件面板 id {id} 无效 —— 它必须以小写字母或数字开头，且随后只能包含小写字母、数字和 '-'。",
  panel_id_duplicate: "插件存在重复的面板 id {id} —— 面板 id 在同一插件内必须唯一。",
  panel_missing_title: "插件面板 {id} 缺少非空的标题。",
  panel_text_empty: "插件面板 {id} 有一个文本项（text）的内容为空。",
  panel_heading_empty: "插件面板 {id} 有一个标题项（heading）的内容为空。",
  panel_button_empty_label: "插件面板 {id} 有一个按钮的标签为空。",
  panel_button_missing_command: "插件面板 {id} 有一个按钮引用了命令 {command}，而该命令不属于此插件。",
  panel_command_output_empty_label: "插件面板 {id} 有一个 command-output 项的标签为空。",
  panel_command_output_missing_command:
    "插件面板 {id} 有一个 command-output 引用了命令 {command}，而该命令不属于此插件。",

  // plugin_registry.rs —— 清单读取（大小上限、解析）
  manifest_not_regular_file: "插件清单 {path} 不是常规文件。",
  manifest_too_large: "插件清单 {path} 过大（{bytes} 字节；上限为 {limit} 字节）。",
  manifest_too_large_limit: "插件清单 {path} 过大（上限 {limit} 字节）。",
  manifest_invalid: "{path} 不是有效的插件清单：{detail}",

  // plugin_registry.rs —— 安装 / 启用 / 移除 / 皮肤查找
  already_installed: "已安装了 id 为 {id} 的插件。",
  no_plugin_with_id: "未安装 id 为 {id} 的插件。",
  plugin_disabled: "插件 {id} 已被禁用。",

  // plugin_registry.rs —— Luau 脚本加载（read_plugin_lua）
  lua_no_source_dir: "插件没有可解析的源目录来存放其 Luau 脚本。",
  lua_no_script_file: "插件未声明 `lua` 脚本文件。",
  lua_unsafe_path:
    "插件 `lua` 路径 {path} 不安全 —— 它必须是插件目录内的相对路径（不得以 '/' 开头，也不得包含 '..'）。",
  lua_not_lua_extension: "插件 `lua` 路径 {path} 必须指向一个 `.lua` 文件。",
  lua_cannot_resolve_dir: "无法解析插件源目录 {dir}：{detail}",
  lua_cannot_read: "无法读取插件 Luau 脚本 {path}：{detail}",
  lua_escapes_dir: "插件 Luau 脚本 {path} 逃逸出了插件目录 —— 拒绝加载它。",
  lua_not_regular_file: "插件 Luau 脚本 {path} 不是常规文件。",
  lua_too_large: "插件 Luau 脚本 {path} 过大（{bytes} 字节；上限为 {limit} 字节）。",
  lua_too_large_limit: "插件 Luau 脚本 {path} 过大（上限 {limit} 字节）。",

  // plugin_exec.rs —— 命令/钩子执行器
  could_not_open_repo_snapshot: "在执行会修改仓库的插件操作前，无法打开仓库以创建快照：{detail}",
  windows_cmd_unsafe_value:
    "拒绝在 Windows 上运行该插件命令：{tok} 值包含一个对 cmd.exe 不安全的字符（& | < > ^ % ! \" 之一或换行符）。这是 GitCat 插件执行器已知的 Windows 限制。",
  could_not_run_command: "无法运行插件命令：{detail}",
  command_not_found: "未找到插件命令 {plugin_id}/{command_id}，或它已被禁用。",
  no_repo_for_command: "未为该插件命令提供仓库路径。",
  no_repo_for_hooks: "未为插件钩子提供仓库路径。",

  // plugin_lua.rs —— 内嵌 Luau 运行时
  lua_vm_create: "无法创建沙箱化的 Lua 虚拟机：{detail}",
  lua_memory_limit: "无法应用 Lua 内存限制：{detail}",
  lua_harden_globals: "无法加固 Lua 全局变量：{detail}",
  lua_enable_sandbox: "无法启用 Lua 沙箱：{detail}",
  lua_install_host_api: "无法安装插件宿主 API：{detail}",
  lua_script_error: "插件脚本错误：{detail}",
  lua_module_not_table: "插件的主 Lua 文件必须 `return` 一个由处理函数组成的表，但它返回的是 {type}",
  lua_handler_not_found: "在主文件返回的表中未找到插件处理函数 '{handler}'",
  lua_handler_not_function: "插件处理函数 '{handler}' 是 {type}，而不是函数",
  lua_handler_error: "插件处理函数错误：{detail}",
};
