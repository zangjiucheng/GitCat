import { describe, it, expect, vi, beforeEach } from "vitest";
import { maybeOfferWslRefFix } from "./wslReffix.ts";
import { tamaConfirmCtrl } from "../islands/tamaconfirm/tamaconfirm.svelte.ts";
import { terminalCtrl } from "../islands/terminal/terminal.svelte.ts";

vi.mock("../islands/tamaconfirm/tamaconfirm.svelte.ts", () => ({
  tamaConfirmCtrl: { ask: vi.fn() },
}));
vi.mock("../islands/terminal/terminal.svelte.ts", () => ({
  terminalCtrl: { toggle: vi.fn(), write: vi.fn() },
}));

const REPO = "\\\\wsl.localhost\\Ubuntu\\home\\j\\repo";
const PERMISSION_ERR = "i18n:err_misc.wsl_ref_permission_denied\x1fpath\x1f/home/j/repo\x1fdetail\x1fboom";

describe("maybeOfferWslRefFix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores raw (non-i18n) git stderr", () => {
    maybeOfferWslRefFix("fatal: not a git repository", REPO);
    expect(tamaConfirmCtrl.ask).not.toHaveBeenCalled();
  });

  it("ignores an i18n-keyed error under a different key", () => {
    maybeOfferWslRefFix("i18n:err_misc.could_not_run_git\x1fdetail\x1fboom", REPO);
    expect(tamaConfirmCtrl.ask).not.toHaveBeenCalled();
  });

  it("ignores the right key when no repo is open", () => {
    maybeOfferWslRefFix(PERMISSION_ERR, null);
    expect(tamaConfirmCtrl.ask).not.toHaveBeenCalled();
  });

  it("asks first, then opens the terminal on the app's own repo path and runs the fix in the linux path from the error", async () => {
    vi.mocked(tamaConfirmCtrl.ask).mockResolvedValue(true);
    maybeOfferWslRefFix(PERMISSION_ERR, REPO);

    expect(tamaConfirmCtrl.ask).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(terminalCtrl.write).toHaveBeenCalled());

    // The terminal is opened on the app's own (Windows UNC) repo path —
    // never the bare linux path the error carries, which terminalCtrl.toggle
    // could not route through wsl.exe at all.
    expect(terminalCtrl.toggle).toHaveBeenCalledWith(REPO);
    expect(terminalCtrl.write).toHaveBeenCalledWith("sudo chown -R $(whoami) /home/j/repo/.git/refs/gitgui\n");
  });

  it("does nothing further when the user cancels the dialog", async () => {
    vi.mocked(tamaConfirmCtrl.ask).mockResolvedValue(false);
    maybeOfferWslRefFix(PERMISSION_ERR, REPO);

    await vi.waitFor(() => expect(tamaConfirmCtrl.ask).toHaveBeenCalledTimes(1));
    // Let the .then(ok => ...) microtask run before asserting the negative.
    await Promise.resolve();
    await Promise.resolve();
    expect(terminalCtrl.toggle).not.toHaveBeenCalled();
    expect(terminalCtrl.write).not.toHaveBeenCalled();
  });
});
