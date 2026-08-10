//! Channel-aware "check for updates".
//!
//! The bundled updater plugin's JS `check()` can only ever hit the ONE endpoint
//! baked into `tauri.conf.json` (the stable `releases/latest/download/latest.json`).
//! The nightly channel needs a DIFFERENT endpoint at runtime, so this app command
//! builds the updater itself via `updater_builder().endpoints(...)`. Everything
//! AFTER the check — download, install, relaunch — still rides the plugin's own
//! JS API by resource id (see the frontend `updater.svelte.ts`), because this
//! command stashes the resulting `Update` in the very same per-webview resource
//! table the plugin's `download_and_install` reads from.

use serde::Serialize;
use tauri::{Manager, Webview, Wry};
use tauri_plugin_updater::UpdaterExt;

use crate::i18n_err::ierrp;

/// The nightly channel's rolling `latest.json`: a GitHub PRERELEASE tagged
/// `nightly`. Note `download/nightly/`, NOT `latest/download/` — the `latest`
/// alias resolves only to the newest NON-prerelease, which would never pick a
/// nightly. Stable uses the config endpoint in tauri.conf.json (no override).
const NIGHTLY_ENDPOINT: &str = "https://github.com/zangjiucheng/GitCat/releases/download/nightly/latest.json";

/// Update metadata for the frontend — the exact fields the plugin's JS `Update`
/// class needs, minus `rawJson` (informational, unused by download/install; the
/// frontend fills it as `{}`). `rid` is the resource id of the `Update` stashed
/// in THIS webview's resource table, so the plugin's own `downloadAndInstall()`
/// (which re-looks-it-up by rid in the same table) works unchanged.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAvailable {
    pub rid: u32,
    pub current_version: String,
    pub version: String,
    pub date: Option<String>,
    pub notes: Option<String>,
}

/// Check for an update on the STABLE (config endpoint) or NIGHTLY channel.
///
/// The `version_comparator` reports an update whenever the remote version simply
/// DIFFERS from the current one (not only when strictly newer) — that is what
/// lets a user switch nightly → stable, installing the latest STABLE even though
/// its version number is LOWER than the running nightly (the "switch back to
/// release" requirement). Within a channel both endpoints only ever move
/// forward, so `!=` behaves like `>` there; it only ever yields a real downgrade
/// across an intentional channel switch.
///
/// MUST take a `Webview` (never an `AppHandle`): it stashes the `Update` in
/// `webview.resources_table()`, the PER-WEBVIEW table the plugin's
/// `download_and_install` reads by rid. `AppHandle::resources_table()` is a
/// DIFFERENT, global table, and install would then fail "resource not found."
/// JS: `commands.checkForUpdate(nightly)`.
#[tauri::command]
#[specta::specta]
pub async fn check_for_update(webview: Webview<Wry>, nightly: bool) -> Result<Option<UpdateAvailable>, String> {
    let mut builder = webview.updater_builder().version_comparator(|current, update| update.version != current);
    if nightly {
        let url = tauri::Url::parse(NIGHTLY_ENDPOINT).map_err(|e| ierrp("err_misc.bad_nightly_endpoint", &[("detail", &e.to_string())]))?;
        builder = builder.endpoints(vec![url]).map_err(|e| ierrp("err_misc.updater_endpoint_error", &[("detail", &e.to_string())]))?;
    }
    let update = builder
        .build()
        .map_err(|e| ierrp("err_misc.updater_init_failed", &[("detail", &e.to_string())]))?
        .check()
        .await
        .map_err(|e| ierrp("err_misc.update_check_failed", &[("detail", &e.to_string())]))?;
    Ok(update.map(|u| UpdateAvailable {
        current_version: u.current_version.clone(),
        version: u.version.clone(),
        date: u.date.map(|d| d.to_string()),
        notes: u.body.clone(),
        // `add(u)` consumes `u`, so it MUST be the last field (the clones above
        // only borrow it) — mirrors the plugin's own `check` command.
        rid: webview.resources_table().add(u),
    }))
}
