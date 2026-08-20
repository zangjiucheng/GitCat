// 应用内帮助页文案(index.html 的 #helpScrim —— 由 legacy/main.ts 的
// applyStaticI18n 手动套用)。键会变成 `help.<key>`。
export default {
  dialog_aria: "GitCat 帮助",
  title: "GitCat —— 帮助",
  graph_h: "提交图",
  graph_p:
    "每一行是一个 commit,最新的排在最上面。左侧的 <b>BRANCH / TAG</b> 列显示指向该 commit 的分支或标签;泳道颜色对应各个分支。你当前所在的 commit(<b>HEAD</b>)带有一圈明亮的光环,左边缘还有一道竖条 —— 也就是「你在这里」。已经在当前分支里的 commit 会<b>变暗</b>,这样你还没合并的工作就会更醒目。",
  navigate_h: "导航",
  navigate_p:
    "滚动或拖拽即可移动;<kbd>⌘</kbd>+滚动(或 <kbd>+</kbd>/<kbd>-</kbd>)可缩放。<kbd>⌘K</kbd> 打开命令面板。<kbd>⌘F</kbd> 搜索 commit 内容,<kbd>⌘⇧F</kbd> 过滤 ref。<kbd>⌘⇧H</kbd> 跳到 HEAD,<kbd>⌘⇧U</kbd> 跳到未提交的更改。<kbd>⌘\\</kbd> 切换专注模式。按 <kbd>?</kbd> 查看全部快捷键。",
  commits_h: "Commit",
  commits_p:
    "点击某个 commit,右侧会显示它的文件和 diff。把一个 commit <b>拖</b>到另一个上,即可把它 cherry-pick 过去 —— 拖拽时按住 <kbd>⇧</kbd> 则改为合并。<b>右键点击</b>某个 commit,可进行 cherry-pick / 合并 / revert / reset / 创建分支或标签 / 复制。",
  branches_h: "分支与标签",
  branches_p:
    "在图中<b>右键点击分支标签</b>可进行分支管理(检出、push、合并、rebase、reset、删除)。<b>右键点击远程</b>标签(origin/…)可将其检出为本地分支。把鼠标悬停在标签上可查看它的完整名称。左侧<b>边栏</b>列出了每一个分支和标签 —— 点击即可让图跳转到它的顶端 commit;对分支而言,双击(或右键点击、或它的 ⋮ 按钮)则改为检出;复选框用于在图中显示或隐藏分支。",
  uncommitted_h: "未提交的更改",
  uncommitted_p:
    "置顶固定的那一行。你可以暂存或取消暂存整个文件、单个 hunk 或单行,然后提交。你还可以让 GitCat 调用你自己的命令来生成 commit 信息(工具 ▸ 外部工具)—— GitCat 本身从不与 AI 通信,是那个命令在做。",
  snapshots_h: "快照(Safety Manager)",
  snapshots_p:
    "GitCat 会在有风险的操作之前,悄悄为你的仓库拍下快照。左侧的丝带列出了最近的快照 —— 点击即可预览,让你随时都能找到回去的路。",
};
