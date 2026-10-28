//! Safety settings the BACKEND owns, in `<config_dir>/<identifier>/
//! safety-settings.json` (the same directory Tauri's `app_config_dir()` is).
//!
//! Until now every setting lived only in the webview's localStorage, which a
//! process with no webview can't read — and 2.0's headless `gitcat --mcp`
//! must apply the same safety policy the window does. So the settings that
//! decide what the Safety Manager keeps live here, and the frontend reads and
//! writes them through commands. Today that is snapshot retention; 2.0's op-log
//! switches, WIP capture limits and agent access join it (unknown fields in
//! the file are ignored and missing ones default, so the file survives both
//! upgrades and downgrades).
//!
//! The path is computed without an `AppHandle` ([`settings_path`]), the way
//! Tauri itself resolves `app_config_dir()`, so a headless process finds the
//! same file. A first run migrates the values the frontend already had in
//! localStorage: [`safety_settings_get`] reports `stored: false` until the
//! file exists, and the frontend then writes what it has.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// `identifier` in tauri.conf.json — Tauri's `app_config_dir()` is
/// `config_dir()/<identifier>`. A test keeps the two in step.
pub const APP_IDENTIFIER: &str = "com.jiucheng.gitcat";
const FILE_NAME: &str = "safety-settings.json";

const RETENTION_MODES: [&str; 4] = ["off", "count", "age", "hybrid"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase", default)]
pub struct SafetySettings {
    /// "off" | "count" | "age" | "hybrid" — see `safety::prune_backups`.
    pub snapshot_retention_mode: String,
    pub snapshot_retention_count: u32,
    pub snapshot_retention_days: u32,
}

/// The frontend's own defaults (settings.svelte.ts `DEFAULTS`), so a fresh
/// install behaves the same whichever side read first.
impl Default for SafetySettings {
    fn default() -> Self {
        Self { snapshot_retention_mode: "off".into(), snapshot_retention_count: 25, snapshot_retention_days: 14 }
    }
}

impl SafetySettings {
    /// The same guards the frontend setters apply, at the storage boundary:
    /// an unknown mode is "off" (never delete on a typo), and count/days are
    /// at least 1 (0 would read as "keep nothing").
    pub fn normalized(mut self) -> Self {
        if !RETENTION_MODES.contains(&self.snapshot_retention_mode.as_str()) {
            self.snapshot_retention_mode = "off".into();
        }
        self.snapshot_retention_count = self.snapshot_retention_count.max(1);
        self.snapshot_retention_days = self.snapshot_retention_days.max(1);
        self
    }
}

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SafetySettingsState {
    pub settings: SafetySettings,
    /// `false` until the file has been written once — the frontend's cue to
    /// migrate the values it has in localStorage.
    pub stored: bool,
}

/// `<config_dir>/com.jiucheng.gitcat/safety-settings.json`, resolved like
/// Tauri's `app_config_dir()` but without an `AppHandle`.
pub fn settings_path() -> Result<PathBuf, String> {
    dirs::config_dir().map(|d| d.join(APP_IDENTIFIER).join(FILE_NAME)).ok_or_else(|| "no config directory on this system".to_string())
}

/// The settings at `path`, and whether the file existed. A missing file is
/// the defaults; an unreadable or corrupt one is the defaults too (and is set
/// aside as `<file>.corrupt` so the next save doesn't silently replace what a
/// user could still recover by hand).
pub fn load_from(path: &Path) -> (SafetySettings, bool) {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return (SafetySettings::default(), false),
    };
    match serde_json::from_str::<SafetySettings>(&text) {
        Ok(s) => (s.normalized(), true),
        Err(e) => {
            log::warn!("safety settings at {} are unreadable ({e}); using defaults", path.display());
            let _ = std::fs::rename(path, path.with_extension("json.corrupt"));
            (SafetySettings::default(), false)
        }
    }
}

/// Write `settings` (normalized) to `path` atomically: a temp file, then a
/// rename over the old one, so a crash mid-write never leaves half a file.
pub fn save_to(path: &Path, settings: &SafetySettings) -> Result<SafetySettings, String> {
    let settings = settings.clone().normalized();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("could not replace {}: {e}", path.display()))?;
    Ok(settings)
}

