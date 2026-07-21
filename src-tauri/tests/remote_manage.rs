//! Remote CONFIG CRUD (list_remotes / add_remote / rename_remote /
//! set_remote_url / remove_remote) — model after tests/remote_ops.rs (which
//! covers fetch/pull/push, the NETWORK half) and tests/git_tag.rs (the
//! sibling small-CRUD-module test shape this module actually mirrors). Every
//! remote here is a plain local filesystem path (a bare temp repo) — no
//! network access needed, matching remote_ops.rs's own approach, though
//! most of these tests don't even need the remote to exist since add/
//! rename/set-url/remove/list only ever touch `.git/config`.

mod common;

use common::TempRepo;
use gitcat_lib::git_remote_manage::{add_remote, list_remotes, remove_remote, rename_remote, set_remote_url};

fn must_err<T>(r: Result<T, String>, ctx: &str) -> String {
    match r {
        Ok(_) => panic!("{ctx}: expected Err, got Ok"),
        Err(e) => e,
    }
}

// ---------------------------------------------------------------------------
// add then list_remotes shows it
// ---------------------------------------------------------------------------

#[test]
fn add_remote_then_list_shows_it() {
    let repo = TempRepo::init("remote_add_list");
    let path = repo.path();

    let res = tauri::async_runtime::block_on(add_remote(path.clone(), "origin".into(), "https://example.com/repo.git".into()));
    assert!(res.ok, "add_remote failed: {}", res.message);
    assert!(res.backup_ref.is_none(), "remote config CRUD never snapshots");

    let remotes = tauri::async_runtime::block_on(list_remotes(path.clone())).expect("list_remotes should succeed");
    assert_eq!(remotes.len(), 1);
    assert_eq!(remotes[0].name, "origin");
    assert_eq!(remotes[0].url, "https://example.com/repo.git");
    assert!(remotes[0].push_url.is_none(), "no pushurl configured -> None");
}

#[test]
fn list_remotes_is_empty_for_a_fresh_repo() {
    let repo = TempRepo::init("remote_list_empty");
    let remotes = tauri::async_runtime::block_on(list_remotes(repo.path())).expect("list_remotes should succeed");
    assert!(remotes.is_empty());
}

#[test]
fn list_remotes_reports_a_distinct_push_url_but_collapses_an_identical_one() {
    let repo = TempRepo::init("remote_list_pushurl");
    let path = repo.path();
    tauri::async_runtime::block_on(add_remote(path.clone(), "origin".into(), "https://example.com/fetch.git".into()));
    repo.must(&["remote", "set-url", "--push", "origin", "git@example.com:push.git"]);

    let remotes = tauri::async_runtime::block_on(list_remotes(path.clone())).expect("list_remotes should succeed");
    assert_eq!(remotes.len(), 1);
    assert_eq!(remotes[0].url, "https://example.com/fetch.git");
    assert_eq!(remotes[0].push_url.as_deref(), Some("git@example.com:push.git"));

    // An identical pushurl (same as fetch url) must collapse to None, not a
    // confusing duplicate-looking row.
    repo.must(&["remote", "set-url", "--push", "origin", "https://example.com/fetch.git"]);
    let remotes2 = tauri::async_runtime::block_on(list_remotes(path)).expect("list_remotes should succeed");
    assert_eq!(remotes2[0].push_url, None, "an identical pushurl must collapse to None");
}

#[test]
fn list_remotes_is_sorted_by_name() {
    let repo = TempRepo::init("remote_list_sorted");
    let path = repo.path();
    tauri::async_runtime::block_on(add_remote(path.clone(), "zeta".into(), "https://example.com/z.git".into()));
    tauri::async_runtime::block_on(add_remote(path.clone(), "alpha".into(), "https://example.com/a.git".into()));

    let remotes = tauri::async_runtime::block_on(list_remotes(path)).expect("list_remotes should succeed");
    let names: Vec<&str> = remotes.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, vec!["alpha", "zeta"]);
}

// ---------------------------------------------------------------------------
// add a duplicate name is refused
// ---------------------------------------------------------------------------

#[test]
fn add_remote_refuses_a_duplicate_name() {
    let repo = TempRepo::init("remote_add_dup");
    let path = repo.path();
    let first = tauri::async_runtime::block_on(add_remote(path.clone(), "origin".into(), "https://example.com/one.git".into()));
    assert!(first.ok, "first add_remote failed: {}", first.message);

    let dup = tauri::async_runtime::block_on(add_remote(path.clone(), "origin".into(), "https://example.com/two.git".into()));
    assert!(!dup.ok, "adding a duplicate remote name must be refused");
    assert!(
        dup.message.to_lowercase().contains("already exists"),
        "expected git's own 'already exists' message, got: {}",
        dup.message
    );

    // The original config entry must be untouched by the refused duplicate add.
    let remotes = tauri::async_runtime::block_on(list_remotes(path)).expect("list_remotes should succeed");
    assert_eq!(remotes.len(), 1);
    assert_eq!(remotes[0].url, "https://example.com/one.git");
}

