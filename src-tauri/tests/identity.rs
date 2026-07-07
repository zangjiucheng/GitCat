//! Setup wizard's git identity commands — real end-to-end coverage against an
//! actual `git` binary and a throwaway repo (see `tests/common/mod.rs`).
//!
//! The most important property under test is that `set_git_identity` NEVER
//! writes the host's real global git config. `get_git_identity`/
//! `set_git_identity` always pass an explicit `--local` to the git CLI, which
//! is documented, unambiguous scoping — this suite proves it two ways: (a)
//! the written value round-trips through `git config --local --get` on the
//! temp repo, and (b) the host's REAL global `user.name`/`user.email` (read,
//! never written, via a plain unscoped `git config --global --get`) are
//! byte-identical before and after. (b) deliberately never writes anywhere
//! outside the temp repo, so it's safe to run on a developer machine or CI
//! runner with a real ~/.gitconfig.

mod common;

use common::TempRepo;
use gitcat_lib::identity::{get_git_identity, set_git_identity};

/// Read the host's REAL global config (not `TempRepo::git`, which isolates
/// `GIT_CONFIG_GLOBAL` to `/dev/null` for its own calls — we want the actual
/// ambient value here, precisely so we can prove it's untouched). Returns
/// `None` if the key isn't set globally at all.
fn real_global(key: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["config", "--global", "--get", key])
        .output()
        .expect("failed to run git");
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

#[test]
fn get_git_identity_reports_the_repo_local_identity_temprepo_already_sets() {
    let repo = TempRepo::init("identity_read");
    let path = repo.path();

    // TempRepo::init already sets a repo-local identity (see common/mod.rs).
    let id = get_git_identity(path).expect("get_git_identity failed");
    assert!(id.configured);
    assert_eq!(id.name.as_deref(), Some("GitCat Test"));
    assert_eq!(id.email.as_deref(), Some("test@gitcat.example"));
}

#[test]
fn get_git_identity_reports_unconfigured_when_local_identity_is_unset() {
    let repo = TempRepo::init("identity_unset");
    repo.must(&["config", "--local", "--unset", "user.name"]);
    repo.must(&["config", "--local", "--unset", "user.email"]);
    let path = repo.path();

    let id = get_git_identity(path).expect("get_git_identity failed");
    assert!(!id.configured);
    assert_eq!(id.name, None);
    assert_eq!(id.email, None);
}

#[test]
fn get_git_identity_reports_partial_identity_as_unconfigured() {
    let repo = TempRepo::init("identity_partial");
    repo.must(&["config", "--local", "--unset", "user.email"]);
    let path = repo.path();

    let id = get_git_identity(path).expect("get_git_identity failed");
    assert!(!id.configured, "only name is set — configured must be false");
    assert_eq!(id.name.as_deref(), Some("GitCat Test"));
    assert_eq!(id.email, None);
}

#[test]
fn get_git_identity_errors_on_a_path_that_is_not_a_repository() {
    let dir = std::env::temp_dir().join(format!(
        "gitcat-test-not-a-repo-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("mkdir scratch dir");

    let result = get_git_identity(dir.to_string_lossy().to_string());
    assert!(result.is_err(), "a non-repository path must error");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn set_git_identity_writes_local_config_and_never_touches_the_real_global_config() {
    let repo = TempRepo::init("identity_write");
    repo.must(&["config", "--local", "--unset", "user.name"]);
    repo.must(&["config", "--local", "--unset", "user.email"]);
    let path = repo.path();

    // Snapshot the REAL global config before touching anything.
    let global_name_before = real_global("user.name");
    let global_email_before = real_global("user.email");

    let res = set_git_identity(
        path.clone(),
        "Setup Wizard Test User".to_string(),
        "setup-wizard-test@example.invalid".to_string(),
    );
    assert!(res.ok, "set_git_identity failed: {}", res.message);

    // (a) the value landed in THIS repo's local config.
    let (_, local_name, _) = repo.git(&["config", "--local", "--get", "user.name"]);
    let (_, local_email, _) = repo.git(&["config", "--local", "--get", "user.email"]);
    assert_eq!(local_name.trim(), "Setup Wizard Test User");
    assert_eq!(local_email.trim(), "setup-wizard-test@example.invalid");

    // Cross-check via get_git_identity too.
    let id = get_git_identity(path).expect("get_git_identity failed");
    assert!(id.configured);
    assert_eq!(id.name.as_deref(), Some("Setup Wizard Test User"));
    assert_eq!(id.email.as_deref(), Some("setup-wizard-test@example.invalid"));

    // (b) the REAL global config is byte-identical to before — proves the
    // write never escaped `--local`.
    let global_name_after = real_global("user.name");
    let global_email_after = real_global("user.email");
    assert_eq!(global_name_before, global_name_after, "global user.name must be untouched");
    assert_eq!(global_email_before, global_email_after, "global user.email must be untouched");
}

#[test]
fn set_git_identity_rejects_empty_name_or_email() {
    let repo = TempRepo::init("identity_empty");
    let path = repo.path();

    let res = set_git_identity(path.clone(), "  ".to_string(), "a@b.c".to_string());
    assert!(!res.ok, "blank name must be rejected");

    let res = set_git_identity(path, "A".to_string(), "  ".to_string());
    assert!(!res.ok, "blank email must be rejected");
}

#[test]
fn set_git_identity_errors_on_a_path_that_is_not_a_repository() {
    let dir = std::env::temp_dir().join(format!(
        "gitcat-test-not-a-repo-write-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("mkdir scratch dir");

    let res = set_git_identity(
        dir.to_string_lossy().to_string(),
        "A".to_string(),
        "a@b.c".to_string(),
    );
    assert!(!res.ok, "a non-repository path must fail, not panic");

    let _ = std::fs::remove_dir_all(&dir);
}
