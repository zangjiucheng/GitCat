//! The lost update from #60, reproduced across real OS PROCESSES.
//!
//! Both registries already had an in-process concurrency test — several
//! threads each appending their own entry, asserting none is lost. Those tests
//! passed for the whole time the bug existed, and they had to: a
//! `OnceLock<Mutex<()>>` serializes threads perfectly. What it cannot do is
//! serialize WINDOWS, and every GitCat window is a separate OS process (see
//! `windows.rs`'s own module doc). Installing a plugin in one window while
//! disabling one in another silently dropped a change, and no amount of
//! threads could show it.
//!
//! So this file spawns processes. Each child re-executes THIS test binary,
//! runs one `#[ignore]`d child test, and does a single locked
//! load -> mutate -> save against a registry the parent set up.
//!
//! # Making the race deterministic
//!
//! Two things, because a test that only sometimes reproduces a race is worse
//! than no test — it fails intermittently when the code is right and passes
//! intermittently when the code is wrong.
//!
//! * **A barrier.** Process spawn jitter is milliseconds and a registry
//!   read-modify-write is well under one, so children left to start on their
//!   own would mostly not overlap at all. Each child announces itself with a
//!   `ready-<i>` file and then waits for `go`, which the parent creates only
//!   once every child is ready. They enter within roughly a millisecond of
//!   each other.
//! * **A held window.** Each child sleeps [`HELD_MS`] between its load and its
//!   save. That is the test's own composition, not something inserted into
//!   production code — the sequence around it is exactly what
//!   `remove_plugin`/`set_plugin_enabled` run — and it turns "these might
//!   overlap" into "these certainly do".
//!
//! # What happens without the lock
//!
//! Verified by reducing `with_registry_lock` to a direct call of its closure
//! and re-running. Both tests below fail, but the failure is louder and more
//! interesting than "a lost update", so it is worth recording rather than
//! assuming:
//!
//! ```text
//! 6 of 8 plugin writers: err_plugins.could_not_finalize ... No such file or directory (os error 2)
//! 4 of 8 repo writers:   err_repo.could_not_finalize    ... No such file or directory (os error 2)
//! ```
//!
//! That is `save_to`'s `fs::rename` failing, because every process writes the
//! SAME temp file — `plugins.json.tmp` — and one renames it out from under
//! another that is still using it. So unserialized registry writes across
//! processes do not just drop the loser's change quietly; some of them fail
//! outright. Whichever writers do survive then race normally and the parent's
//! count assertion fires on top.
//!
//! The shared temp name is a second cross-process hazard living in the same
//! code, and this lock is what makes it unreachable: every caller of `save_to`
//! now holds the registry lock, so no two are ever inside it at once. Worth
//! knowing if `save_to` ever grows a caller that does not.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use gitcat_lib::plugin_registry::{self, Plugin};
use gitcat_lib::repo_registry::{self, TrackedRepo};

/// Concurrent writer processes. Eight keeps the whole test near
/// `WRITERS * HELD_MS` — under half a second — while being more than enough
/// to make an unserialized run fail decisively (see the module doc for what
/// it actually does fail with, which is not what one would guess).
const WRITERS: usize = 8;
/// How long each child holds its critical section open — see the module doc on
/// why the window is widened deliberately.
const HELD_MS: u64 = 40;
/// Ceiling on every wait in this file. Generous: it is a hang detector, not a
/// timing assertion.
const WAIT_TIMEOUT: Duration = Duration::from_secs(60);

const ENV_DIR: &str = "GITCAT_LOCK_TEST_DIR";
const ENV_INDEX: &str = "GITCAT_LOCK_TEST_INDEX";
const ENV_KIND: &str = "GITCAT_LOCK_TEST_KIND";

