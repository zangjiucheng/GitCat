//! `git_config.rs`'s generic per-key local/global read+write — real
//! end-to-end coverage against an actual `git` binary and a throwaway repo
//! (see `tests/common/mod.rs`).
//!
//! GLOBAL-scope tests never touch the REAL host `~/.gitconfig`: the one test
//! that writes `--global` redirects git's global config location to a
//! throwaway temp file via the `GIT_CONFIG_GLOBAL` env var, for the duration
//! of that one test only, and proves the real host global is byte-identical
//! before and after — same "compare against whatever's actually there"
//! discipline `tests/identity.rs` already established for reads, extended
//! here to a write. `std::env::set_var` is PROCESS-WIDE (not per-thread),
//! and cargo runs this file's tests on multiple threads by default, so
//! `ENV_GUARD` serializes every test here that touches the env var — no two
//! can ever race. Every other test here is confined to `--local`, which
//! needs no such guard (isolated by construction, like any other TempRepo
//! test).

mod common;

use std::sync::Mutex;

use common::TempRepo;
use gitcat_lib::git_config::{get_git_config_values, list_git_config_entries, set_git_config_value, ConfigScope};

static ENV_GUARD: Mutex<()> = Mutex::new(());

/// Read the host's REAL global config (never written here) — same helper
/// shape as `tests/identity.rs`'s own `real_global`.
fn real_global(key: &str) -> Option<String> {
    let out = std::process::Command::new("git").args(["config", "--global", "--get", key]).output().expect("failed to run git");
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

fn scratch_dir(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "gitcat-test-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ))
}

#[test]
fn get_returns_none_for_an_entirely_unset_key() {
    let repo = TempRepo::init("gitconfig_unset");
    let path = repo.path();

    let entries = tauri::async_runtime::block_on(get_git_config_values(path, vec!["gitcat-test.totally-made-up-key".to_string()]))
        .expect("get_git_config_values failed");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].key, "gitcat-test.totally-made-up-key");
    assert_eq!(entries[0].local, None);
    assert_eq!(entries[0].global, None, "no real machine should have this made-up key set globally");
    assert_eq!(entries[0].effective, None);
}

#[test]
fn get_reads_multiple_keys_in_one_call() {
    let repo = TempRepo::init("gitconfig_multi");
    repo.must(&["config", "--local", "core.autocrlf", "input"]);
    repo.must(&["config", "--local", "pull.rebase", "true"]);
    let path = repo.path();

    let entries = tauri::async_runtime::block_on(get_git_config_values(
        path,
        vec!["core.autocrlf".to_string(), "pull.rebase".to_string(), "gitcat-test.unset".to_string()],
    ))
    .expect("get_git_config_values failed");
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].effective.as_deref(), Some("input"));
    assert_eq!(entries[1].effective.as_deref(), Some("true"));
    assert_eq!(entries[2].effective, None);
}

#[test]
fn set_local_then_get_reflects_it() {
    let repo = TempRepo::init("gitconfig_local_write");
    let path = repo.path();

    let res = tauri::async_runtime::block_on(set_git_config_value(
        path.clone(),
        "core.autocrlf".to_string(),
        Some("input".to_string()),
        ConfigScope::Local,
    ));
    assert!(res.ok, "set_git_config_value failed: {}", res.message);

    let (_, val, _) = repo.git(&["config", "--local", "--get", "core.autocrlf"]);
    assert_eq!(val.trim(), "input");

    let entries = tauri::async_runtime::block_on(get_git_config_values(path, vec!["core.autocrlf".to_string()])).expect("get failed");
    assert_eq!(entries[0].local.as_deref(), Some("input"));
    assert_eq!(entries[0].effective.as_deref(), Some("input"));
}

#[test]
fn unsetting_a_local_key_removes_it() {
    let repo = TempRepo::init("gitconfig_unset_local");
    let path = repo.path();
    let set = tauri::async_runtime::block_on(set_git_config_value(
        path.clone(),
        "core.autocrlf".to_string(),
        Some("true".to_string()),
        ConfigScope::Local,
    ));
    assert!(set.ok);

    let unset = tauri::async_runtime::block_on(set_git_config_value(path.clone(), "core.autocrlf".to_string(), None, ConfigScope::Local));
    assert!(unset.ok, "unset failed: {}", unset.message);

    let (ok, _, _) = repo.git(&["config", "--local", "--get", "core.autocrlf"]);
    assert!(!ok, "key should no longer be set locally");

    let entries = tauri::async_runtime::block_on(get_git_config_values(path, vec!["core.autocrlf".to_string()])).expect("get failed");
    assert_eq!(entries[0].local, None);
}

#[test]
fn unsetting_an_already_unset_key_is_idempotent_not_an_error() {
    let repo = TempRepo::init("gitconfig_unset_idempotent");
    let path = repo.path();
    let res = tauri::async_runtime::block_on(set_git_config_value(path, "gitcat-test.never-set".to_string(), None, ConfigScope::Local));
    assert!(res.ok, "unsetting an already-unset key must succeed, not error: {}", res.message);
}

