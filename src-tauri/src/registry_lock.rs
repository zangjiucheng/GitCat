//! Serialize a registry's read-modify-write sequence ACROSS PROCESSES.
//!
//! Both on-disk registries — `plugin_registry`'s `plugins.json` and
//! `repo_registry`'s `tracked_repos.json` — have the same shape:
//!
//! ```text
//! lock -> load_from(path) -> mutate -> save_to(path)
//! ```
//!
//! and both used to take a `OnceLock<Mutex<()>>` for that lock. The reasoning
//! in those comments was right — two unlocked writers can each load the same
//! file, each mutate their own copy, and the second `save_to` silently drops
//! the first one's change — but a `Mutex` cannot deliver it here, because
//! every GitCat window is a genuinely separate OS PROCESS (see `windows.rs`'s
//! own module doc). Installing a plugin in one window while disabling another
//! in a second window was a lost update, every time the two overlapped.
//!
//! Note this was never a CORRUPTION bug. `save_to` writes a temp file and
//! atomically renames it, so `plugins.json` is always a whole, valid file —
//! just, sometimes, the wrong one.
//!
//! # Why an OS advisory lock, from std
//!
//! [`std::fs::File::lock`] is `flock(2)` on unix and `LockFileEx` on Windows.
//! The reason to reach for the OS rather than hand-roll an `O_EXCL` lock file
//! is the crash case: the kernel drops an advisory lock when the holding
//! process dies, however it dies. A hand-rolled lock file outlives its holder,
//! so it needs a "steal it if it looks older than N seconds" rule — and a
//! registry that wedges shut because a heuristic guessed wrong would be a
//! worse bug than the one being fixed.
//!
//! This was first written against the `fs4` crate, which is what one reaches
//! for out of habit; `File::lock`/`unlock` have been stable since Rust 1.89
//! and do the same thing, so the dependency came back out. There is no
//! toolchain floor to trip over — this repo pins none, and CI builds on
//! `dtolnay/rust-toolchain@stable`.
//!
//! # Why a sidecar file, and not the registry itself
//!
//! `save_to` finishes with `fs::rename`, which REPLACES the inode. A lock
//! taken on `plugins.json` is a lock on whichever inode that name resolved to
//! when it was opened — so process B could hold a perfectly good lock on the
//! file A is in the middle of replacing, and both would proceed. The lock
//! therefore lives on `<registry>.lock`, a file that is created once and never
//! renamed, replaced or removed. It stays behind as an empty file, which is
//! the intended end state: deleting it would reintroduce exactly the
//! replaced-inode race it exists to avoid.
//!
//! # Blocking
//!
//! [`with_registry_lock`] BLOCKS until it can take the lock, which is only
//! safe because every caller now runs on Tauri's blocking-task pool rather
//! than the main thread (see `blocking.rs`). The critical sections are a small
//! JSON read, an in-memory edit and a rename — microseconds — so contention is
//! rare and brief, but "rare and brief" is not a property worth betting the
//! window's event loop on.

use std::fs::OpenOptions;
use std::path::Path;

/// Run `f` while holding an exclusive cross-process lock for the registry
/// stored at `registry_path`.
///
/// The lock is released when this returns, including on an early `?` out of
/// `f` and including on a panic, because it is tied to a `File` this function
/// owns.
///
/// # Errors
///
/// Only from failing to take the lock at all — a missing parent directory, a
/// permissions problem, a filesystem that does not support locking. `f`'s own
/// error is returned unchanged. `err_key` names the caller's i18n key for the
/// lock failure so plugin and repo callers can report it in their own
/// vocabulary (see `i18n_err`'s own doc on why backend messages are keys).
pub fn with_registry_lock<T>(
    registry_path: &Path,
    err_key: &str,
    f: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let mut lock_name = registry_path.as_os_str().to_os_string();
    lock_name.push(".lock");
    let lock_path = std::path::PathBuf::from(lock_name);

    // `create(true)` and not `create_new(true)`: the file is expected to
    // already exist on every run after the first, and its CONTENTS are never
    // read or written — it exists only to be something the kernel can hold a
    // lock on. Opened for write because Windows' LockFileEx needs a handle
    // with write access to take an exclusive lock.
    let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&lock_path).map_err(|e| {
        crate::i18n_err::ierrp(err_key, &[("path", &lock_path.display().to_string()), ("detail", &e.to_string())])
    })?;

    file.lock().map_err(|e| {
        crate::i18n_err::ierrp(err_key, &[("path", &lock_path.display().to_string()), ("detail", &e.to_string())])
    })?;

    let result = f();

    // Explicit rather than left to the Drop of `file`, so the unlock is
    // ordered before this function returns rather than at an end-of-scope the
    // reader has to work out. A failure to unlock is ignored: the handle is
    // dropped immediately afterwards, which releases the lock anyway.
    let _ = file.unlock();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let nanos =
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock is after the epoch").as_nanos();
        let dir = std::env::temp_dir().join(format!("gitcat-lockmod-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir temp dir");
        dir
    }

    #[test]
    fn the_lock_file_sits_beside_the_registry_and_is_not_the_registry() {
        let dir = temp_dir("sidecar");
        let registry = dir.join("plugins.json");
        with_registry_lock(&registry, "err_plugins.lock", || Ok(())).expect("taking the lock should succeed");

        assert!(dir.join("plugins.json.lock").exists(), "the lock lives in a sidecar file");
        assert!(
            !registry.exists(),
            "taking the lock must not create the registry itself — load_from's own NotFound path means 'no plugins yet'"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_callers_error_passes_through_unchanged_and_the_lock_is_still_released() {
        let dir = temp_dir("passthrough");
        let registry = dir.join("plugins.json");

        let err = with_registry_lock(&registry, "err_plugins.lock", || Err::<(), String>("the caller's own error".into()))
            .expect_err("f's error must surface");
        assert_eq!(err, "the caller's own error", "the wrapper must not wrap or rewrite what f returned");

        // If the failing call had leaked the lock, this would hang forever
        // rather than fail — the reason this assertion is in the same test.
        with_registry_lock(&registry, "err_plugins.lock", || Ok(())).expect("the lock must be free again after an error");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_threads_cannot_hold_the_same_registrys_lock_at_once() {
        // In-process coverage of the mutual exclusion itself. The
        // cross-PROCESS case — the one this module exists for, and the one no
        // in-process test can reach — is in tests/registry_lock.rs.
        let dir = temp_dir("mutual");
        let registry = dir.join("plugins.json");
        let inside = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));

        std::thread::scope(|scope| {
            for _ in 0..8 {
                let (registry, inside, max_seen) = (registry.clone(), inside.clone(), max_seen.clone());
                scope.spawn(move || {
                    with_registry_lock(&registry, "err_plugins.lock", || {
                        let n = inside.fetch_add(1, Ordering::SeqCst) + 1;
                        max_seen.fetch_max(n, Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(5));
                        inside.fetch_sub(1, Ordering::SeqCst);
                        Ok(())
                    })
                    .expect("every thread should eventually get the lock");
                });
            }
        });

        assert_eq!(max_seen.load(Ordering::SeqCst), 1, "two holders were inside the critical section at the same time");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