fn temp_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock after epoch").as_nanos();
    let dir = std::env::temp_dir().join(format!("gitcat-xproc-{tag}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("mkdir temp dir");
    dir
}

fn wait_for(path: &Path, what: &str) {
    let start = Instant::now();
    while !path.exists() {
        assert!(start.elapsed() < WAIT_TIMEOUT, "timed out waiting for {what} ({})", path.display());
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// A minimal valid manifest, through the real `Deserialize` rather than a
/// struct literal — `Plugin` has 30-odd defaulted fields and a literal here
/// would need updating every time one is added.
fn sample_plugin(i: usize) -> Plugin {
    let json = format!(r#"{{"id":"plugin{i}","name":"Plugin {i}","version":"1.0.0"}}"#);
    serde_json::from_str(&json).expect("a minimal manifest must deserialize")
}

/// The child half. `#[ignore]`d so a plain `cargo test` never runs it, and a
/// no-op without the environment the parent sets, so `cargo test -- --ignored`
/// (which `tests/wsl_live.rs` users do run) stays green rather than panicking
/// on a missing variable.
#[test]
#[ignore = "child process of the cross-process lock tests; the parent re-execs this binary to run it"]
fn locked_append_child() {
    let Ok(dir) = std::env::var(ENV_DIR) else { return };
    let dir = PathBuf::from(dir);
    let index: usize = std::env::var(ENV_INDEX).expect("the parent sets an index").parse().expect("index is a number");
    let kind = std::env::var(ENV_KIND).expect("the parent sets a kind");

    std::fs::write(dir.join(format!("ready-{index}")), b"").expect("announce readiness");
    wait_for(&dir.join("go"), "the parent's go signal");

    match kind.as_str() {
        // The lock, load and save are all the production functions; only the
        // sleep between them belongs to the test.
        "plugins" => {
            let registry = dir.join("plugins.json");
            plugin_registry::with_plugins_lock(&registry, || {
                let mut plugins = plugin_registry::load_from(&registry)?;
                std::thread::sleep(Duration::from_millis(HELD_MS));
                plugins.push(sample_plugin(index));
                plugin_registry::save_to(&registry, &plugins)
            })
            .expect("the locked append should succeed");
        }
        "repos" => {
            let registry = dir.join("tracked_repos.json");
            repo_registry::with_registry_lock(&registry, || {
                let mut repos = repo_registry::load_from(&registry)?;
                std::thread::sleep(Duration::from_millis(HELD_MS));
                repos.push(TrackedRepo {
                    path: format!("/repo/{index}"),
                    last_opened_at: None,
                    repo_summary_shown: false,
                    visible_local_branches: None,
                    visible_remote_branches: None,
                    auto_branch_visibility: false,
                });
                repo_registry::save_to(&registry, &repos)
            })
            .expect("the locked append should succeed");
        }
        other => panic!("unknown kind {other:?}"),
    }
}

/// Spawn [`WRITERS`] children of `kind`, release them together, wait for all.
fn run_writers(dir: &Path, kind: &str) {
    let exe = std::env::current_exe().expect("a test binary knows its own path");
    let mut children = Vec::with_capacity(WRITERS);
    for index in 0..WRITERS {
        let child = Command::new(&exe)
            .args(["--exact", "--ignored", "locked_append_child"])
            .env(ENV_DIR, dir)
            .env(ENV_INDEX, index.to_string())
            .env(ENV_KIND, kind)
            .spawn()
            .expect("spawning a child copy of this test binary");
        children.push(child);
    }

    for index in 0..WRITERS {
        wait_for(&dir.join(format!("ready-{index}")), &format!("child {index} to start"));
    }
    std::fs::write(dir.join("go"), b"").expect("release the children");

    for (index, mut child) in children.into_iter().enumerate() {
        let status = child.wait().expect("waiting on a child");
        assert!(status.success(), "child {index} failed: {status}");
    }
}

#[test]
fn concurrent_plugin_installs_in_separate_processes_never_lose_a_write() {
    let dir = temp_dir("plugins");
    run_writers(&dir, "plugins");

    let plugins = plugin_registry::load_from(&dir.join("plugins.json")).expect("final load");
    assert_eq!(
        plugins.len(),
        WRITERS,
        "{} of {WRITERS} writers survived — a process-wide lock cannot serialize separate windows (#60)",
        plugins.len()
    );
    for i in 0..WRITERS {
        assert!(plugins.iter().any(|p| p.id == format!("plugin{i}")), "writer {i}'s entry was silently dropped");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn concurrent_repo_tracking_in_separate_processes_never_loses_a_write() {
    let dir = temp_dir("repos");
    run_writers(&dir, "repos");

    let repos = repo_registry::load_from(&dir.join("tracked_repos.json")).expect("final load");
    assert_eq!(
        repos.len(),
        WRITERS,
        "{} of {WRITERS} writers survived — repo_registry had the same process-wide lock as plugin_registry (#60)",
        repos.len()
    );
    for i in 0..WRITERS {
        assert!(repos.iter().any(|r| r.path == format!("/repo/{i}")), "writer {i}'s entry was silently dropped");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// The lock file is a sidecar, and stays one.
///
/// `save_to` finishes with a rename, which replaces the registry's inode — so
/// a lock taken on `plugins.json` itself would be a lock on a file the next
/// save throws away, and two processes could each hold a valid lock on a
/// different inode of the same name. This asserts the arrangement that avoids
/// that, from the outside: after a full round of concurrent writers, the lock
/// file exists beside the registry and is not the registry.
#[test]
fn the_lock_survives_the_renames_that_replace_the_registry() {
    let dir = temp_dir("sidecar");
    run_writers(&dir, "plugins");

    let registry = dir.join("plugins.json");
    let lock = dir.join("plugins.json.lock");
    assert!(registry.exists(), "the registry itself must have been written");
    assert!(lock.exists(), "the lock must outlive every rename of the registry");
    assert_ne!(registry, lock, "locking the registry file itself is the bug this arrangement avoids");
    assert_eq!(std::fs::read(&lock).expect("read the lock file").len(), 0, "the lock file's contents are never used");
    let _ = std::fs::remove_dir_all(&dir);
}
