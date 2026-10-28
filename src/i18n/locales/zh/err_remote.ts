// err_remote 的简体中文翻译（PER-82）。英文为准；此处缺失的键会自动回退到英文。
// {base}/{detail} 等占位符承载的是逐字透传的 git stderr 或 io/git2 细节，本身不翻译。
export default {
  run_git_failed: "无法运行 git：{detail}",
  git_wait_failed: "等待 git 结束失败：{detail}",
  git_exited_status: "git 以状态 {code} 退出",
  ssh_publickey_wsl_hint:
    "{base}（WSL 会跳过 shell 初始化，ssh-agent 不会启动——请在 WSL 终端中启动一个，或改用无口令的密钥）",
  host_key_wsl_hint:
    "{base}（请先在 WSL 终端中对该远程执行一次任意 ssh/git 命令以接受其主机密钥，然后重试）",
  host_key_hint:
    "{base}（请先在终端中对该远程执行一次任意 ssh/git 命令以接受其主机密钥，然后重试）",
  // 用户取消的获取/拉取/推送（#133）。
  fetch_cancelled: "已取消获取。远程跟踪引用可能只更新了一部分；再次获取即可完成。",
  fetch_cancelled_locks: "已取消获取。已删除被取消的 git 留下的锁文件：{locks}。再次获取即可完成。",
  push_cancelled: "已取消推送。远程可能已收到，也可能没有；请获取一次以确认。",
  push_cancelled_locks:
    "已取消推送。远程可能已收到，也可能没有；请获取一次以确认。已删除被取消的 git 留下的锁文件：{locks}。",
  pull_cancelled: "已取消拉取。如果有内容看起来只更新了一半，按 {undoKey} 即可恢复拉取前的快照 {snapshot}。",
  pull_cancelled_locks:
    "已取消拉取。已删除被取消的 git 留下的锁文件：{locks}。如果有内容看起来只更新了一半，按 {undoKey} 即可恢复拉取前的快照 {snapshot}。",
  pull_cancelled_aborted:
    "已取消拉取。已运行 git {op} --abort，撤回了未完成的 {op}。如果仍有异常，按 {undoKey} 即可恢复拉取前的快照 {snapshot}。",
  pull_cancelled_locks_aborted:
    "已取消拉取。已删除被取消的 git 留下的锁文件（{locks}），并运行 git {op} --abort 撤回了未完成的 {op}。如果仍有异常，按 {undoKey} 即可恢复拉取前的快照 {snapshot}。",
  cannot_open: "无法打开仓库：{detail}",
  snapshot_failed: "安全快照失败，已中止：{detail}",
  remote_name_empty: "远程名称为空。",
  remote_name_flag: "拒绝使用看起来像命令行参数的远程名称：{name}",
  remote_name_control: "远程名称包含非法的空白/控制字符：{name}",
  remote_url_empty: "远程 URL 为空。",
  remote_url_flag: "拒绝使用看起来像命令行参数的 URL：{url}",
  remote_url_control: "远程 URL 包含控制字符。",
  branch_name_empty: "分支名称为空。",
  branch_name_flag: "拒绝使用看起来像命令行参数的分支名称：{name}",
  branch_name_control: "分支名称包含非法的空白/控制字符：{name}",
  branch_name_illegal_char: "分支名称包含非法字符 '{ch}'：{name}",
  branch_name_invalid: "不是有效的分支名称：{name}",
  tag_name_empty: "标签名称为空。",
  tag_name_flag: "拒绝使用看起来像命令行参数的标签名称：{name}",
  tag_name_control: "标签名称包含非法的空白/控制字符：{name}",
  tag_name_illegal_char: "标签名称包含非法字符 '{ch}'：{name}",
  tag_name_invalid: "不是有效的标签名称：{name}",
  no_local_branch: "没有名为 {branch} 的本地分支。",
  branch_no_upstream_reset: "{branch} 没有配置可供重置的上游。",
  upstream_name_not_utf8: "{branch} 的上游名称不是有效的 UTF-8。",
  head_not_on_branch_push: "HEAD 不在任何分支上——没有可推送的内容。",
  head_not_on_branch_force_push: "HEAD 不在任何分支上——没有可强制推送的内容。",
  no_upstream_use_push: "该分支尚无上游——请先使用推送来发布它。",
  // push_target（git_remote.rs）：推送/强制推送的目标，按 git 对单个分支的规则解析，再用显式 refspec 推送。
  cannot_read_config: "无法读取此仓库的 git 配置：{detail}",
  push_mirror_remote: "远程 \"{remote}\" 配置为镜像（remote.{remote}.mirror），推送到它会发送所有引用。GitCat 只推送一个分支——请在终端里推送到镜像。",
  push_default_nothing: "push.default 为 \"nothing\"，没有显式目标时 git 不会推送任何内容。请用分支菜单里的“推送到…”选择目标。",
  push_upstream_not_push_remote: "push.default 为 \"upstream\"，但此分支推送到 \"{remote}\"，而它的上游在 \"{upstream}\"。请用分支菜单里的“推送到…”选择目标。",
  push_no_upstream_branch: "此分支的上游没有分支名（branch.<name>.merge 未设置）。",
  push_upstream_name_differs: "\"{branch}\" 跟踪的是 {upstream}，名字不同，所以“推送”不会更新它（git 的 push.default=simple 也是这样）。请用分支菜单里的“推送到…”选择目标。",
  no_such_local_branch: "没有这样的本地分支：{branch}",
  submodule_path_empty: "子模块路径为空。",
  submodule_path_flag: "拒绝使用看起来像命令行参数的子模块路径：{path}",
  submodule_path_control: "子模块路径包含控制字符：{path}",
  repository_url_empty: "仓库 URL 为空。",
  repository_url_flag: "拒绝使用看起来像命令行参数的仓库 URL：{url}",
  repository_url_control: "仓库 URL 包含控制字符：{url}",
  backup_failed_deinit: "在强制取消初始化前无法备份 {path} 自身的未提交更改，已拒绝：{detail}",
  backup_failed_remove: "在移除前无法备份 {path} 自身的未提交更改，已拒绝：{detail}",
  gitlink_staged_but: "{path} 的 gitlink 已暂存以待移除，但{detail}。请运行 `git status` 查看部分完成的状态后再重试",
};
