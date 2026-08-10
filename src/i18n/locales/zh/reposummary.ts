// 仓库概览文案。键会变成 `reposummary.<key>`。
export default {
  title: "仓库概览",
  subtitle_pre: "直接从 ",
  subtitle_post:
    " 本身快速了解仓库:哪些文件改动最频繁、谁在真正维护它、一段时间以来有多活跃,以及反复出问题的地方在哪。",
  loading: "正在读取 git log……大仓库可能需要一会儿。",
  none: "最近 {days} 天没有 commit —— 暂时没什么可概览的。",
  churn_title: "改动热点",
  churn_sub: "改动最多的文件,最近 {days} 天",
  churn_empty: "此时间窗内没有文件改动。",
  contributors_title: "贡献者",
  bus_factor: "巴士系数:{n}",
  contributors_empty: "此时间窗内没有贡献者。",
  monthly_title: "每月活跃度",
  monthly_empty: "此时间窗内没有 commit。",
  month_tooltip: "{month}:{n} 个 commit",
  problem_title: "问题区域",
  problem_caveat: "基于启发式判断,并非精确分类",
  problem_caveat_title:
    "基于对 commit 标题(fix/bug/hotfix/regression/revert/……)的关键词启发式判断,并非分类器。误报和漏报都在所难免。",
  problem_reverts: "{total} 个 commit 中有 {n} 个({pct}%)是回退或热修复。",
  problem_empty: "没有发现反复出问题的文件。",
  truncated: "……已截断(达到上限)—— 只展示了超大历史的一部分。",
  err_summarize: "无法概览这个仓库。",
  err_summarize_e: "无法概览这个仓库 —— {e}",
};
