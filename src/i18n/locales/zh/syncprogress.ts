// git 同步进度弹窗(获取/拉取/推送)。键会变成 `syncprogress.<key>`。
export default {
  title: "同步中…",
  body: "git 的实时输出。远程仓库较大或 WSL 仓库时可能需要一段时间。「隐藏」会让它在后台继续运行；「取消」会终止它。",
  starting: "正在开始…",
  done: "完成。",
  hide: "隐藏",
  cancelling: "正在取消…",
  cancelled: "已取消。",
  stalled: "git 已超过 {secs} 秒没有任何进度，看起来卡住了。要取消吗？",
};
