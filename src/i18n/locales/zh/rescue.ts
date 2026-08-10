// Tama 在 HEAD 分离以及重新回到分支时的文案(由 legacy/main.ts 中 TamaMascot
// 的 `rescue.detached` / `rescue.resolved` 事件发出)。键会变成 `rescue.<key>`。
export default {
  detached: "HEAD 处于分离状态——别担心,有我在。点一下就能回到 {branch}。",
  resolved: "已回到 {branch}。安然无恙。",
};
