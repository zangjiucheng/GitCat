// In-app Help page prose (#helpScrim in index.html — applied imperatively by
// legacy/main.ts's applyStaticI18n). Keys become `help.<key>`.
export default {
  dialog_aria: "GitCat help",
  title: "GitCat — Help",
  graph_h: "The graph",
  graph_p:
    'Each row is one commit, newest at the top. The left <b>BRANCH / TAG</b> column shows the branch or tag that points at a commit; lane colours track branches. Your current commit (<b>HEAD</b>) has a bright ring and a bar down its left edge — that’s “you are here.” Commits already in your current branch are <b>dimmed</b>, so work you haven’t merged yet stands out.',
  navigate_h: "Navigate",
  navigate_p:
    "Scroll or drag to move; <kbd>⌘</kbd>+scroll (or <kbd>+</kbd>/<kbd>-</kbd>) to zoom. <kbd>⌘K</kbd> opens the command palette. <kbd>⌘F</kbd> searches commit content, <kbd>⌘⇧F</kbd> filters refs. <kbd>⌘⇧H</kbd> jumps to HEAD, <kbd>⌘⇧U</kbd> to Uncommitted changes. <kbd>⌘\\</kbd> toggles focus mode. Press <kbd>?</kbd> for every shortcut.",
  commits_h: "Commits",
  commits_p:
    "Click a commit to see its files and diff on the right. <b>Drag</b> a commit onto another to cherry-pick it there — hold <kbd>⇧</kbd> while dragging to merge instead. <b>Right-click</b> a commit for cherry-pick / merge / revert / reset / create branch or tag / copy.",
  branches_h: "Branches & tags",
  branches_p:
    "<b>Right-click a branch label</b> in the graph for branch management (checkout, push, merge, rebase, reset, delete). <b>Right-click a remote</b> label (origin/…) to check it out as a local branch. Hover a label to see its full name. The left <b>sidebar</b> lists every branch and tag — click one to jump the graph to its tip commit; for a branch, double-click (or right-click, or its ⋮ button) checks it out instead; the checkboxes show or hide branches in the graph.",
  uncommitted_h: "Uncommitted changes",
  uncommitted_p:
    "The pinned top row. Stage or unstage whole files, single hunks, or single lines, then commit. You can point GitCat at your own command to generate the commit message (Tools ▸ External Tools) — GitCat never talks to an AI itself; the command does.",
  snapshots_h: "Snapshots (Safety Manager)",
  snapshots_p:
    "GitCat quietly snapshots your repo before risky operations. The ribbon down the left lists recent snapshots — click one to preview it, so you can always find your way back.",
};
