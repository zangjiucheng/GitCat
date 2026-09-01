// 跨 island 复用的通用文案。键会变成 `common.<key>`。
export default {
  ok: "确定",
  cancel: "取消",
  close: "关闭",
  save: "保存",
  remove: "移除",
  loading: "加载中…",
  // 两个面板之间分隔条的提示（islands/detailpanel/Splitter）。
  warn_reveal_failed: "无法在文件管理器中显示 — {reason}",
  warn_open_dir_failed: "无法打开该文件夹 — {reason}",
  splitter_tip: "拖动调整大小 — 双击复原",
  install: "安装",

  // 行 / 仓库右键菜单（Detail、Workdir、顶栏仓库名）。reveal_* 打开所在文件夹
  // 并选中该文件，open_dir_* 直接进入该文件夹 —— 两个动词要保持区分。
  reveal_windows: "在文件资源管理器中显示",
  reveal_macos: "在访达中显示",
  reveal_linux: "在文件管理器中显示",
  open_dir_windows: "在文件资源管理器中打开",
  open_dir_macos: "在访达中打开",
  open_dir_linux: "在文件管理器中打开",
  // 相对仓库根目录（git 自己打印的形式）与绝对路径。
  copy_path: "复制路径",
  copy_full_path: "复制完整路径",
};
