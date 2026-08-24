// 提交详情面板文案。键会变成 `detail.<key>`。
export default {
  // Tama 主视觉 / 空状态。
  hero_alt: "Tama,GitCat 的守护者",
  hero_bubble_loaded:
    'はじめまして!我是 <b>Tama</b>,GitCat 的守护者。每次改动前我都会保存一份快照 —— 你的历史记录在我这儿始终安全无虞。<span class="jp">にゃ〜♪</span>',
  hero_bubble_loaded_plain: "每次改动前都会保存一份快照 —— 你的历史记录始终安全。",
  hero_stat: '<span class="n">{n}</span> 个 commit 在 <b>{ms} ms</b> 内完成布局',
  hero_hint_loaded: "点击 commit 查看详情 · 把圆点拖到另一个上可 cherry-pick · ⌘Z 撤回",
  hero_bubble_empty:
    'はじめまして!我是 <b>Tama</b>。打开一个 Git 仓库,我会一瞬间为你铺开它的完整历史。<span class="jp">にゃ〜♪</span>',
  hero_bubble_empty_plain: "打开一个 Git 仓库即可开始。",
  open_repo: "打开仓库…",
  hero_hint_open: "或点击顶栏中的仓库名 <b>▾</b>",
  // 提交正文 / 标识条 / 回退。
  loading: "加载中…",
  show_less: "收起",
  show_more: "展开",
  click_to_copy: "点击复制完整哈希",
  copied: "已复制 ✓",
  row_of: "第 {row} / {total} 行",
  cant_revert_merge: "无法回退一个合并 commit",
  revert_commit: "回退此 commit",
  // 标签名称。指的是你当前**查看**的这个 commit —— 与 workdir.commit(你正在
  // 编写的那个)故意分开的独立键。
  tab_commit: "提交",
  // 作者 / 提交者。
  author: "作者",
  committer: "提交者",
  author_ne_committer: "⚠ 作者 ≠ 提交者(打过补丁 / 变基过)—— 这正是 cherry-pick 与 rebase 带来的知识点。",
  // 引用 + 快照覆盖。
  refs_pointing_here: "指向此处的引用",
  no_refs: "没有引用指向此处",
  covered:
    '已由快照覆盖 <b>backup/…{ago} 前</b><br /><span class="mut">可经安全管理员备份引用到达 —— ⌘Z 可回退到这里。</span>',
  // 更改 / 差异统计 / 文件树。
  changes: "更改",
  loading_diff: "正在加载 diff…",
  file: "个文件",
  files_plural: "个文件",
  capped_suffix: "(已截断)",
  loading_files: "正在加载文件…",
  no_file_changes: "没有文件更改",
  diff: "差异",
  expand_diff: "放大差异",
  expand_diff_aria: "将差异放大到整页",
  files_label: "文件",
  resize_file_list: "调整文件列表宽度",
  collapse_all_folders: "折叠所有文件夹",
  expand_all_folders: "展开所有文件夹",
  // 文件行操作。
  blame: "追溯 (blame)",
  blame_file: "追溯 {path}",
  history: "历史",
  history_file: "{path} 的历史",
  open_external_diff: "用外部工具打开差异",
  open_external_diff_for: "用外部工具打开 {path} 的差异",
  // Tama 提示。
  parent_blame_failed: "无法解析父 commit,无法对已删除文件执行追溯。",
  parent_history_failed: "无法解析父 commit,无法显示已删除文件的历史。",
  parent_resolve_failed: "无法解析父 commit —— {e}",
};
