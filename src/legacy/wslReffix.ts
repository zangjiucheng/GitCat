// One-time WSL "root-owned refs/gitgui" repair prompt.
//
// Root cause (see src-tauri/src/wsl.rs's own `wsl_create_ref` doc comment):
// an older version of this app created files under `.git` as root while
// reaching into a WSL repo over `\\wsl.localhost\`, so a later write there —
// even by THIS fixed version, now running natively inside the distro as the
// real user — gets refused with a plain "Permission denied". That directory
// can only be repaired with a one-time `chown`, which needs the user's own
// sudo password, so this asks first and then hands the command to a REAL
// terminal (this app's own PTY) rather than ever running it silently.
//
// Hooked into the one seam every raw command call passes through
// (`tinvoke`'s `.catch` in main.ts), not each mutating command's own call
// site — same rationale that seam's own doc comment gives for `beReject`.
import { decodeBackendError, t } from "@/i18n/i18n.svelte.ts";
import { tamaConfirmCtrl } from "../islands/tamaconfirm/tamaconfirm.svelte.ts";
import { terminalCtrl } from "../islands/terminal/terminal.svelte.ts";

const KEY = "err_misc.wsl_ref_permission_denied";

/**
 * `repo` must be the app's OWN currently-open repo path — the Windows
 * `\\wsl.localhost\...` UNC form `terminalCtrl.toggle` expects (it routes
 * that through `wsl.exe` itself; see terminal.rs's `pty_command_for`) — never
 * the bare Linux path carried in the error's own `path` param, which is only
 * ever used to build the shell command that has to run INSIDE the distro.
 *
 * A repeated failure just replaces the still-open dialog rather than
 * stacking — see `tamaConfirmCtrl.ask`'s own "never leave a prior dialog
 * hanging" behavior.
 */
export function maybeOfferWslRefFix(err: unknown, repo: string | null): void {
  const decoded = decodeBackendError(err);
  if (!decoded || decoded.key !== KEY || !repo) return;
  const path = decoded.params.path;
  if (!path) return;
  const cmd = `sudo chown -R $(whoami) ${path}/.git/refs/gitgui`;
  void tamaConfirmCtrl
    .ask({
      title: t("terminal.wsl_ref_fix_title"),
      message: t("terminal.wsl_ref_fix_message", { cmd }),
      confirmLabel: t("terminal.wsl_ref_fix_confirm"),
      kind: "warning",
    })
    .then(async (ok) => {
      if (!ok) return;
      await terminalCtrl.toggle(repo);
      await terminalCtrl.write(`${cmd}\n`);
    });
}
