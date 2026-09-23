// 内置终端文案。键会变成 `terminal.<key>`。
export default {
  title: "终端",
  focus_out: "把焦点交还给应用",
  focus_out_hint: "回到应用",
  exited: "进程已退出",
  restart_btn: "重启",
  aria_close: "关闭终端",
  demo_pre: "真实的 shell 会在这里运行,位于 ",
  demo_post: " (演示)。",
  starting: "正在启动 shell……",
  open_repo_first: "请先打开一个仓库。",
  err_open: "无法打开终端。",
  err_open_e: "无法打开终端 —— {e}",
  wsl_ref_fix_title: "需要修复一次权限问题",
  wsl_ref_fix_message: "旧版本的应用在这个 WSL 仓库的 .git 目录下留下了一些 root 所有的文件。在终端里运行 `{cmd}` 即可修复 —— 现在打开终端并运行吗？",
  wsl_ref_fix_confirm: "打开终端并运行",
};
