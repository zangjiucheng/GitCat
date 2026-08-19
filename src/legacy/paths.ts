// Path joining for "Copy full path" — the one place the app turns git's own
// repo-relative spelling into something a user can paste into a shell or a
// file-manager address bar.
//
// The separator is taken from the REPO path rather than from the running
// platform. Those agree most of the time, but not always: a WSL repo opened
// from Windows is a `\\wsl.localhost\…` UNC path whose contents are a Linux
// filesystem, and a path assembled from `navigator.platform` would get one of
// the two halves wrong. The repo path is the one spelling we know the OS
// itself produced.
//
// Leaf module — imports nothing.

/**
 * Join a repo-relative path (git's own form, always forward-slashed) onto its
 * repo path, in the repo's own separator style.
 *
 * With no repo — possible for a frame while one is being opened or closed —
 * the relative path is returned unchanged, which is a more useful thing to
 * land on the clipboard than a path with `undefined` in it.
 */
export function joinRepoPath(repo: string, relative: string): string {
  if (!repo) return relative;
  const windowsish = repo.includes("\\");
  const sep = windowsish ? "\\" : "/";
  const base = repo.endsWith("\\") || repo.endsWith("/") ? repo.slice(0, -1) : repo;
  // split/join rather than replaceAll: the tsconfig lib predates ES2021.
  const rel = windowsish ? relative.split("/").join("\\") : relative;
  return base + sep + rel;
}
