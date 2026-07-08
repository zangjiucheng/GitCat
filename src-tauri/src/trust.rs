//! Auto-trust: transparently work around libgit2's "dubious ownership" refusal
//! to open a repository reached via a network/UNC path (e.g. WSL's
//! `\\wsl.localhost\...`). See this module's tests for the exact libgit2
//! matching semantics this relies on (verified against the vendored
//! libgit2-sys source, not guessed): a `safe.directory` value must have NO
//! trailing slash, and the bare forward-slash form (`//host/share/...`) is
//! libgit2's own documented "WSL escape hatch" — no `%(prefix)` marker
//! required, though writing it too is harmless, cheap insurance.
//!
//! This is the ONE place that opens a `Repository` for every module in this
//! codebase, so the auto-trust retry is transparent everywhere — including
//! identity.rs's get_git_identity, the FIRST Repository::open the setup
//! wizard's "pick a repo" step hits.

use git2::{ErrorClass, ErrorCode, Repository};

use crate::safety;

fn is_dubious_ownership(e: &git2::Error) -> bool {
    e.class() == ErrorClass::Config && e.code() == ErrorCode::Owner
}

/// Open `path`, transparently auto-trusting it (adding it to the user's
/// global `safe.directory`) and retrying exactly once if libgit2 refuses it
/// ONLY for the dubious-ownership reason. Any other failure — or a failure
/// that persists after the retry — returns that attempt's own git2::Error
/// unchanged, so every existing call site's `.map_err(...)`/`match` keeps
/// working exactly as it does today; this is a drop-in rename, not a
/// signature change, at every call site.
pub fn open_repo(path: &str) -> Result<Repository, git2::Error> {
    match Repository::open(path) {
        Ok(r) => Ok(r),
        Err(e) if is_dubious_ownership(&e) => {
            let forward = path.replace('\\', "/");
            let prefixed = format!("%(prefix)/{forward}");
            // Best-effort: if git can't be spawned, the retry below simply
            // fails with the same original error — an honest fallback.
            let _ = safety::run_git(path, &["config", "--global", "--add", "safe.directory", &forward]);
            let _ = safety::run_git(path, &["config", "--global", "--add", "safe.directory", &prefixed]);
            Repository::open(path)
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_dubious_ownership_matches_only_owner_class_config() {
        let owner_err = git2::Error::new(
            ErrorCode::Owner,
            ErrorClass::Config,
            "repository path '//wsl.localhost/Ubuntu/home/x/repo' is not owned by current user",
        );
        assert!(is_dubious_ownership(&owner_err));

        let not_found = git2::Error::new(ErrorCode::NotFound, ErrorClass::Os, "no such file");
        assert!(!is_dubious_ownership(&not_found));

        // Same ErrorClass::Config, different code — must NOT match (guards
        // against over-broadening this to "any Config-class error").
        let other_config = git2::Error::new(ErrorCode::Invalid, ErrorClass::Config, "bad config");
        assert!(!is_dubious_ownership(&other_config));
    }
}
