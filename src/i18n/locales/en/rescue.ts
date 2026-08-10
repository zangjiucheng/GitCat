// Tama's lines when HEAD detaches and when it's put back on a branch (emitted
// by the `rescue.detached` / `rescue.resolved` events in legacy/main.ts's
// TamaMascot). Keys become `rescue.<key>`.
export default {
  detached: "Detached HEAD — I've got you. One tap puts you back on {branch}.",
  resolved: "You're back on {branch}. Safe and sound.",
};