/// The current settings, loaded from the default location.
pub fn load() -> SafetySettings {
    settings_path().map(|p| load_from(&p).0).unwrap_or_default()
}

/// JS: `commands.safetySettingsGet()`.
#[tauri::command]
#[specta::specta]
pub fn safety_settings_get() -> SafetySettingsState {
    let (settings, stored) = settings_path().map(|p| load_from(&p)).unwrap_or_default();
    SafetySettingsState { settings, stored }
}

/// Store `settings` (normalized) and return what was stored.
/// JS: `commands.safetySettingsSet(settings)`.
#[tauri::command]
#[specta::specta]
pub fn safety_settings_set(settings: SafetySettings) -> Result<SafetySettings, String> {
    save_to(&settings_path()?, &settings)
}

/// Prune `path`'s safety snapshots by the STORED retention policy — the
/// backend reads the policy itself rather than taking it from the caller, as
/// a headless process will. "off" prunes nothing.
/// JS: `commands.pruneSnapshotsPerPolicy(path)`.
#[tauri::command]
#[specta::specta]
pub async fn prune_snapshots_per_policy(path: String) -> Result<u32, String> {
    let s = load();
    crate::safety::prune_snapshots(path, s.snapshot_retention_mode, s.snapshot_retention_count, s.snapshot_retention_days).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gitcat-safety-settings-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d.join("nested").join(FILE_NAME)
    }

    #[test]
    fn identifier_matches_tauri_conf() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"].as_str(), Some(APP_IDENTIFIER));
    }

    #[test]
    fn a_missing_file_is_the_defaults_and_not_stored() {
        let p = tmp("missing");
        assert_eq!(load_from(&p), (SafetySettings::default(), false));
    }

    #[test]
    fn save_then_load_round_trips_and_creates_the_directory() {
        let p = tmp("roundtrip");
        let s = SafetySettings { snapshot_retention_mode: "hybrid".into(), snapshot_retention_count: 10, snapshot_retention_days: 7 };
        assert_eq!(save_to(&p, &s).unwrap(), s);
        assert_eq!(load_from(&p), (s, true));
        assert!(!p.with_extension("json.tmp").exists(), "the temp file is renamed away");
    }

    #[test]
    fn values_are_normalized_on_the_way_in_and_out() {
        let p = tmp("normalize");
        let bad = SafetySettings { snapshot_retention_mode: "everything".into(), snapshot_retention_count: 0, snapshot_retention_days: 0 };
        let saved = save_to(&p, &bad).unwrap();
        assert_eq!(saved, SafetySettings { snapshot_retention_mode: "off".into(), snapshot_retention_count: 1, snapshot_retention_days: 1 });
        std::fs::write(&p, r#"{"snapshotRetentionMode":"count","snapshotRetentionCount":0}"#).unwrap();
        let (s, stored) = load_from(&p);
        assert!(stored);
        assert_eq!((s.snapshot_retention_mode.as_str(), s.snapshot_retention_count, s.snapshot_retention_days), ("count", 1, 14));
    }

    #[test]
    fn unknown_fields_are_ignored_so_a_newer_file_still_loads() {
        let p = tmp("unknown");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, r#"{"snapshotRetentionMode":"age","oplogV2":true,"agentAccess":{"enabled":false}}"#).unwrap();
        assert_eq!(load_from(&p).0.snapshot_retention_mode, "age");
    }

    #[test]
    fn a_corrupt_file_is_set_aside_not_overwritten() {
        let p = tmp("corrupt");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "{ not json").unwrap();
        assert_eq!(load_from(&p), (SafetySettings::default(), false));
        assert_eq!(std::fs::read_to_string(p.with_extension("json.corrupt")).unwrap(), "{ not json");
    }

    #[test]
    fn the_path_is_where_tauri_puts_app_config() {
        let p = settings_path().unwrap();
        assert!(p.ends_with(Path::new(APP_IDENTIFIER).join(FILE_NAME)));
        assert_eq!(p.parent().unwrap().parent().unwrap(), dirs::config_dir().unwrap());
    }
}
