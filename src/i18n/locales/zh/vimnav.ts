// 键盘快捷键帮助浮层(vim 风格导航)。只翻译说明文字,按键符号(⌘K、j、k…)
// 保持原样。键会变成 `vimnav.<key>`。
export default {
  title: "键盘快捷键",
  subtitle: "始终开启,在输入框里打字时会自动失效。",
  cmd_legend: "macOS 上是 Cmd,Windows/Linux 上是 Ctrl",
  shift_legend: "Shift",

  sec_search: "搜索",
  sec_sync: "同步",
  sec_view: "视图与面板",
  sec_navigate: "导航",
  sec_actions: "操作",

  palette: "命令面板(提交、引用、操作)",
  search_code: "搜索代码(在文件内容里查找)",
  filter_refs: "过滤引用(聚焦侧栏的引用搜索框)",
  fetch: "获取(从远程下载)",
  pull: "拉取",
  push: "推送",
  jump_uncommitted: "跳到未提交的改动",
  jump_head: "跳到当前提交(HEAD)",
  focus_mode: "专注模式(收起两侧面板)",
  zoom: "缩放图谱",
  down_up: "下 / 上(图谱或聚焦的列表)",
  first_last: "第一个 / 最后一个提交",
  half_page: "向下 / 向上翻半页",
  scroll: "滚动(当图谱获得焦点时)",
  enter: "打开选中提交的差异(或激活聚焦的那一行)",
  undo: "撤销(回到一个 Safety Manager 快照)",
  esc: "关闭对话框、取消输入确认,或退出大图差异视图",
  toggle_help: "切换这个帮助面板",
};
