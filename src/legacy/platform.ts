// Which desktop this window is running on, for the ONE place the app's copy
// has to differ per platform: the name of the OS file manager.
//
// This is GitCat's first platform branch, and it is deliberately the only
// one. Everything else in the UI is written once and reads the same
// everywhere — the keyboard hints say ⌘ on Windows too. That is a defensible
// house style for a shortcut glyph, but not for a proper noun: telling a Mac
// user to look in "File Explorer", or a Windows user to look in "Finder",
// names an application that isn't on their machine.
//
// The user agent, not a Tauri command: the webview already knows, so a sniff
// here costs nothing, stays synchronous (menu labels are rendered during a
// right-click, with no await to hang them on), and works identically in the
// browser design mode where no Tauri backend exists at all.
//
// Leaf module — imports nothing, so it is safe for any island or for
// legacy/main.ts to pull in.

export type Platform = "windows" | "macos" | "linux";

/// Every reveal label key, so a grep for any one of them lands here.
export type RevealLabelKey = "common.reveal_windows" | "common.reveal_macos" | "common.reveal_linux";

/// Every open-the-folder label key. Separate from `RevealLabelKey` because a
/// file and a directory take different verbs — see `openDirLabelKey`.
export type OpenDirLabelKey = "common.open_dir_windows" | "common.open_dir_macos" | "common.open_dir_linux";

/**
 * Classify the running platform from a user-agent string.
 *
 * The UA is a parameter (defaulting to the live one) purely so this is
 * testable without a jsdom navigator stub.
 *
 * Windows is checked FIRST on purpose. A UA that mentions more than one
 * platform is either spoofed or an embedded webview being creative, and
 * "Windows NT" is the most specific of the three markers — checking "Linux"
 * first would misfile an X11-mentioning Windows UA, which is the classic
 * shape of this bug.
 *
 * Anything unrecognized is treated as Linux. That is not a guess about the
 * OS, it is a choice about which of three labels is least wrong: "file
 * manager" is the generic term, true on any desktop, whereas the other two
 * name a specific application.
 */
export function currentPlatform(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): Platform {
  if (ua.includes("Windows NT") || ua.includes("Win64") || ua.includes("Win32")) return "windows";
  // Chromium reports Apple silicon as "Intel Mac OS X" too, so this single
  // check covers both Mac architectures — there is no arm64 special case.
  if (ua.includes("Macintosh") || ua.includes("Mac OS X")) return "macos";
  return "linux";
}

/**
 * The i18n key for "reveal this in the OS file manager" on `platform`.
 *
 * Returns whole keys rather than assembling `"common.reveal_" + platform`:
 * a constructed key is invisible to a grep for the key, which is how a
 * locale entry gets deleted as unused and the UI quietly falls back to
 * printing the key itself.
 */
export function revealLabelKey(platform: Platform = currentPlatform()): RevealLabelKey {
  if (platform === "windows") return "common.reveal_windows";
  if (platform === "macos") return "common.reveal_macos";
  return "common.reveal_linux";
}

/**
 * The i18n key for "open this directory in the OS file manager".
 *
 * A separate family from [`revealLabelKey`] because the two actions differ,
 * not just their subject: revealing a FILE opens its containing folder with
 * the file selected, while a repo is a folder you want to land INSIDE. The
 * backend calls differ to match (`revealItemInDir` vs `openPath`), so the
 * labels have to as well — "Show in Finder" would be a lie about where the
 * repo menu takes you.
 */
export function openDirLabelKey(platform: Platform = currentPlatform()): OpenDirLabelKey {
  if (platform === "windows") return "common.open_dir_windows";
  if (platform === "macos") return "common.open_dir_macos";
  return "common.open_dir_linux";
}
