// Tama 在破坏性/重写操作执行前被取消时的文案(由 legacy/main.ts 中
// TamaMascot 的 `mutation.cancel` 事件发出)。键会变成 `mutation.<key>`。
export default {
  cancel: "已取消——什么都没有改动。",
  caution: "注意——这会重写 {cnt}。已先保存备份 {ref}。",
  destructive: "{label}无法撤销。备份 {ref} 已固定——输入 ref 名称即可继续。",
  commit_one: "{n} 个提交",
  commit_many: "{n} 个提交",
  commit_some: "若干提交",
  this_label: "该操作",
};
