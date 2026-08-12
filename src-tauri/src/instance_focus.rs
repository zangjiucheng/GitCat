//! Cross-process "focus the existing window for this repo" (#39).
//!
//! GitCat runs a genuinely separate OS process per window (see `windows.rs`), so
//! launching `gitcat <path>` for a repo that's already open would otherwise
//! duplicate the window. To avoid that without giving up the separate-process
//! model, each window binds a loopback TCP listener and records
//! `<canonical repo path> -> port` in a small on-disk registry. A launch for an
//! already-open repo connects to that port to raise the existing window, then
//! exits instead of opening a second one.
//!
//! Port reachability doubles as the liveness check: a crashed instance's stale
//! entry simply fails to connect and is pruned, so there's no PID bookkeeping.
//! The registry is keyed by the CANONICAL repo path (`.`, symlinks, and Windows
//! verbatim/UNC forms of the same repo collapse together), and it tracks the
//! window's CURRENT repo — the frontend calls `set_open_repo` on every open (so
//! an in-place repo switch re-keys) and `clear_open_repo` when a repo is closed.
//!
//! The explicit "Open in New Window" dashboard action passes a `--new-window`
//! argv marker (see `windows::spawn_new_window`) so it bypasses the dedup and
//! always gets its own window, as intended.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Wry};

const FILE_NAME: &str = "open-windows.json";
const FOCUS_MSG: &[u8] = b"focus\n";
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);

/// This process's focus-listener port, set once by [`start_listener`]. Used by
/// the `set_open_repo`/`clear_open_repo` commands to key this window's entry.
static FOCUS_PORT: OnceLock<u16> = OnceLock::new();

#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    path: String, // canonical repo path (the dedup key)
    port: u16,    // the owning window's focus-listener port
}

fn registry_path(app: &AppHandle<Wry>) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join(FILE_NAME))
}

/// Canonical key for a repo path so different spellings of the same repo dedup
/// together. Best-effort — falls back to the input when it can't be resolved.
fn canonical_key(path: &str) -> String {
    let canon = std::fs::canonicalize(path)
        .ok()
        .and_then(|p| p.to_str().map(str::to_string))
        .unwrap_or_else(|| path.to_string());
    crate::windows::strip_windows_verbatim_prefix(canon)
}

fn read_entries(path: &PathBuf) -> Vec<Entry> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<Entry>>(&s).ok())
        .unwrap_or_default()
}

fn write_entries(path: &PathBuf, entries: &[Entry]) {
    let Ok(json) = serde_json::to_string(entries) else { return };
    // Write to a temp file then rename, so a concurrent reader never sees a
    // half-written registry.
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// Re-key `port`'s window to `path`: drop this window's previous entry (so an
/// in-place repo switch doesn't leave a stale mapping) then record the new one.
fn upsert(entries: &mut Vec<Entry>, path: String, port: u16) {
    entries.retain(|e| e.port != port);
    entries.push(Entry { path, port });
}

/// Drop `port`'s window from the registry (repo closed, or the window is going
/// away).
fn remove_port(entries: &mut Vec<Entry>, port: u16) {
    entries.retain(|e| e.port != port);
}

/// Connect to a window's focus port and ask it to raise itself. `true` if the
/// window was reachable (and thus is really open).
fn ping_focus(port: u16) -> bool {
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
        Ok(mut s) => s.write_all(FOCUS_MSG).is_ok(),
        Err(_) => false,
    }
}

/// If `path` is already open in another live GitCat window, raise it and return
/// `true` — the caller should then exit WITHOUT opening a window. A stale
/// (unreachable) entry for this path is pruned. Returns `false` (open normally)
/// on any error resolving the registry.
pub fn focus_if_open(app: &AppHandle<Wry>, path: &str) -> bool {
    match registry_path(app) {
        Some(reg) => focus_if_open_at(&reg, path),
        None => false,
    }
}

/// The registry-file half of [`focus_if_open`], split out so it can be tested
/// against a real listener without a running Tauri app.
fn focus_if_open_at(reg: &PathBuf, path: &str) -> bool {
    let key = canonical_key(path);
    let mut entries = read_entries(reg);
    if let Some(pos) = entries.iter().position(|e| e.path == key) {
        if ping_focus(entries[pos].port) {
            return true;
        }
        entries.remove(pos); // stale window — drop it and open a fresh one
        write_entries(reg, &entries);
    }
    false
}

