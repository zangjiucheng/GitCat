// Keyboard-shortcuts help overlay (vim-style nav). Only the descriptions are
// translated; the key glyphs (⌘K, j, k, …) stay literal. Keys become `vimnav.<key>`.
export default {
  title: "Keyboard shortcuts",
  subtitle: "Always on, and never active while you're typing in a field.",
  cmd_legend: "Cmd on macOS, Ctrl on Windows/Linux",
  shift_legend: "Shift",

  sec_search: "Search",
  sec_sync: "Sync",
  sec_view: "View & panels",
  sec_navigate: "Navigate",
  sec_actions: "Actions",

  palette: "command palette (commits, refs, actions)",
  search_code: "search code (find in file contents)",
  filter_refs: "filter refs (focus the sidebar's ref search)",
  fetch: "fetch (download from the remote)",
  pull: "pull",
  push: "push",
  jump_uncommitted: "jump to Uncommitted changes",
  jump_head: "jump to the current commit (HEAD)",
  focus_mode: "focus mode (collapse both side panels)",
  zoom: "zoom the graph",
  down_up: "down / up (graph or focused list)",
  first_last: "first / last commit",
  half_page: "half-page down / up",
  scroll: "scroll (when the graph has focus)",
  enter: "open the selected commit's diff (or activate a focused row)",
  undo: "undo (rewind to a Safety-Manager snapshot)",
  esc: "close a dialog, cancel a typed-confirm, or exit the big diff",
  toggle_help: "toggle this help",
};
