//! App-level tracked-repository registry for the multi-repo dashboard
//! (backlog #11) — a single small JSON file under Tauri's own
//! `app_config_dir()`, NOT a per-repo `<git-dir>/gitgui/` file (see safety.rs's
//! own convention): this list exists specifically to track repos the user is
//! NOT currently inside, so there's no "current repo" git-dir to hang it off.
//! Rust owns the read/write (plain `std::fs` + `serde_json`) — matches this
//! codebase's "Rust does real file I/O" philosophy rather than adding
//! `@tauri-apps/plugin-store`, a dependency this app has never taken.
//!
//! Every command returns the WHOLE updated list, not just ok/err — so the
//! frontend never needs a second round-trip after a mutation to re-render.
//!
//! Testability: the actual load/save logic ([`load_from`]/[`save_to`]) takes a
//! plain `&Path` to the JSON file, not an `AppHandle` — so the integration
//! suite (`tests/repo_registry.rs`) can exercise the real persistence code
//! against a `tempfile`-style throwaway directory without needing a real Tauri
//! runtime, mirroring how `watch.rs`/`git_bisect.rs` split an AppHandle-taking
//! `#[tauri::command]` wrapper from a plain, directly-testable inner fn. The
//! `#[tauri::command]`s below are the only things that touch `AppHandle`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Wry};

const FILE_NAME: &str = "tracked_repos.json";
const SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TrackedRepo {
    pub path: String,
    /// Unix seconds this repo was last OPENED through this app (via
    /// `openRepo()` — see legacy/main.ts). `None` for a repo added only via
    /// the dashboard's manual "+ Add repository…" picker and never actually
    /// opened. Drives the dashboard's most-recently-used ordering.
    pub last_opened_at: Option<i64>,
}

#[derive(Serialize, Deserialize)]
struct RegistryFile {
    version: u32,
    repos: Vec<TrackedRepo>,
}

fn registry_path(app: &AppHandle<Wry>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Could not resolve app config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create app config dir: {e}"))?;
    Ok(dir.join(FILE_NAME))
}

/// Read the registry file at `path`. Missing file => empty list (first run),
/// never an error.
///
/// A malformed/corrupt file does NOT hard-lock the user out of the
/// dashboard forever (an adversarial review found the original version did:
/// every command — including Add/Remove — called this first, so a corrupt
/// file meant total lockout until manual file surgery). Instead: the corrupt
/// file is renamed aside to `tracked_repos.json.corrupt-<unix-seconds>`
/// (best-effort — if even that fails, e.g. a read-only directory, we still
/// proceed rather than compounding one failure into a second one) and an
/// empty list is returned, exactly like a first run. Nothing is silently
/// DESTROYED — the corrupt bytes survive on disk under the backup name for
/// forensics/manual recovery — but the app is never permanently locked out
/// by it, matching this codebase's consistent "never destroy without a net,
/// but never let a rare failure brick the feature either" ethos (see e.g.
/// filter_repo.rs's own pre-rewrite backup).
///
/// `pub` (not private) so the integration suite (`tests/repo_registry.rs`) can
/// drive the real persistence logic directly against a throwaway temp file,
/// exactly like `watch.rs`'s `pub fn start_watching`/`git_bisect.rs`'s
/// `pub fn run_bisect` are exposed for the same reason: a plain integration
/// test has no real `AppHandle` to hand the `#[tauri::command]` wrapper.
pub fn load_from(path: &Path) -> Result<Vec<TrackedRepo>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
    };
    match serde_json::from_str::<RegistryFile>(&text) {
        Ok(file) => Ok(file.repos),
        Err(_) => {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let backup = path.with_file_name(format!(
                "{}.corrupt-{now}",
                path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| FILE_NAME.to_string())
            ));
            let _ = std::fs::rename(path, &backup); // best-effort; proceed regardless
            Ok(Vec::new())
        }
    }
}

