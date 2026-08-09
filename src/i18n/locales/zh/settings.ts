// 设置弹窗文案。键会变成 `settings.<key>`。
export default {
  title: "设置",
  subtitle: "主题、cherry-pick 默认项、更新检查,以及这个仓库的 git 身份。",
  tab_general: "通用",
  tab_tama: "Tama",
  tab_identity: "Git 身份",
  tab_gitconfig: "Git 配置",
  language: "语言",
  language_hint: "应用的显示语言,切换后立即生效。",
  cli_h4: "命令行",
  cli_desc:
    "把 <code>gitcat</code> 命令加入 PATH,这样你就能从任意终端打开仓库了,就像 VS Code 里的 <code>code .</code> 一样。它会打开应用而不会阻塞你的终端。在 macOS 上可能会要求你输入密码。",
  cli_installing: "安装中……",
  cli_install_btn: "安装 'gitcat' 命令",
  cli_ok: "已安装到 {path}。打开一个新终端,在任意仓库里运行 gitcat . 即可。",
  cli_err: "无法安装 gitcat 命令。",
  cli_err_e: "无法安装 gitcat 命令。{e}",
};
