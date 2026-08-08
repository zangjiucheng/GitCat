// 强制推送的危险操作流程。键会变成 `forcepush.<key>`。
export default {
  open_repo_first: "请先打开一个仓库。",
  no_branch: "HEAD 不在任何分支上 —— 没有可强制推送的内容。",
  arm_say_lease:
    "正在强制推送 {branch} —— 输入分支名以解锁。如果远端在我上次 fetch 之后有变动,这次会被拒绝。",
  title_lease: "强制推送(安全)—— {branch}",
  desc_lease:
    "这会用你的本地历史覆盖远端上 {branch} 的位置 —— 通常在你 rebase 或修改(amend)了一个已推送的提交后需要这么做。与原始的强制推送不同,如果远端有本仓库还不知道的内容(比如别人在你上次 fetch 之后推送了),它会拒绝而不是覆盖。",
  lose_lease:
    "<h5>会发生什么</h5><ul><li>把远端的 <code>{branch}</code> 覆盖成与你本地分支一致</li><li>如果远端在你上次 fetch 之后有变动,它会干净地拒绝、不做任何改动 —— 请先 fetch 并调和,然后重试</li><li>本地不会有任何变化 —— HEAD、你的分支和工作区都保持不变</li></ul>",
  note_lease:
    "这只会影响远端 —— 本地没有任何东西需要 ⌘Z/撤销 来保护。如果它成功并且确实覆盖了远端此前的提交,那些提交在应用内没有恢复途径。",
  confirm_lease: "强制推送",
  arm_say_override:
    "正在强制推送 {branch} —— 输入分支名以解锁。无论远端上有什么,这次都会覆盖。",
  title_override: "强制推送 —— 覆盖远端 —— {branch}",
  desc_override:
    "这会无条件地用你的本地历史覆盖远端上的 {branch},即使别人推送了你本地仓库没有的提交也照样覆盖。那些提交可能被永久丢弃,在 GitCat 内没有任何恢复途径 —— 只有在你确定不会影响别人的工作时才使用。",
  lose_override:
    "<h5>会发生什么</h5><ul><li>把远端的 <code>{branch}</code> 覆盖成与你本地分支一致,无论当前上面是什么</li><li>远端上任何你本地仓库没有的提交,都会在这次成功的瞬间被永久丢弃</li><li>本地不会有任何变化 —— HEAD、你的分支和工作区都保持不变</li></ul>",
  note_override:
    "这可能摧毁远端上别人的工作,而且在 GitCat 内无法挽回 —— 安全管理员/撤销 只会保护本仓库自己的本地引用,绝不会保护任何已推送的内容。除非你确实需要覆盖别人的改动,否则请优先使用「强制推送(安全)」。",
  confirm_override: "强制推送(覆盖)",
  pushing: "正在强制推送 {branch}……",
  pushed: "已强制推送 {branch}。",
  demo_pushed: "已强制推送 {branch}(演示)。",
  failed: "强制推送失败。",
  failed_e: "强制推送失败 —— {error}",
};