#[test]
fn rejects_a_malformed_key() {
    let repo = TempRepo::init("gitconfig_bad_key");
    let path = repo.path();
    let res =
        tauri::async_runtime::block_on(set_git_config_value(path, "not-a-valid-key".to_string(), Some("x".to_string()), ConfigScope::Local));
    assert!(!res.ok, "a key with no dot must be rejected");
}

#[test]
fn rejects_a_value_that_looks_like_a_flag() {
    let repo = TempRepo::init("gitconfig_flaglike_value");
    let path = repo.path();
    let res =
        tauri::async_runtime::block_on(set_git_config_value(path, "core.editor".to_string(), Some("--evil".to_string()), ConfigScope::Local));
    assert!(!res.ok);
}

#[test]
fn get_errors_on_a_path_that_is_not_a_repository() {
    let dir = scratch_dir("not-a-repo-gitconfig-get");
    std::fs::create_dir_all(&dir).expect("mkdir scratch dir");

    let result = tauri::async_runtime::block_on(get_git_config_values(dir.to_string_lossy().to_string(), vec!["core.autocrlf".to_string()]));
    assert!(result.is_err(), "a non-repository path must error");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn set_fails_cleanly_on_a_path_that_is_not_a_repository() {
    let dir = scratch_dir("not-a-repo-gitconfig-set");
    std::fs::create_dir_all(&dir).expect("mkdir scratch dir");

    let res = tauri::async_runtime::block_on(set_git_config_value(
        dir.to_string_lossy().to_string(),
        "core.autocrlf".to_string(),
        Some("true".to_string()),
        ConfigScope::Local,
    ));
    assert!(!res.ok, "a non-repository path must fail, not panic");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn list_reflects_locally_set_entries_and_keeps_duplicate_keys_separate() {
    let repo = TempRepo::init("gitconfig_list_local");
    repo.must(&["config", "--local", "--add", "gitcat-test.multi", "one"]);
    repo.must(&["config", "--local", "--add", "gitcat-test.multi", "two"]);
    let path = repo.path();

    let entries = tauri::async_runtime::block_on(list_git_config_entries(path, ConfigScope::Local)).expect("list failed");
    let multi: Vec<&String> = entries.iter().filter(|e| e.key == "gitcat-test.multi").map(|e| &e.value).collect();
    assert_eq!(multi.len(), 2, "a genuinely multi-valued key must show as two separate rows, not collapse to one");
    assert!(multi.contains(&&"one".to_string()));
    assert!(multi.contains(&&"two".to_string()));
}

#[test]
fn list_errors_on_a_path_that_is_not_a_repository() {
    let dir = scratch_dir("not-a-repo-gitconfig-list");
    std::fs::create_dir_all(&dir).expect("mkdir scratch dir");

    let result = tauri::async_runtime::block_on(list_git_config_entries(dir.to_string_lossy().to_string(), ConfigScope::Local));
    assert!(result.is_err());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn set_global_writes_to_an_isolated_fake_global_config_never_the_real_one() {
    let _guard = ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let repo = TempRepo::init("gitconfig_global_write");
    let path = repo.path();

    let fake_global_dir = scratch_dir("fake-global");
    std::fs::create_dir_all(&fake_global_dir).expect("mkdir fake global dir");
    let fake_global_file = fake_global_dir.join(".gitconfig");

    // Snapshot the REAL global value before touching anything, so we can
    // prove afterward it's byte-identical.
    let real_before = real_global("gitcat-test.global-write-marker");
    assert_eq!(real_before, None, "this made-up key should not already exist in any real developer's global config");

    // SAFETY: guarded by ENV_GUARD above — no other test in this binary can
    // observe GIT_CONFIG_GLOBAL while it's overridden for this one test.
    unsafe {
        std::env::set_var("GIT_CONFIG_GLOBAL", &fake_global_file);
    }
    let res = tauri::async_runtime::block_on(set_git_config_value(
        path.clone(),
        "gitcat-test.global-write-marker".to_string(),
        Some("wrote-it".to_string()),
        ConfigScope::Global,
    ));
    let entries_result =
        tauri::async_runtime::block_on(get_git_config_values(path, vec!["gitcat-test.global-write-marker".to_string()]));
    unsafe {
        std::env::remove_var("GIT_CONFIG_GLOBAL");
    }

    assert!(res.ok, "set_git_config_value (global) failed: {}", res.message);
    let written = std::fs::read_to_string(&fake_global_file).unwrap_or_default();
    assert!(written.contains("global-write-marker"), "the isolated fake global file should contain the written key: {written:?}");

    let entries = entries_result.expect("get_git_config_values failed");
    assert_eq!(
        entries[0].global.as_deref(),
        Some("wrote-it"),
        "read-back through get_git_config_values must see the isolated fake global, not inherit anything real"
    );

    let real_after = real_global("gitcat-test.global-write-marker");
    assert_eq!(real_before, real_after, "the REAL host global config must be byte-for-byte untouched");

    let _ = std::fs::remove_dir_all(&fake_global_dir);
}