// ---------------------------------------------------------------------------
// rename then list_remotes reflects the new name and the old name is gone
// ---------------------------------------------------------------------------

#[test]
fn rename_remote_updates_the_name_and_removes_the_old_one() {
    let repo = TempRepo::init("remote_rename");
    let path = repo.path();
    tauri::async_runtime::block_on(add_remote(path.clone(), "origin".into(), "https://example.com/repo.git".into()));

    let res = tauri::async_runtime::block_on(rename_remote(path.clone(), "origin".into(), "upstream".into()));
    assert!(res.ok, "rename_remote failed: {}", res.message);
    assert!(res.backup_ref.is_none());

    let remotes = tauri::async_runtime::block_on(list_remotes(path)).expect("list_remotes should succeed");
    assert_eq!(remotes.len(), 1);
    assert_eq!(remotes[0].name, "upstream");
    assert_eq!(remotes[0].url, "https://example.com/repo.git");
    assert!(remotes.iter().all(|r| r.name != "origin"), "the old name must be gone");
}

#[test]
fn rename_remote_moves_the_remote_tracking_refs() {
    let origin = TempRepo::init_bare("remote_rename_refs-origin");
    let local = TempRepo::init("remote_rename_refs-local");
    local.commit("f.txt", "0\n", "c0");
    local.must(&["remote", "add", "origin", &origin.path()]);
    local.must(&["push", "-q", "origin", "main"]); // give origin a branch for fetch to find
    local.must(&["fetch", "-q", "origin"]);
    assert!(local.rev("refs/remotes/origin/main").is_some(), "sanity: tracking ref exists before rename");

    let res = tauri::async_runtime::block_on(rename_remote(local.path(), "origin".into(), "upstream".into()));
    assert!(res.ok, "rename_remote failed: {}", res.message);

    assert!(
        local.rev("refs/remotes/origin/main").is_none(),
        "the OLD remote's tracking refs must be gone after rename"
    );
    assert!(
        local.rev("refs/remotes/upstream/main").is_some(),
        "the NEW remote name must own the moved tracking refs"
    );
}

#[test]
fn rename_remote_refuses_an_unknown_name() {
    let repo = TempRepo::init("remote_rename_unknown");
    let err = tauri::async_runtime::block_on(rename_remote(repo.path(), "nope".into(), "somewhere".into()));
    assert!(!err.ok, "renaming a nonexistent remote must be refused");
}

// ---------------------------------------------------------------------------
// set_remote_url changes the URL
// ---------------------------------------------------------------------------

#[test]
fn set_remote_url_changes_the_url() {
    let repo = TempRepo::init("remote_set_url");
    let path = repo.path();
    tauri::async_runtime::block_on(add_remote(path.clone(), "origin".into(), "https://example.com/old.git".into()));

    let res = tauri::async_runtime::block_on(set_remote_url(path.clone(), "origin".into(), "https://example.com/new.git".into()));
    assert!(res.ok, "set_remote_url failed: {}", res.message);

    let remotes = tauri::async_runtime::block_on(list_remotes(path)).expect("list_remotes should succeed");
    assert_eq!(remotes.len(), 1);
    assert_eq!(remotes[0].name, "origin", "set-url must not rename the remote");
    assert_eq!(remotes[0].url, "https://example.com/new.git");
}

#[test]
fn set_remote_url_refuses_an_unknown_name() {
    let repo = TempRepo::init("remote_set_url_unknown");
    let res = tauri::async_runtime::block_on(set_remote_url(repo.path(), "nope".into(), "https://example.com/x.git".into()));
    assert!(!res.ok, "set_remote_url on an unknown remote must be refused");
}

// ---------------------------------------------------------------------------
// remove_remote removes it from list_remotes
// ---------------------------------------------------------------------------

#[test]
fn remove_remote_removes_it_from_the_list() {
    let repo = TempRepo::init("remote_remove");
    let path = repo.path();
    tauri::async_runtime::block_on(add_remote(path.clone(), "origin".into(), "https://example.com/repo.git".into()));
    assert_eq!(tauri::async_runtime::block_on(list_remotes(path.clone())).unwrap().len(), 1);

    let res = tauri::async_runtime::block_on(remove_remote(path.clone(), "origin".into()));
    assert!(res.ok, "remove_remote failed: {}", res.message);
    assert!(res.backup_ref.is_none(), "remove_remote never snapshots — see module doc for why");

    let remotes = tauri::async_runtime::block_on(list_remotes(path)).expect("list_remotes should succeed");
    assert!(remotes.is_empty());
}

