//! App-level tracked-repository registry (backlog #11): drives
//! `repo_registry::load_from`/`save_to`/`normalize` directly against a
//! throwaway temp file, exactly like `tests/watch.rs` drives
//! `watch::start_watching` directly — a plain integration test has no real
//! Tauri `AppHandle` to hand `list_tracked_repos`/`add_tracked_repo`/
//! `remove_tracked_repo`/`track_repo_opened` themselves, so this exercises
//! the same load/save code those commands call, just addressed by a plain
//! `&Path` instead of `app.path().app_config_dir()`.

use gitcat_lib::repo_registry::{load_from, normalize, save_to, TrackedRepo};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// A throwaway registry-file path under the OS temp dir, auto-removed by the
/// returned guard's `Drop`. Mirrors `tests/common::TempRepo`'s own naming
/// scheme (tag + pid + nanos + seq) for legible leftovers if a test aborts.
struct TempRegistry {
    dir: PathBuf,
}
impl TempRegistry {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("gitcat-test-registry-{tag}-{}-{}-{}", std::process::id(), nanos, seq));
        std::fs::create_dir_all(&dir).expect("mkdir temp registry dir");
        TempRegistry { dir }
    }
    fn file(&self) -> PathBuf {
        self.dir.join("tracked_repos.json")
    }
}
impl Drop for TempRegistry {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn fresh_file_reads_back_as_empty_list() {
    let reg = TempRegistry::new("fresh");
    let repos = load_from(&reg.file()).expect("load_from should treat a missing file as empty, not an error");
    assert!(repos.is_empty());
}

#[test]
fn add_then_read_back_persists_across_a_simulated_restart() {
    let reg = TempRegistry::new("add_persist");
    let file = reg.file();

    // Simulate add_tracked_repo's upsert logic against the file directly.
    let mut repos = load_from(&file).unwrap();
    repos.push(TrackedRepo { path: "/tmp/some/repo".into(), last_opened_at: None, repo_summary_shown: false });
    save_to(&file, &repos).expect("save_to failed");

    // A totally fresh load (as if the app had restarted) must see it.
    let reloaded = load_from(&file).expect("load_from failed");
    assert_eq!(reloaded.len(), 1);
    assert_eq!(reloaded[0].path, "/tmp/some/repo");
    assert_eq!(reloaded[0].last_opened_at, None);
}

#[test]
fn remove_then_read_back_persists_across_a_simulated_restart() {
    let reg = TempRegistry::new("remove_persist");
    let file = reg.file();

    save_to(
        &file,
        &[
            TrackedRepo { path: "/tmp/repo-a".into(), last_opened_at: Some(100), repo_summary_shown: false },
            TrackedRepo { path: "/tmp/repo-b".into(), last_opened_at: Some(200), repo_summary_shown: false },
        ],
    )
    .unwrap();

    // Simulate remove_tracked_repo's retain logic.
    let mut repos = load_from(&file).unwrap();
    repos.retain(|r| r.path != "/tmp/repo-a");
    save_to(&file, &repos).unwrap();

    let reloaded = load_from(&file).expect("load_from failed");
    assert_eq!(reloaded.len(), 1);
    assert_eq!(reloaded[0].path, "/tmp/repo-b");
    assert_eq!(reloaded[0].last_opened_at, Some(200));
}

#[test]
fn track_opened_upserts_new_and_bumps_existing() {
    let reg = TempRegistry::new("track_opened");
    let file = reg.file();

    // First "open": not yet tracked -> inserted with a timestamp.
    let mut repos = load_from(&file).unwrap();
    let now1 = 111;
    match repos.iter_mut().find(|r| r.path == "/tmp/repo-c") {
        Some(r) => r.last_opened_at = Some(now1),
        None => repos.push(TrackedRepo { path: "/tmp/repo-c".into(), last_opened_at: Some(now1), repo_summary_shown: false }),
    }
    save_to(&file, &repos).unwrap();
    let after_first = load_from(&file).unwrap();
    assert_eq!(after_first.len(), 1);
    assert_eq!(after_first[0].last_opened_at, Some(111));

    // Second "open" of the SAME repo: upserts in place, does not duplicate.
    let mut repos = load_from(&file).unwrap();
    let now2 = 222;
    match repos.iter_mut().find(|r| r.path == "/tmp/repo-c") {
        Some(r) => r.last_opened_at = Some(now2),
        None => repos.push(TrackedRepo { path: "/tmp/repo-c".into(), last_opened_at: Some(now2), repo_summary_shown: false }),
    }
    save_to(&file, &repos).unwrap();
    let after_second = load_from(&file).unwrap();
    assert_eq!(after_second.len(), 1, "opening the same repo twice must not duplicate the entry");
    assert_eq!(after_second[0].last_opened_at, Some(222));
}

#[test]
fn malformed_registry_file_recovers_instead_of_permanently_locking_out_the_dashboard() {
    // Regression test for a real bug an adversarial review caught: the first
    // draft treated a corrupt file as a hard Err from every command,
    // including Add/Remove — a rare corruption event (e.g. a crash mid-write
    // before the atomic-rename fix, or manual tampering) permanently locked
    // the user out of the dashboard until they edited the file by hand.
    // load_from now recovers: it renames the corrupt file aside (so nothing
    // is silently destroyed — the bad bytes are still on disk under a
    // `.corrupt-<timestamp>` name for forensics) and returns an empty list,
    // exactly like a first run.
    let reg = TempRegistry::new("malformed");
    let file = reg.file();
    std::fs::write(&file, "{ this is not valid json").unwrap();

    let result = load_from(&file).expect("a corrupt registry file must recover, not hard-lock the dashboard out");
    assert!(result.is_empty(), "recovery should present as an empty (first-run-like) list");
    assert!(!file.exists(), "the corrupt file must be renamed aside, not left in place");

    let backups: Vec<_> = std::fs::read_dir(reg.dir.clone())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
        .collect();
    assert_eq!(backups.len(), 1, "the corrupt bytes must survive under a .corrupt-<timestamp> backup name, not be destroyed");
    let backup_content = std::fs::read_to_string(backups[0].path()).unwrap();
    assert_eq!(backup_content, "{ this is not valid json", "the backup must preserve the exact original corrupt bytes");
}

#[test]
fn a_path_that_is_not_a_git_repo_can_still_be_tracked_and_removed() {
    // The registry itself is just a list of strings — it never opens the
    // path as a repo, so a moved/deleted/never-valid path is a perfectly
    // normal entry to add/list/remove; only dashboard_repo_status (a
    // separate command) is the one that would fail to open it.
    let reg = TempRegistry::new("invalid_repo_path");
    let file = reg.file();

    let bogus = "/definitely/not/a/repo/anywhere";
    let mut repos = load_from(&file).unwrap();
    repos.push(TrackedRepo { path: normalize(bogus), last_opened_at: None, repo_summary_shown: false });
    save_to(&file, &repos).unwrap();

    let reloaded = load_from(&file).unwrap();
    assert_eq!(reloaded.len(), 1);
    // normalize() falls back to the raw string when canonicalize() fails
    // (path doesn't exist), rather than erroring.
    assert_eq!(reloaded[0].path, bogus);

    // And it can be cleanly removed again.
    let mut repos = load_from(&file).unwrap();
    repos.retain(|r| r.path != bogus);
    save_to(&file, &repos).unwrap();
    assert!(load_from(&file).unwrap().is_empty());
}

#[test]
fn normalize_dedupes_a_symlinked_path_to_the_same_canonical_string() {
    // Real filesystem dirs (not just strings) so canonicalize() has
    // something real to resolve.
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let base = std::env::temp_dir().join(format!("gitcat-test-registry-normalize-{}-{}", std::process::id(), nanos));
    let real_dir = base.join("real-repo");
    std::fs::create_dir_all(&real_dir).unwrap();

    #[cfg(unix)]
    {
        let link = base.join("link-to-repo");
        if std::os::unix::fs::symlink(&real_dir, &link).is_ok() {
            let a = normalize(&real_dir.to_string_lossy());
            let b = normalize(&link.to_string_lossy());
            assert_eq!(a, b, "the real path and a symlink to it should normalize to the same string");
        }
    }

    let _ = std::fs::remove_dir_all(&base);
}
