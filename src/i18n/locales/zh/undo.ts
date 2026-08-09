// Tama 撤销成功后的庆祝文案(由 legacy/main.ts 中 TamaMascot 的
// `undo.performed` 事件发出)。键会变成 `undo.<key>`。
export default {
  performed: "已回退到 {hash}——什么都没丢,我先封存了 {ref}。♪",
};
