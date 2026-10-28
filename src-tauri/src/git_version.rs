//! Which git a repository's commands run under, and what it can do.
//!
//! A repo's git is Windows/macOS/Linux git, or, for a `\\wsl.localhost\<d>\`
//! repo, that distro's own git (`wsl::git_command`). They can differ by years,
//! so the version is looked up per executable and cached for the process:
//! one `git --version` per git, ever. Callers ask capability questions
//! ([`GitVersion::has_maintenance`] and friends) rather than comparing numbers,
//! so the thresholds live in one place:
//!
//!   * 2.28 — `update-ref --stdin` transactions (`start`/`prepare`/`commit`);
//!     older git still applies a plain `--stdin` batch atomically.
//!   * 2.29 — negative refspecs (`^refs/gitcat/*` on GitCat's own fetch).
//!   * 2.30 — `git maintenance` as GitCat uses it (`run --auto` on a timer).
//!
//! An unknown version (git missing, or output that doesn't parse) answers
//! every capability with `false`: the cautious path is always the old one.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::procutil::{run_with, NoConsoleWindowExt, RunOptions, SUBPROCESS_TIMEOUT};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct GitVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl GitVersion {
    pub const fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self { major, minor, patch }
    }

    /// `update-ref --stdin` understands `start`/`prepare`/`commit`.
    pub fn has_update_ref_transactions(self) -> bool {
        self >= Self::new(2, 28, 0)
    }

    /// Refspecs may start with `^` to exclude refs.
    pub fn has_negative_refspecs(self) -> bool {
        self >= Self::new(2, 29, 0)
    }

    /// `git maintenance run --auto` is available.
    pub fn has_maintenance(self) -> bool {
        self >= Self::new(2, 30, 0)
    }
}

impl std::fmt::Display for GitVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// `git version 2.45.1`, `git version 2.55.0.windows.5`, `git version 2.39.2
/// (Apple Git-143)`, `git version 2.46.0.rc1`: the first three dotted numbers
/// after "git version"; a missing patch is 0.
pub fn parse(text: &str) -> Option<GitVersion> {
    let rest = text.trim().strip_prefix("git version ")?;
    let word = rest.split_whitespace().next()?;
    let mut nums = word.split('.').map(|p| p.chars().take_while(char::is_ascii_digit).collect::<String>());
    let major = nums.next()?.parse().ok()?;
    let minor = nums.next()?.parse().ok()?;
    let patch = nums.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    Some(GitVersion { major, minor, patch })
}

/// The cache key for the git that runs `path`'s commands: `"wsl:<distro>"` or
/// `"native"`.
fn executable_key(path: &str) -> String {
    match crate::wsl::wsl_target(path) {
        Some((distro, _)) => format!("wsl:{distro}"),
        None => "native".to_string(),
    }
}

/// `git --version` for the git behind `path`, deliberately WITHOUT `-C
/// <path>`: the answer is about the executable, and a missing or odd path must
/// not fail the probe and get "unknown" cached for every repo that git runs.
fn version_command(path: &str) -> std::process::Command {
    let mut cmd = match crate::wsl::wsl_target(path) {
        Some((distro, _)) => {
            let mut c = std::process::Command::new("wsl.exe");
            c.args(["-d", &distro, "-e", "git", "--version"]);
            c
        }
        None => {
            let mut c = std::process::Command::new("git");
            c.arg("--version");
            c
        }
    };
    cmd.no_console_window();
    cmd
}

fn cache() -> &'static Mutex<HashMap<String, Option<GitVersion>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<GitVersion>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The version of the git that runs `path`'s commands, or `None` if it can't
/// be run or its output doesn't parse. Cached per executable, failures
/// included, so a missing git costs one spawn, not one per call.
pub fn for_repo(path: &str) -> Option<GitVersion> {
    let key = executable_key(path);
    if let Some(v) = cache().lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return *v;
    }
    // Not under the lock: two first callers may both probe, which is harmless,
    // and nobody waits behind a slow `wsl.exe` start.
    let probed = run_with(version_command(path), RunOptions { timeout: Some(SUBPROCESS_TIMEOUT), ..Default::default() })
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| parse(&String::from_utf8_lossy(&o.stdout)));
    if probed.is_none() {
        log::warn!("could not determine the git version for {key}; treating it as old");
    }
    cache().lock().unwrap_or_else(|e| e.into_inner()).insert(key, probed);
    probed
}

/// [`for_repo`]'s answer to one capability, `false` when the version is unknown.
pub fn repo_git_has(path: &str, capability: fn(GitVersion) -> bool) -> bool {
    for_repo(path).is_some_and(capability)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_vendor_spelling() {
        assert_eq!(parse("git version 2.45.1\n"), Some(GitVersion::new(2, 45, 1)));
        assert_eq!(parse("git version 2.55.0.windows.5"), Some(GitVersion::new(2, 55, 0)));
        assert_eq!(parse("git version 2.39.2 (Apple Git-143)"), Some(GitVersion::new(2, 39, 2)));
        assert_eq!(parse("git version 2.46.0.rc1"), Some(GitVersion::new(2, 46, 0)));
        assert_eq!(parse("git version 2.30"), Some(GitVersion::new(2, 30, 0)));
        assert_eq!(parse("git version 2.47.0-rc0"), Some(GitVersion::new(2, 47, 0)));
    }

    #[test]
    fn rejects_what_is_not_a_git_version() {
        assert_eq!(parse(""), None);
        assert_eq!(parse("hub version 2.14.2"), None);
        assert_eq!(parse("git version unknown"), None);
        assert_eq!(parse("git version 2"), None);
    }

    #[test]
    fn capability_thresholds() {
        let v = |m| GitVersion::new(2, m, 0);
        assert!(!v(27).has_update_ref_transactions() && v(28).has_update_ref_transactions());
        assert!(!v(28).has_negative_refspecs() && v(29).has_negative_refspecs());
        assert!(!v(29).has_maintenance() && v(30).has_maintenance());
        assert!(GitVersion::new(3, 0, 0).has_maintenance(), "a major bump compares above every 2.x");
    }

    #[test]
    fn keys_native_and_each_wsl_distro_apart() {
        assert_eq!(executable_key("C:\\src\\repo"), "native");
        assert_eq!(executable_key("/home/me/repo"), "native");
        assert_eq!(executable_key("\\\\wsl.localhost\\Ubuntu\\home\\me\\repo"), "wsl:Ubuntu");
        assert_eq!(executable_key("//wsl$/Debian/srv/repo"), "wsl:Debian");
    }

    #[test]
    fn a_missing_repo_path_still_finds_the_git_version() {
        // The probe is about the executable; it used to run `git -C <path>`,
        // which failed for a bad path and cached "unknown" for every repo.
        assert!(for_repo("/no/such/path/at/all").is_some());
    }

    #[test]
    fn the_local_git_is_detected_and_cached() {
        let dir = std::env::temp_dir();
        let path = dir.to_str().unwrap();
        let first = for_repo(path).expect("git is on PATH in every test environment");
        assert!(first >= GitVersion::new(2, 0, 0));
        assert_eq!(for_repo(path), Some(first));
        assert!(cache().lock().unwrap().contains_key("native"));
    }
}