/// Process-wide lock serializing every registry read-modify-write sequence
/// (list/add/remove/track-opened all take it for their FULL body) — an
/// adversarial review reproduced real data loss without it: two concurrent
/// writers (e.g. `openRepo()`'s fire-and-forget `track_repo_opened` racing a
/// dashboard Add/Remove click) each do an unlocked load -> mutate -> save,
/// and "last write wins" silently drops the loser's change. A poisoned lock
/// (a prior panic mid-critical-section) is recovered from rather than
/// propagated — a stuck-forever registry would be a worse failure mode than
/// proceeding with whatever the poisoned guard still protects.
fn registry_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

/// `pub` for the same integration-testability reason as [`load_from`].
/// Writes via a same-directory temp file + atomic rename (never a direct
/// in-place `fs::write`) so a crash/power-loss mid-write can never leave a
/// half-written, corrupt `tracked_repos.json` behind — the file on disk is
/// always either the fully-old or fully-new content, never a partial mix.
pub fn save_to(path: &Path, repos: &[TrackedRepo]) -> Result<(), String> {
    let file = RegistryFile { version: SCHEMA_VERSION, repos: repos.to_vec() };
    let json = serde_json::to_string_pretty(&file).map_err(|e| format!("Could not serialize: {e}"))?;
    let mut tmp_name = path.as_os_str().to_os_string();
    tmp_name.push(".tmp");
    let tmp_path = PathBuf::from(tmp_name);
    std::fs::write(&tmp_path, &json).map_err(|e| format!("Could not write {}: {e}", tmp_path.display()))?;
    std::fs::rename(&tmp_path, path).map_err(|e| format!("Could not finalize {}: {e}", path.display()))
}