#[test]
fn remove_remote_also_deletes_its_tracking_refs() {
    let origin = TempRepo::init_bare("remote_remove_refs-origin");
    let local = TempRepo::init("remote_remove_refs-local");
    local.commit("f.txt", "0\n", "c0");
    local.must(&["remote", "add", "origin", &origin.path()]);
    local.must(&["push", "-q", "origin", "main"]); // give origin a branch for fetch to find
    local.must(&["fetch", "-q", "origin"]);
    assert!(local.rev("refs/remotes/origin/main").is_some(), "sanity: tracking ref exists before remove");

    let res = tauri::async_runtime::block_on(remove_remote(local.path(), "origin".into()));
    assert!(res.ok, "remove_remote failed: {}", res.message);
    assert!(
        local.rev("refs/remotes/origin/main").is_none(),
        "remove_remote must delete the remote's own remote-tracking refs (real git behavior)"
    );
}

#[test]
fn remove_remote_refuses_an_unknown_name() {
    let repo = TempRepo::init("remote_remove_unknown");
    let res = tauri::async_runtime::block_on(remove_remote(repo.path(), "nope".into()));
    assert!(!res.ok, "removing a nonexistent remote must be refused");
}

// ---------------------------------------------------------------------------
// a remote name starting with "-" is refused by every write command
// ---------------------------------------------------------------------------

#[test]
fn every_write_command_refuses_a_flag_like_remote_name() {
    let repo = TempRepo::init("remote_flag_injection");
    let path = repo.path();
    // Seed one real remote so rename/set-url/remove have something legitimate
    // to target with a bad SECOND argument, isolating which argument tripped
    // the refusal.
    tauri::async_runtime::block_on(add_remote(path.clone(), "origin".into(), "https://example.com/repo.git".into()));

    let bad_name = "--upload-pack=evil";

    let add = tauri::async_runtime::block_on(add_remote(path.clone(), bad_name.into(), "https://example.com/x.git".into()));
    assert!(!add.ok, "add_remote must refuse a flag-like name");
    assert!(add.message.contains("flag"), "expected a flag-injection message, got: {}", add.message);

    let rename_from_bad = tauri::async_runtime::block_on(rename_remote(path.clone(), bad_name.into(), "somewhere".into()));
    assert!(!rename_from_bad.ok, "rename_remote must refuse a flag-like old_name");
    assert!(rename_from_bad.message.contains("flag"), "got: {}", rename_from_bad.message);

    let rename_to_bad = tauri::async_runtime::block_on(rename_remote(path.clone(), "origin".into(), bad_name.into()));
    assert!(!rename_to_bad.ok, "rename_remote must refuse a flag-like new_name");
    assert!(rename_to_bad.message.contains("flag"), "got: {}", rename_to_bad.message);

    let set_url = tauri::async_runtime::block_on(set_remote_url(path.clone(), bad_name.into(), "https://example.com/x.git".into()));
    assert!(!set_url.ok, "set_remote_url must refuse a flag-like name");
    assert!(set_url.message.contains("flag"), "got: {}", set_url.message);

    let remove = tauri::async_runtime::block_on(remove_remote(path.clone(), bad_name.into()));
    assert!(!remove.ok, "remove_remote must refuse a flag-like name");
    assert!(remove.message.contains("flag"), "got: {}", remove.message);

    // The seeded remote must be completely untouched by every refused call above.
    let remotes = tauri::async_runtime::block_on(list_remotes(path)).expect("list_remotes should succeed");
    assert_eq!(remotes.len(), 1);
    assert_eq!(remotes[0].name, "origin");
    assert_eq!(remotes[0].url, "https://example.com/repo.git");
}

#[test]
fn add_remote_refuses_a_flag_like_url_too() {
    let repo = TempRepo::init("remote_flag_injection_url");
    let path = repo.path();
    let res = tauri::async_runtime::block_on(add_remote(path.clone(), "origin".into(), "--upload-pack=evil".into()));
    assert!(!res.ok, "add_remote must refuse a flag-like URL");
    assert!(res.message.contains("flag"), "got: {}", res.message);
    assert!(tauri::async_runtime::block_on(list_remotes(path)).unwrap().is_empty(), "nothing should have been added");
}

#[test]
fn add_remote_refuses_empty_name_or_url() {
    let repo = TempRepo::init("remote_empty");
    let path = repo.path();
    let empty_name = tauri::async_runtime::block_on(add_remote(path.clone(), "".into(), "https://example.com/x.git".into()));
    assert!(!empty_name.ok);
    let empty_url = tauri::async_runtime::block_on(add_remote(path.clone(), "origin".into(), "".into()));
    assert!(!empty_url.ok);
    assert!(tauri::async_runtime::block_on(list_remotes(path)).unwrap().is_empty());
}

// ---------------------------------------------------------------------------
// list_remotes on an invalid path is a clean Err (not a panic)
// ---------------------------------------------------------------------------

#[test]
fn list_remotes_invalid_repo_path_is_a_clean_err() {
    let err = must_err(tauri::async_runtime::block_on(list_remotes("/no/such/path/at/all".to_string())), "nonexistent repo path must be Err");
    assert!(!err.is_empty());
}
