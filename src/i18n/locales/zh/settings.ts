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

  // 外观
  appearance: "外观",
  theme_system: "跟随系统",
  theme_light: "浅色",
  theme_dark: "深色",

  // 提交图
  graph: "提交图",
  show_all_tags_hint: "当一个 commit 有多个标签时,全部显示,而不只是第一个",
  show_all_tags: "显示 commit 上的所有标签",
  label_priority_desc:
    "当一个 commit 的标签放不下时,优先显示这一类。点击某一行的 <b>+N</b> 标记可循环查看其余标签。",
  label_priority_tags: "标签优先",
  label_priority_branches: "分支优先",
  label_layout_desc:
    "「行内」把 commit 的引用标记画在其标题文字前面;「左侧列」把它们放在一个独立、可调整宽度的列里。",
  label_layout_inline: "行内(标题前)",
  label_layout_column: "左侧列",
  detail_placement: "详情面板",
  detail_placement_desc: "显示所选提交的面板所在位置。",
  detail_placement_right: "右侧",
  detail_placement_bottom: "底部",

  // Cherry-pick
  cherrypick: "Cherry-pick",
  cherrypick_origin_hint: "在生成的 commit 信息中追加 '(cherry picked from …)'",
  cherrypick_record_origin: "cherry-pick 时记录来源(-x)",

  // 更新
  updates: "更新",
  auto_check_updates: "启动时自动检查更新",
  use_nightly: "使用每夜构建版",
  nightly_hint:
    "带有详细调试日志的不稳定每日构建版。你可以随时切换回最新的稳定版。",
  check_updates_now: "立即检查更新",
  checking_updates: "正在检查更新……",
  up_to_date: "已是最新版本。",
  up_to_date_ok: "好的",
  update_available: "<b>v{version}</b> 可用 <span class=\"mut\">(当前为 v{current})</span>",
  not_now: "暂不",
  download_install: "下载并安装",
  downloading_pct: "正在下载…… {progress}%",
  downloading: "正在下载……",
  update_downloaded: "更新已下载 — 重启以完成安装。",
  restart_now: "立即重启",
  dismiss: "关闭",

  // 自动拉取
  autofetch: "自动拉取",
  autofetch_hint:
    "在仓库打开期间定时运行 git fetch --all --prune,这样领先/落后数量以及远程的新变更无需手动 Pull 即可保持最新",
  autofetch_toggle: "定期从所有远程拉取(fetch)",
  autofetch_every: "每 {m} 分钟",

  // 维护
  maintenance: "维护",
  maintenance_hint:
    "在 GitCat 空闲时于后台运行 'git maintenance run --auto',保持仓库对象数据库整洁(commit-graph、gc、repack),让图谱和状态保持流畅。--auto 只会执行确实到期的工作;它绝不会更改历史、工作区,也不会触及远程。",
  maintenance_toggle: "空闲时在后台运行 git maintenance",
  maintenance_desc:
    "保持仓库的对象数据库整洁(commit-graph、gc、repack),让日常操作保持流畅 — 仅在应用空闲时进行,且只做 git 判断确实到期的工作。默认关闭。",

  // 快照
  snapshots: "快照",
  snapshots_desc:
    "每一次改变历史的操作都会固定一个可恢复的备份 — 这正是 ⌘Z 撤销和快照条的基础。若不清理,它们会随时间不断累积。自动清理会在每次打开仓库时删除旧快照;最近的一个快照始终会保留。",
  snapshot_keep_all: "全部保留(不清理)",
  snapshot_keep_count: "保留最新的 N 个",
  snapshot_keep_age: "保留最近 N 天",
  snapshot_keep_hybrid: "混合 — 最新 N 个或最近 N 天",
  snapshot_count_before: "保留最新的",
  snapshot_count_after: "个快照",
  snapshot_days_before: "保留最近",
  snapshot_days_after: "天的快照",
  snapshot_hybrid_note: "只要快照属于最新的 {count} 个 <b>或</b> 来自最近 {days} 天,就会被保留。",

  // Tama
  tama: "Tama",
  tama_show_hint:
    "在 Tama 出现的所有位置(角落吉祥物、空状态问候、弹窗标题、撤销提示框)隐藏她的画像,让界面更简洁、更专注。角落里的状态/错误消息仍会显示 — 只是不带角色形象。",
  tama_show: "显示 Tama",
  sound_hint:
    "在她一些比较重要的时刻播放几段简短的合成提示音 — 警告、危险、庆祝,以及复制到剪贴板的提示声",
  sound_toggle: "播放音效",
  sound_volume_aria: "音效音量",
  sound_test: "测试",

  // 皮肤
  skin: "皮肤",
  skin_desc:
    "为 Tama 选择一种外观 — 以及声音:她默认的手绘画像、内置的某个角色,或由已安装插件提供的皮肤。",
  skin_default: "默认(内置)",

  // 动态
  motion: "动态",
  motion_desc: "Tama 的待机动作和反应有多活跃。<b>默认</b>保持她当前的行为。",

  // 表情
  expressions: "表情",
  expressions_desc: "为每个时刻挑选 Tama 的表情。保持某一项为<b>默认</b>即可沿用她内置的样子。",
  expressions_pose_default: "默认({pose})",
  reset_expressions: "重置表情",

  // Git 身份
  git_identity: "Git 身份",
  identity_no_repo: "打开一个仓库以查看或编辑其 git 身份。",
  identity_loading: "正在加载 git 身份……",
  identity_global_note:
    "尚未为该仓库单独设置身份 — 下面显示的是你的<b>全局</b> git 身份。保存后可改为只为此仓库设置一个。",
  identity_name: "姓名",
  identity_email: "邮箱",
  identity_local_note:
    "只会写入该仓库的 <code>.git/config</code> — 你的全局 git 身份不会被改动。",

  // Git 配置
  git_config: "Git 配置",
  config_no_repo: "打开一个仓库以查看或编辑其 git 配置。",
  config_scope_local: "此仓库(.git/config)",
  config_scope_global: "全局(~/.gitconfig — 所有仓库)",
  config_loading: "正在加载 git 配置……",
  show_advanced: "显示高级(任意键)……",
  hide_advanced: "隐藏高级",
  loading: "加载中……",
  filter_placeholder: "筛选键或值……",
  edit: "编辑",
  remove: "删除",
  no_entries_match: "没有匹配 \"{filter}\" 的条目。",
  no_config_entries: "没有 {scope} 配置条目。",
  advanced_add_hint: "添加一个键,或点击已有行的「编辑」来更新其值。",
  advanced_key_placeholder: "section.key",
  advanced_value_placeholder: "值",
  set: "设置",

  // 底栏
  saving: "正在保存……",
  save_identity: "保存身份",
};