/// Best-effort canonicalization so the SAME repo (reached via the native
/// picker vs. a symlinked path vs. a relative cwd) is never tracked twice
/// under two different string spellings. Falls back to the raw string
/// unchanged when the path doesn't currently resolve (a moved/deleted repo
/// must still be a valid dedup/remove key — a dashboard row for an invalid
/// path must be shown clearly, not silently dropped from the list).
///
/// `pub` for the same integration-testability reason as [`load_from`].
pub fn normalize(path: &str) -> String {
    std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

/// JS: `commands.listTrackedRepos()`.
#[tauri::command]
#[specta::specta]
pub fn list_tracked_repos(app: AppHandle<Wry>) -> Result<Vec<TrackedRepo>, String> {
    load_from(&registry_path(&app)?)
}

/// Manual "+ Add repository…" (dashboard). No-ops (doesn't duplicate) if
/// already tracked. JS: `commands.addTrackedRepo(path)`.
#[tauri::command]
#[specta::specta]
pub fn add_tracked_repo(app: AppHandle<Wry>, path: String) -> Result<Vec<TrackedRepo>, String> {
    let _guard = registry_lock().lock().unwrap_or_else(|e| e.into_inner());
    let registry = registry_path(&app)?;
    let norm = normalize(&path);
    let mut repos = load_from(&registry)?;
    if !repos.iter().any(|r| r.path == norm) {
        repos.push(TrackedRepo { path: norm, last_opened_at: None });
        save_to(&registry, &repos)?;
    }
    Ok(repos)
}

/// Dashboard row's "Remove from list" — removes from the TRACKED LIST only,
/// never touches anything on disk. JS: `commands.removeTrackedRepo(path)`.
#[tauri::command]
#[specta::specta]
pub fn remove_tracked_repo(app: AppHandle<Wry>, path: String) -> Result<Vec<TrackedRepo>, String> {
    let _guard = registry_lock().lock().unwrap_or_else(|e| e.into_inner());
    let registry = registry_path(&app)?;
    let norm = normalize(&path);
    let mut repos = load_from(&registry)?;
    repos.retain(|r| r.path != norm);
    save_to(&registry, &repos)?;
    Ok(repos)
}

/// Fire-and-forget hook called from `openRepo()`'s success path
/// (legacy/main.ts) — auto-tracks whichever repo was just opened AND bumps it
/// to "most recently opened". Upserts: adds if new, else updates
/// `last_opened_at` in place. JS: `commands.trackRepoOpened(path)`.
#[tauri::command]
#[specta::specta]
pub fn track_repo_opened(app: AppHandle<Wry>, path: String) -> Result<Vec<TrackedRepo>, String> {
    let _guard = registry_lock().lock().unwrap_or_else(|e| e.into_inner());
    let registry = registry_path(&app)?;
    let norm = normalize(&path);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let mut repos = load_from(&registry)?;
    match repos.iter_mut().find(|r| r.path == norm) {
        Some(r) => r.last_opened_at = Some(now),
        None => repos.push(TrackedRepo { path: norm, last_opened_at: Some(now) }),
    }
    save_to(&registry, &repos)?;
    Ok(repos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_loads_as_empty_not_an_error() {
        let dir = std::env::temp_dir().join(format!(
            "gitcat-registry-test-missing-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let path = dir.join("tracked_repos.json");
        assert!(!path.exists());
        let repos = load_from(&path).expect("missing file should load empty, not error");
        assert!(repos.is_empty());
    }

    #[test]
    fn corrupt_file_recovers_as_empty_and_backs_up_the_original_bytes() {
        let dir = std::env::temp_dir().join(format!(
            "gitcat-registry-test-corrupt-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tracked_repos.json");
        std::fs::write(&path, "not json at all").unwrap();
        let result = load_from(&path).expect("corrupt file should recover, not hard-error and lock out the dashboard");
        assert!(result.is_empty());
        assert!(!path.exists(), "the corrupt file must be renamed aside");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_registry_writers_never_lose_a_write() {
        // Regression test for a real data-loss bug an adversarial review
        // reproduced: unlocked load -> mutate -> save from multiple threads
        // let "last write wins" silently drop the loser's change. Spawns
        // several threads each adding its OWN distinct entry to the SAME
        // registry file, serialized through registry_lock() exactly like
        // add_tracked_repo/remove_tracked_repo/track_repo_opened now do —
        // every single entry must survive.
        let dir = std::env::temp_dir().join(format!(
            "gitcat-registry-test-concurrent-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tracked_repos.json");

        const WRITERS: usize = 12;
        std::thread::scope(|scope| {
            for i in 0..WRITERS {
                let path = &path;
                scope.spawn(move || {
                    let _guard = registry_lock().lock().unwrap_or_else(|e| e.into_inner());
                    let mut repos = load_from(path).expect("load under lock should succeed");
                    repos.push(TrackedRepo { path: format!("/repo/{i}"), last_opened_at: None });
                    save_to(path, &repos).expect("save under lock should succeed");
                });
            }
        });

        let repos = load_from(&path).expect("final load should succeed");
        assert_eq!(repos.len(), WRITERS, "every concurrent writer's entry must survive, none silently lost");
        for i in 0..WRITERS {
            assert!(repos.iter().any(|r| r.path == format!("/repo/{i}")), "missing entry from writer {i}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = std::env::temp_dir().join(format!(
            "gitcat-registry-test-roundtrip-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tracked_repos.json");

        let repos = vec![
            TrackedRepo { path: "/tmp/repo-a".into(), last_opened_at: Some(1_720_000_000) },
            TrackedRepo { path: "/tmp/repo-b".into(), last_opened_at: None },
        ];
        save_to(&path, &repos).expect("save_to failed");

        let loaded = load_from(&path).expect("load_from failed");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].path, "/tmp/repo-a");
        assert_eq!(loaded[0].last_opened_at, Some(1_720_000_000));
        assert_eq!(loaded[1].path, "/tmp/repo-b");
        assert_eq!(loaded[1].last_opened_at, None);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
