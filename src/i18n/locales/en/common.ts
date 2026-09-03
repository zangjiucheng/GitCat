// Shared UI strings reused across islands. Keys become `common.<key>`.
export default {
  ok: "OK",
  cancel: "Cancel",
  close: "Close",
  save: "Save",
  remove: "Remove",
  loading: "Loading…",
  // Tooltip on the divider between two panes (islands/detailpanel/Splitter).
  // Names the gesture, not the panes — the divider's accessible name already
  // says which list it resizes. Double-click is otherwise undiscoverable.
  // Shown when the OS file manager refuses the path — most often a file
  // from an older commit that is no longer on disk.
  warn_reveal_failed: "Couldn't show that in the file manager — {reason}",
  warn_open_dir_failed: "Couldn't open that folder — {reason}",
  splitter_tip: "Drag to resize — double-click to reset",
  install: "Install",

  // Row / repo context menus (Detail, Workdir, the topbar repo chip).
  //
  // The reveal_* and open_dir_* families are the ONE place this app's copy
  // varies by platform — see legacy/platform.ts for why a proper noun earns
  // that when a ⌘ glyph does not. Translators: keep whatever the OS itself
  // is called in your language (Finder ships under a localized name in some
  // locales), and keep the two verbs distinct — reveal_* opens the
  // containing folder with the file selected, open_dir_* lands you inside
  // the folder.
  reveal_windows: "Show in File Explorer",
  reveal_macos: "Reveal in Finder",
  reveal_linux: "Show in file manager",
  open_dir_windows: "Open in File Explorer",
  open_dir_macos: "Open in Finder",
  open_dir_linux: "Open in file manager",
  // Repo-relative (what git itself prints) vs absolute.
  copy_path: "Copy path",
  copy_full_path: "Copy full path",
};
