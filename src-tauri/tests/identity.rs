//! Setup wizard's / Settings' git identity commands — real end-to-end
//! coverage against an actual `git` binary and a throwaway repo (see
//! `tests/common/mod.rs`).
//!
//! The most important property under test is that `set_git_identity` NEVER
//! writes the host's real global git config — it always passes an explicit
//! `--local` to the git CLI, which is documented, unambiguous scoping — this
//! suite proves it two ways: (a) the written value round-trips through
//! `git config --local --get` on the temp repo, and (b) the host's REAL
//! global `user.name`/`user.email` (read, never written, via a plain
//! `git config --global --get`) are byte-identical before and after. (b)
//! deliberately never writes anywhere outside the temp repo, so it's safe to
//! run on a developer machine or CI runner with a real ~/.gitconfig.
//!
//! `get_git_identity`, by contrast, DOES read `--global` (see identity.rs's
//! own module doc for why: it reports the identity a commit would actually
//! use, falling back to global when the repo has no local override). Tests
//! that exercise this fallback deliberately do NOT assert a hardcoded
//! expected value (there is no way to know whether the machine running this
//! suite has a real global identity configured) — they instead cross-check
//! against `real_global()`, the same "compare against whatever's actually
//! there" technique (b) above already established, so the suite passes
//! identically whether or not the host has one.

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
    let id = tauri::async_runtime::block_on(get_git_identity(path)).expect("get_git_identity failed");
    assert!(id.configured);
    assert!(id.local, "both fields are set locally — this must read as a local override");
    assert_eq!(id.name.as_deref(), Some("GitCat Test"));
    assert_eq!(id.email.as_deref(), Some("test@gitcat.example"));
}

#[test]
fn get_git_identity_falls_back_to_the_real_global_identity_when_local_is_unset() {
    let repo = TempRepo::init("identity_unset");
    repo.must(&["config", "--local", "--unset", "user.name"]);
    repo.must(&["config", "--local", "--unset", "user.email"]);
    let path = repo.path();

    // Cross-check against the REAL global config rather than asserting a
    // hardcoded expectation — see this file's own module doc for why.
    let global_name = real_global("user.name");
    let global_email = real_global("user.email");

    let id = tauri::async_runtime::block_on(get_git_identity(path)).expect("get_git_identity failed");
    assert!(!id.local, "nothing is set locally anymore");
    assert_eq!(id.name, global_name, "with no local override, the effective name must be exactly the real global one");
    assert_eq!(id.email, global_email, "with no local override, the effective email must be exactly the real global one");
    assert_eq!(id.configured, global_name.is_some() && global_email.is_some());
}

#[test]
fn get_git_identity_mixes_a_partial_local_override_with_the_real_global_identity() {
    let repo = TempRepo::init("identity_partial");
    repo.must(&["config", "--local", "--unset", "user.email"]);
    let path = repo.path();

    let id = tauri::async_runtime::block_on(get_git_identity(path)).expect("get_git_identity failed");
    let global_email = real_global("user.email");

    // Name is unaffected — it's still set locally, wins regardless of global.
    assert_eq!(id.name.as_deref(), Some("GitCat Test"));
    assert!(!id.local, "only one of the two fields is local — not fully local");
    // Email falls back to whatever the real global config resolves to.
    assert_eq!(id.email, global_email);
    assert_eq!(id.configured, global_email.is_some(), "configured now hinges only on whether email resolves from anywhere");
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

    let result = tauri::async_runtime::block_on(get_git_identity(dir.to_string_lossy().to_string()));
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

    let res = tauri::async_runtime::block_on(set_git_identity(
        path.clone(),
        "Setup Wizard Test User".to_string(),
        "setup-wizard-test@example.invalid".to_string(),
    ));
    assert!(res.ok, "set_git_identity failed: {}", res.message);

    // (a) the value landed in THIS repo's local config.
    let (_, local_name, _) = repo.git(&["config", "--local", "--get", "user.name"]);
    let (_, local_email, _) = repo.git(&["config", "--local", "--get", "user.email"]);
    assert_eq!(local_name.trim(), "Setup Wizard Test User");
    assert_eq!(local_email.trim(), "setup-wizard-test@example.invalid");

    // Cross-check via get_git_identity too.
    let id = tauri::async_runtime::block_on(get_git_identity(path)).expect("get_git_identity failed");
    assert!(id.configured);
    assert!(id.local, "just wrote both fields locally");
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

    let res = tauri::async_runtime::block_on(set_git_identity(path.clone(), "  ".to_string(), "a@b.c".to_string()));
    assert!(!res.ok, "blank name must be rejected");

    let res = tauri::async_runtime::block_on(set_git_identity(path, "A".to_string(), "  ".to_string()));
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

    let res = tauri::async_runtime::block_on(set_git_identity(
        dir.to_string_lossy().to_string(),
        "A".to_string(),
        "a@b.c".to_string(),
    ));
    assert!(!res.ok, "a non-repository path must fail, not panic");

    let _ = std::fs::remove_dir_all(&dir);
}