/// Bind this process's focus listener and remember its port. On each incoming
/// connection, raise the "main" window on the main thread. Call once, right
/// after the window is built. Best-effort: a bind failure just means this window
/// can't be focus-routed to (a later `gitcat <same repo>` would open a new one).
pub fn start_listener(app: &AppHandle<Wry>) {
    let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, 0)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("gitcat: focus listener bind failed: {e}");
            return;
        }
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(_) => return,
    };
    let _ = FOCUS_PORT.set(port);
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            let mut buf = [0u8; 16];
            let _ = s.read(&mut buf); // we only need the wakeup, not the content
            let app = app.clone();
            // Window ops must run on the main thread (see event_util's own note
            // on background-thread AppHandle calls).
            let _ = app.clone().run_on_main_thread(move || {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            });
        }
    });
}

/// JS: `commands.setOpenRepo(path)` — called by the frontend whenever it opens
/// (or switches to) a repo, so a later `gitcat <same repo>` finds this window.
/// Re-keys this window (drops its previous repo entry) so an in-place switch
/// doesn't leave a stale mapping.
#[tauri::command]
#[specta::specta]
pub fn set_open_repo(app: AppHandle<Wry>, path: String) {
    let Some(port) = FOCUS_PORT.get().copied() else { return };
    let Some(reg) = registry_path(&app) else { return };
    let mut entries = read_entries(&reg);
    upsert(&mut entries, canonical_key(&path), port);
    write_entries(&reg, &entries);
}

/// JS: `commands.clearOpenRepo()` — called when a repo is closed in-app (the
/// window stays open with no repo). Removes this window's registry entry so it's
/// no longer a focus target. (An OS-close exits the process; its now-unreachable
/// entry is pruned lazily by the next launch's [`focus_if_open`].)
#[tauri::command]
#[specta::specta]
pub fn clear_open_repo(app: AppHandle<Wry>) {
    let Some(port) = FOCUS_PORT.get().copied() else { return };
    let Some(reg) = registry_path(&app) else { return };
    let mut entries = read_entries(&reg);
    remove_port(&mut entries, port);
    write_entries(&reg, &entries);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_re_keys_a_windows_repo_and_leaves_others_alone() {
        let mut e: Vec<Entry> = Vec::new();
        upsert(&mut e, "/repo/a".into(), 100);
        upsert(&mut e, "/repo/b".into(), 200);
        assert_eq!(e.len(), 2);
        // Window on port 100 switches repo in place: its /a entry is replaced by
        // /c, and port 200's /b entry is untouched.
        upsert(&mut e, "/repo/c".into(), 100);
        assert_eq!(e.len(), 2);
        assert!(!e.iter().any(|x| x.path == "/repo/a"), "stale key must be dropped");
        assert!(e.iter().any(|x| x.path == "/repo/c" && x.port == 100));
        assert!(e.iter().any(|x| x.path == "/repo/b" && x.port == 200));
    }

    #[test]
    fn remove_port_drops_only_that_window() {
        let mut e: Vec<Entry> = Vec::new();
        upsert(&mut e, "/repo/a".into(), 100);
        upsert(&mut e, "/repo/b".into(), 200);
        remove_port(&mut e, 100);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].path, "/repo/b");
    }

    #[test]
    fn focus_if_open_pings_a_live_window_and_prunes_a_dead_one() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        // A real repo path so canonical_key resolves identically on both sides.
        let dir = std::env::temp_dir();
        let dir_s = dir.to_str().unwrap().to_string();
        let reg = std::env::temp_dir().join(format!("gitcat-focus-live-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&reg);

        // Stand in for an open window: a listener that flips a flag when pinged.
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let pinged = Arc::new(AtomicBool::new(false));
        let flag = pinged.clone();
        let accept = std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut b = [0u8; 16];
                let _ = s.read(&mut b);
                flag.store(true, Ordering::SeqCst);
            }
        });

        write_entries(&reg, &[Entry { path: canonical_key(&dir_s), port }]);
        assert!(focus_if_open_at(&reg, &dir_s), "a live window must be focused (open dedup'd)");
        accept.join().ok();
        assert!(pinged.load(Ordering::SeqCst), "the focus ping reached the listener");

        // A stale entry (nothing listening on port 1) prunes and opens fresh.
        write_entries(&reg, &[Entry { path: canonical_key(&dir_s), port: 1 }]);
        assert!(!focus_if_open_at(&reg, &dir_s), "a dead window must NOT dedup");
        assert!(read_entries(&reg).is_empty(), "the stale entry is pruned");
        let _ = std::fs::remove_file(&reg);
    }

    #[test]
    fn registry_survives_a_write_read_round_trip() {
        let tmp = std::env::temp_dir().join(format!("gitcat-focus-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        assert!(read_entries(&tmp).is_empty(), "missing file reads as empty");
        let mut e: Vec<Entry> = Vec::new();
        upsert(&mut e, "/repo/a".into(), 4242);
        write_entries(&tmp, &e);
        let back = read_entries(&tmp);
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].port, 4242);
        assert_eq!(back[0].path, "/repo/a");
        let _ = std::fs::remove_file(&tmp);
    }
}
