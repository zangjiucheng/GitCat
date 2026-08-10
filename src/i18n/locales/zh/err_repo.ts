// err_repo 的简体中文翻译（PER-82）。键名对应 `err_repo.<key>`，由 `be()`
//（见 src/i18n/i18n.svelte.ts）从 Rust 的 `ierr`/`ierrp` 机制中查找。
// 英文为最终来源（en/err_repo.ts）；此处缺失的键会自动回退到英文。
export default {
  // repo_files.rs / repo_summary.rs / commands.rs（图加载）共用
  cannot_open_repo: "无法打开仓库：{detail}",
  // identity.rs（set_git_identity）
  cannot_open_repo_cap: "无法打开仓库：{detail}",
  // identity.rs（get_git_identity —— 同时充当设置向导的目录校验）
  not_a_git_repository: "这看起来不是一个 git 仓库 —— {detail}",
  name_and_email_required: "姓名和邮箱不能为空。",
  set_identity_success: "已为此仓库设置身份：{name} <{email}>。",

  // git 运行器的共用回退（identity.rs / repo_summary.rs）。detail 原样传递
  //（git 自身的退出码 / Option 的调试输出），不作本地化。
  git_exited_with_status: "git 退出，状态码 {code}",
  could_not_run_git: "无法运行 git：{detail}",

  // repo_registry.rs —— 跟踪仓库列表 JSON 的持久化
  could_not_resolve_config_dir: "无法解析应用配置目录：{detail}",
  could_not_create_config_dir: "无法创建应用配置目录：{detail}",
  could_not_read: "无法读取 {path}：{detail}",
  could_not_serialize: "无法序列化：{detail}",
  could_not_write: "无法写入 {path}：{detail}",
  could_not_finalize: "无法完成写入 {path}：{detail}",

  // repo_files.rs —— .gitignore/.mailmap 编辑器
  not_editable_repo_file: "{name} 不是可编辑的仓库文件（仅支持 .gitignore 和 .mailmap）。",
  no_working_tree: "此仓库没有工作区。",
  file_is_symlink: "{name} 是一个符号链接 —— 出于安全考虑，拒绝通过它读取或写入。",
  saved_file: "已保存 {name}。",

  // cli_shim.rs —— 将 `gitcat` 命令安装到 PATH
  cli_unsupported_platform: "尚不支持从应用内在此平台上安装 gitcat 命令。",
  couldnt_find_own_program: "找不到 GitCat 自身的程序文件：{detail}",
  cli_macos_needs_bundle:
    "此功能仅适用于已安装的 GitCat.app。看起来你正在运行未打包的构建（例如 `cargo tauri dev`）。",
  install_path_not_utf8: "GitCat 的安装路径不是有效的 UTF-8。",
  couldnt_write: "无法写入 {path}：{detail}",
  couldnt_create: "无法创建 {path}：{detail}",
  couldnt_stage_launcher: "无法暂存启动器：{detail}",
  temp_path_not_utf8: "临时路径不是有效的 UTF-8。",
  couldnt_run_admin_helper: "无法运行管理员助手（osascript）：{detail}",
  installation_cancelled: "安装已取消。",
  couldnt_install_with_admin: "无法以管理员权限安装：{detail}",
  couldnt_find_home: "找不到你的主目录（$HOME）。",
  couldnt_find_localappdata: "找不到 %LOCALAPPDATA%。",
};
