// Settings modal strings. Keys become `settings.<key>`.
export default {
  title: "Settings",
  subtitle: "Theme, cherry-pick defaults, update checks, and this repository's git identity.",
  tab_general: "General",
  tab_tama: "Tama",
  tab_identity: "Git Identity",
  tab_gitconfig: "Git Config",
  language: "Language",
  language_hint: "The app's display language. Applies immediately.",
  cli_h4: "Command line",
  cli_desc:
    "Add a <code>gitcat</code> command to your PATH so you can open a repository from any terminal, the way <code>code .</code> works in VS Code. It opens the app without blocking your terminal. On macOS you may be asked for your password.",
  cli_installing: "Installing…",
  cli_install_btn: "Install 'gitcat' command",
  cli_ok: "Installed at {path}. Open a new terminal and run gitcat . inside any repo.",
  cli_err: "Couldn't install the gitcat command.",
  cli_err_e: "Couldn't install the gitcat command. {e}",
};
