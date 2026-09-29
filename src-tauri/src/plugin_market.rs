//! The in-app plugin catalogue — browse the community index, and fetch a
//! plugin's own files onto disk so the ORDINARY install path can take over.
//!
//! ## The rule this module is built to preserve
//!
//! GitCat installs a plugin from a LOCAL DIRECTORY, after showing the user
//! exactly what its manifest runs. Nothing here changes that. This module's
//! entire job is to PRODUCE such a directory;
//! [`plugin_registry::preview_plugin_manifest`](crate::plugin_registry) and
//! [`plugin_registry::install_plugin_from_path`](crate::plugin_registry) are
//! untouched and remain the only way anything is installed.
//!
//! So the trust gate, the "what it runs" review, the manifest validation, the
//! `minGitcatVersion` check and the duplicate-id rejection are all REUSED
//! rather than re-implemented — and once the bytes are on disk a market
//! install is indistinguishable from a file-picker one. The reviewable
//! question for this module is therefore narrow and answerable: *which bytes
//! is it allowed to put on disk, and where.*
//!
//! ## Which bytes
//!
//! * Only `https://`, and only [`ALLOWED_HOSTS`] — `raw.githubusercontent.com`
//!   for file contents and `api.github.com` for directory listings. A
//!   community entry names its own repo, but the index's own schema pins that
//!   to `https://github.com/<owner>/<name>`, so every fetch still resolves to
//!   one of those two hosts. A redirect away from them is refused.
//! * Every response is read through a byte cap ([`MAX_INDEX_BYTES`],
//!   [`MAX_FILE_BYTES`]), and a plugin as a whole through [`MAX_TOTAL_BYTES`]
//!   and [`MAX_FILES`], so neither a hostile index nor a hostile repo can make
//!   this write unbounded data.
//! * Names come from the GitHub API, not from the archive, and each is checked
//!   by [`safe_component`] before it is joined onto anything — no separators,
//!   no `..`, no absolute paths, so a listing cannot escape the target dir.
//! * Walking stops at [`MAX_DEPTH`]; a plugin is a small flat folder, possibly
//!   with an assets subdirectory.
//!
//! ## And where
//!
//! Into `app_config_dir()/market/<id>/`, NOT a temp dir. The registry records
//! a plugin's `dir` and resolves its Luau script and Tama assets against it
//! forever after, so a market install has to land somewhere durable — the OS
//! reaping a temp dir would silently break the plugin weeks later. A
//! file-picker install already depends on the user keeping their own folder;
//! this gives a market install a folder GitCat owns.
//!
//! ## Why this is not `fetch()` in the webview
//!
//! The webview runs third-party plugin code (see `plugin_exec.rs`), so it does
//! not get a network capability. The app's CSP has no `connect-src` for
//! GitHub, the Tauri capability set has no `http` permission, and both stay
//! that way: the fetching lives here, behind two commands with a fixed host
//! allowlist, and is not reachable from a plugin.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Wry};

use crate::i18n_err::{ierr, ierrp};

/// The community index. Pinned: this is a catalogue GitCat vouches for the
/// LOCATION of, not a user-configurable feed — a settable index URL would turn
/// one allowlisted host into "wherever someone talked you into pointing it".
const INDEX_URL: &str = "https://raw.githubusercontent.com/zangjiucheng/gitcat-plugins/main/index.json";

/// The two hosts any market request may resolve to, including after redirects.
const ALLOWED_HOSTS: &[&str] = &["raw.githubusercontent.com", "api.github.com"];

/// 1 MiB of catalogue is thousands of entries; more than that is not an index.
const MAX_INDEX_BYTES: u64 = 1024 * 1024;
/// Per file. Generous enough for a Tama pose sprite, far under a repo's worth.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Per plugin, across every file fetched for it.
const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024;
/// Per plugin. A plugin is a manifest, maybe a script, maybe a few sprites.
const MAX_FILES: usize = 32;
/// `<plugin>/assets/…` is the deepest shape that exists; two is slack.
const MAX_DEPTH: usize = 2;

/// Where market-installed plugins live, under `app_config_dir()`.
const MARKET_DIR: &str = "market";

/// One row of the community index. Mirrors `index.json`'s entry shape, which
/// is NOT uniform: an `official` entry carries `manifestUrl`/`repoPath` inside
/// the index repo, a `community` entry carries `repo`/`manifestPath` pointing
/// at somebody else's repository. Both forms are optional here and resolved by
/// [`locate`], so a malformed row fails with a message instead of failing to
/// deserialize the whole catalogue.
#[derive(Serialize, Deserialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MarketEntry {
    /// `"official"` or `"community"`.
    pub kind: String,
    pub id: String,
    pub name: String,
    pub description: String,
    pub author: String,
    /// Mirrors the plugin's own manifest field, shown as a heads-up BEFORE the
    /// download; the real gate is still `read_and_validate_manifest`'s.
    #[serde(default)]
    pub min_gitcat_version: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub manifest_url: Option<String>,
    #[serde(default)]
    pub repo_path: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub manifest_path: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
}

/// The whole catalogue, as `index.json` serves it.
#[derive(Serialize, Deserialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginIndex {
    pub schema_version: u32,
    pub generated_at: String,
    pub count: u32,
    pub plugins: Vec<MarketEntry>,
}

/// Where a plugin's files live on GitHub: owner, repo, and the directory
/// holding its `plugin.json` (empty string = repository root).
#[derive(Debug, PartialEq, Eq)]
pub struct Location {
    pub owner: String,
    pub repo: String,
    pub dir: String,
}

/// Reject anything that is not a plain file/directory name.
///
/// Every name this module joins onto a path comes from a GitHub API response,
/// which is to say from outside. A separator, a `..`, a drive prefix or an
/// empty string is how a listing would write outside the plugin's own folder.
pub fn safe_component(name: &str) -> Result<(), String> {
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || name.starts_with(' ')
        || Path::new(name).components().count() != 1;
    if bad {
        return Err(ierrp("err_market.unsafe_name", &[("name", &format!("{name:?}"))]));
    }
    Ok(())
}

/// `https://github.com/owner/name` -> `(owner, name)`. The index schema already
/// pins this shape; parsing it again here means a hand-edited index cannot
/// smuggle a different host past the allowlist by way of the repo field.
pub fn parse_github_repo(url: &str) -> Result<(String, String), String> {
    let rest = url
        .strip_prefix("https://github.com/")
        .ok_or_else(|| ierrp("err_market.bad_repo_url", &[("url", &format!("{url:?}"))]))?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let mut parts = rest.split('/');
    let (owner, repo) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if owner.is_empty() || repo.is_empty() || parts.next().is_some() {
        return Err(ierrp("err_market.bad_repo_url", &[("url", &format!("{url:?}"))]));
    }
    safe_component(owner)?;
    safe_component(repo)?;
    Ok((owner.to_string(), repo.to_string()))
}

/// The directory part of a repo-relative path (`"a/b/plugin.json"` -> `"a/b"`,
/// `"plugin.json"` -> `""`), rejecting anything that tries to climb out.
pub fn manifest_dir(manifest_path: &str) -> Result<String, String> {
    if manifest_path.starts_with('/') || manifest_path.split('/').any(|c| c == ".." || c == ".") {
        return Err(ierrp("err_market.bad_manifest_path", &[("path", &format!("{manifest_path:?}"))]));
    }
    Ok(match manifest_path.rsplit_once('/') {
        Some((dir, _)) => dir.to_string(),
        None => String::new(),
    })
}

/// Resolve an index entry to the repository directory holding its files.
pub fn locate(entry: &MarketEntry) -> Result<Location, String> {
    match entry.kind.as_str() {
        // Official plugins live in the index repo itself, under `repoPath`.
        "official" => {
            let path = entry
                .repo_path
                .as_deref()
                .filter(|p| !p.is_empty())
                .ok_or_else(|| ierrp("err_market.entry_incomplete", &[("id", &entry.id)]))?;
            manifest_dir(&format!("{path}/plugin.json"))?;
            Ok(Location { owner: "zangjiucheng".into(), repo: "gitcat-plugins".into(), dir: path.to_string() })
        }
        // A community entry is a POINTER: the index never hosts its code.
        "community" => {
            let repo = entry
                .repo
                .as_deref()
                .ok_or_else(|| ierrp("err_market.entry_incomplete", &[("id", &entry.id)]))?;
            let manifest = entry
                .manifest_path
                .as_deref()
                .ok_or_else(|| ierrp("err_market.entry_incomplete", &[("id", &entry.id)]))?;
            let (owner, name) = parse_github_repo(repo)?;
            Ok(Location { owner, repo: name, dir: manifest_dir(manifest)? })
        }
        other => Err(ierrp("err_market.unknown_kind", &[("kind", &format!("{other:?}"))])),
    }
}

/// `HEAD` rather than a branch name: a community entry names only a repo, and
/// its default branch is its own business (and may be renamed). raw.github's
/// `HEAD` alias resolves whatever that branch currently is.
fn raw_url(loc: &Location, rel: &str) -> String {
    let base = format!("https://raw.githubusercontent.com/{}/{}/HEAD", loc.owner, loc.repo);
    if rel.is_empty() { base } else { format!("{base}/{rel}") }
}

fn contents_url(loc: &Location, rel: &str) -> String {
    format!("https://api.github.com/repos/{}/{}/contents/{}", loc.owner, loc.repo, rel)
}

/// True when `url` is https and its host is allowlisted.
pub fn host_allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    // Strip any userinfo — `https://raw.githubusercontent.com@evil.test/` has
    // host `evil.test`, and a naive prefix check would wave it through.
    if host.contains('@') {
        return false;
    }
    ALLOWED_HOSTS.contains(&host)
}

/// The one HTTP client this module uses.
///
/// Extracted so a test can assert it BUILDS. reqwest is pulled in with
/// `rustls-no-provider` — deliberately, because the provider feature would add
/// aws-lc-rs and a cmake build to a tree whose rustls already runs on `ring`
/// (measured: `rustls` adds 11 crates, `rustls-no-provider` adds none). The
/// cost of that choice is that the process must already have a default
/// `CryptoProvider` installed, which is a RUNTIME condition — so
/// `client_builds` below pins it, offline, rather than letting it surface as a
/// failed download on somebody's machine.
fn client() -> Result<reqwest::blocking::Client, String> {
    // Exactly once per process, and tolerant of losing the race: the updater
    // plugin uses reqwest too, so a provider may already be installed, and
    // `install_default` errs rather than overwrites in that case. Either way
    // what matters is that ONE is in place before the builder runs.
    static PROVIDER: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    PROVIDER.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    reqwest::blocking::Client::builder()
        .user_agent(concat!("GitCat/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| ierrp("err_market.http_failed", &[("detail", &e.to_string())]))
}

/// GET `url` into memory, refusing a non-allowlisted host (before AND after
/// redirects) and anything longer than `cap`.
fn get(url: &str, cap: u64) -> Result<Vec<u8>, String> {
    if !host_allowed(url) {
        return Err(ierrp("err_market.host_not_allowed", &[("url", &format!("{url:?}"))]));
    }
    let resp = client()?
        .get(url)
        .send()
        .map_err(|e| ierrp("err_market.http_failed", &[("detail", &e.to_string())]))?;
    // A redirect that left the allowlist is a redirect we do not follow the
    // consequences of, even though reqwest already did.
    if !host_allowed(resp.url().as_str()) {
        return Err(ierrp("err_market.host_not_allowed", &[("url", &format!("{}", resp.url()))]));
    }
    if !resp.status().is_success() {
        return Err(ierrp(
            "err_market.http_status",
            &[("status", &resp.status().as_u16().to_string()), ("url", &format!("{url:?}"))],
        ));
    }
    let mut out = Vec::new();
    // `take(cap + 1)` so exceeding the cap is DETECTED rather than silently
    // truncated into a half-file that might still parse.
    resp.take(cap + 1)
        .read_to_end(&mut out)
        .map_err(|e| ierrp("err_market.http_failed", &[("detail", &e.to_string())]))?;
    if out.len() as u64 > cap {
        return Err(ierrp("err_market.too_large", &[("url", &format!("{url:?}")), ("limit", &cap.to_string())]));
    }
    Ok(out)
}

/// One row of GitHub's contents API listing — the only fields we use.
#[derive(Deserialize)]
struct ContentsRow {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    size: u64,
}

/// Download every file under `rel` into `dest`, recursing into subdirectories
/// up to [`MAX_DEPTH`]. `budget` carries the per-plugin caps across the walk.
fn fetch_dir(loc: &Location, rel: &str, dest: &Path, depth: usize, budget: &mut (usize, u64)) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Ok(()); // deeper than any real plugin; stop rather than fail
    }
    let listing = get(&contents_url(loc, rel), MAX_INDEX_BYTES)?;
    let rows: Vec<ContentsRow> = serde_json::from_slice(&listing)
        .map_err(|e| ierrp("err_market.bad_listing", &[("detail", &e.to_string())]))?;

    std::fs::create_dir_all(dest)
        .map_err(|e| ierrp("err_market.write_failed", &[("detail", &e.to_string())]))?;

    for row in rows {
        safe_component(&row.name)?;
        let child_rel = if rel.is_empty() { row.name.clone() } else { format!("{rel}/{}", row.name) };
        match row.kind.as_str() {
            "dir" => fetch_dir(loc, &child_rel, &dest.join(&row.name), depth + 1, budget)?,
            "file" => {
                budget.0 += 1;
                if budget.0 > MAX_FILES {
                    return Err(ierrp("err_market.too_many_files", &[("limit", &MAX_FILES.to_string())]));
                }
                // Trust the listing's own size for an early refusal, but `get`
                // caps the actual read regardless — the number is a hint from
                // the same place the bytes come from.
                if row.size > MAX_FILE_BYTES {
                    return Err(ierrp(
                        "err_market.too_large",
                        &[("url", &format!("{child_rel:?}")), ("limit", &MAX_FILE_BYTES.to_string())],
                    ));
                }
                let bytes = get(&raw_url(loc, &child_rel), MAX_FILE_BYTES)?;
                budget.1 += bytes.len() as u64;
                if budget.1 > MAX_TOTAL_BYTES {
                    return Err(ierrp("err_market.too_large_total", &[("limit", &MAX_TOTAL_BYTES.to_string())]));
                }
                std::fs::write(dest.join(&row.name), &bytes)
                    .map_err(|e| ierrp("err_market.write_failed", &[("detail", &e.to_string())]))?;
            }
            // "symlink" / "submodule" — neither is a plugin file, and a symlink
            // from a listing is exactly the escape `safe_component` is guarding.
            _ => continue,
        }
    }
    Ok(())
}

fn market_root(app: &AppHandle<Wry>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| ierrp("err_plugins.could_not_resolve_config_dir", &[("detail", &e.to_string())]))?
        .join(MARKET_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|e| ierrp("err_plugins.could_not_create_config_dir", &[("detail", &e.to_string())]))?;
    Ok(dir)
}

/// Read the community index.
///
/// `async fn` + `run_blocking` for the same reason every other IO command
/// here is: a network round trip has no business on the thread driving the
/// window. JS: `commands.fetchPluginIndex()` -> `Result<PluginIndex, string>`.
#[tauri::command]
#[specta::specta]
pub async fn fetch_plugin_index() -> Result<PluginIndex, String> {
    crate::blocking::run_blocking(move || {
        let bytes = get(INDEX_URL, MAX_INDEX_BYTES)?;
        let index: PluginIndex = serde_json::from_slice(&bytes)
            .map_err(|e| ierrp("err_market.bad_index", &[("detail", &e.to_string())]))?;
        if index.schema_version != 1 {
            return Err(ierrp("err_market.index_too_new", &[("version", &index.schema_version.to_string())]));
        }
        Ok(index)
    })
    .await
}

/// Download one catalogue entry's files into a GitCat-owned folder and return
/// that folder's path.
///
/// This INSTALLS NOTHING. The caller hands the returned path to
/// `preview_plugin_manifest` and then, once the user has seen what the plugin
/// runs and confirmed, to `install_plugin_from_path` — the same two steps a
/// file-picker install takes, with the same gates.
///
/// JS: `commands.downloadMarketPlugin(entry)` -> `Result<string, string>`.
#[tauri::command]
#[specta::specta]
pub async fn download_market_plugin(app: AppHandle<Wry>, entry: MarketEntry) -> Result<String, String> {
    crate::blocking::run_blocking(move || {
        safe_component(&entry.id)?;
        let loc = locate(&entry)?;
        let dest = market_root(&app)?.join(&entry.id);
        // A re-download must not merge into whatever a previous attempt left:
        // a stale `main.lua` from an older version would otherwise survive and
        // be what actually runs.
        if dest.exists() {
            std::fs::remove_dir_all(&dest)
                .map_err(|e| ierrp("err_market.write_failed", &[("detail", &e.to_string())]))?;
        }
        let mut budget = (0usize, 0u64);
        fetch_dir(&loc, &loc.dir, &dest, 0, &mut budget)?;
        if !dest.join("plugin.json").is_file() {
            let _ = std::fs::remove_dir_all(&dest);
            return Err(ierrp("err_market.no_manifest", &[("id", &entry.id)]));
        }
        dest.to_str()
            .map(str::to_string)
            .ok_or_else(|| ierr("err_market.write_failed"))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: &str) -> MarketEntry {
        MarketEntry {
            kind: kind.into(),
            id: "demo".into(),
            name: "Demo".into(),
            description: "d".into(),
            author: "a".into(),
            min_gitcat_version: None,
            tags: vec![],
            manifest_url: None,
            repo_path: None,
            repo: None,
            manifest_path: None,
            homepage: None,
        }
    }

    #[test]
    fn only_https_and_only_the_two_github_hosts_are_reachable() {
        assert!(host_allowed("https://raw.githubusercontent.com/o/r/HEAD/plugin.json"));
        assert!(host_allowed("https://api.github.com/repos/o/r/contents/x"));
        for bad in [
            "http://raw.githubusercontent.com/o/r",          // plaintext
            "https://evil.test/plugin.json",                 // other host
            "https://raw.githubusercontent.com.evil.test/x", // suffix trick
            "https://raw.githubusercontent.com@evil.test/x", // userinfo trick
            "https://github.com/o/r/blob/main/plugin.json",  // HTML, not raw
            "file:///etc/passwd",
            "",
        ] {
            assert!(!host_allowed(bad), "{bad:?} must not be reachable");
        }
    }

    #[test]
    fn a_listing_cannot_name_its_way_out_of_the_plugin_folder() {
        assert!(safe_component("plugin.json").is_ok());
        assert!(safe_component("main.lua").is_ok());
        assert!(safe_component("assets").is_ok());
        for bad in ["", ".", "..", "../x", "a/b", "a\\b", "/abs", "C:\\x", "x\0y"] {
            assert!(safe_component(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn a_community_repo_url_must_be_exactly_a_github_repo_root() {
        assert_eq!(parse_github_repo("https://github.com/o/r").unwrap(), ("o".into(), "r".into()));
        assert_eq!(parse_github_repo("https://github.com/o/r/").unwrap(), ("o".into(), "r".into()));
        for bad in [
            "https://github.com/o",             // no repo
            "https://github.com/o/r/tree/main", // deeper than a root
            "https://gitlab.com/o/r",           // other forge
            "http://github.com/o/r",            // plaintext
            "https://github.com//r",            // empty owner
        ] {
            assert!(parse_github_repo(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn a_manifest_path_cannot_climb_out_of_its_repo() {
        assert_eq!(manifest_dir("plugin.json").unwrap(), "");
        assert_eq!(manifest_dir("plugins/mine/plugin.json").unwrap(), "plugins/mine");
        for bad in ["/plugin.json", "../plugin.json", "a/../../plugin.json", "./plugin.json"] {
            assert!(manifest_dir(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn official_entries_resolve_into_the_index_repo_and_community_ones_into_their_own() {
        let mut off = entry("official");
        off.repo_path = Some("official/language-pack".into());
        assert_eq!(
            locate(&off).unwrap(),
            Location { owner: "zangjiucheng".into(), repo: "gitcat-plugins".into(), dir: "official/language-pack".into() }
        );

        let mut com = entry("community");
        com.repo = Some("https://github.com/someone/their-plugin".into());
        com.manifest_path = Some("plugins/mine/plugin.json".into());
        assert_eq!(
            locate(&com).unwrap(),
            Location { owner: "someone".into(), repo: "their-plugin".into(), dir: "plugins/mine".into() }
        );

        // A row missing the half its own kind needs is a bad row, not a panic.
        assert!(locate(&entry("official")).is_err());
        assert!(locate(&entry("community")).is_err());
        assert!(locate(&entry("sponsored")).is_err(), "an unknown kind must not be fetched");
    }

    #[test]
    fn urls_are_built_against_head_so_a_renamed_default_branch_still_resolves() {
        let loc = Location { owner: "o".into(), repo: "r".into(), dir: "p".into() };
        assert_eq!(raw_url(&loc, "p/plugin.json"), "https://raw.githubusercontent.com/o/r/HEAD/p/plugin.json");
        assert_eq!(raw_url(&loc, ""), "https://raw.githubusercontent.com/o/r/HEAD");
        assert_eq!(contents_url(&loc, "p"), "https://api.github.com/repos/o/r/contents/p");
        // Everything this module builds must itself pass the allowlist.
        assert!(host_allowed(&raw_url(&loc, "p/plugin.json")));
        assert!(host_allowed(&contents_url(&loc, "p")));
    }

    /// reqwest is built with `rustls-no-provider` to keep aws-lc-rs and a cmake
    /// build out of the tree, which makes "a default CryptoProvider exists"
    /// a runtime precondition rather than a compile-time one. If that ever
    /// stops holding, every download fails — so pin it here, where it costs
    /// nothing and needs no network.
    /// The one test that talks to GitHub, so `#[ignore]`d: CI must not go red
    /// because somebody else's network did. Run it by hand when the index
    /// format changes:
    ///
    /// ```text
    /// cargo test --lib plugin_market -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "network: fetches the live community index"]
    fn live_index_parses_and_its_entries_all_locate() {
        let bytes = get(INDEX_URL, MAX_INDEX_BYTES).expect("the live index must be fetchable");
        let index: PluginIndex = serde_json::from_slice(&bytes).expect("the live index must parse");
        assert_eq!(index.schema_version, 1, "this GitCat understands schemaVersion 1");
        assert_eq!(index.count as usize, index.plugins.len(), "count must match the array it describes");
        println!("index: {} plugin(s), generated {}", index.count, index.generated_at);
        for e in &index.plugins {
            let loc = locate(e).unwrap_or_else(|err| panic!("entry {:?} does not locate: {err}", e.id));
            println!("  {:10} {:22} -> {}/{} @ {}", e.kind, e.id, loc.owner, loc.repo, loc.dir);
            assert!(host_allowed(&contents_url(&loc, &loc.dir)), "every entry must resolve to an allowed host");
        }
    }

    #[test]
    fn client_builds() {
        assert!(client().is_ok(), "the HTTPS client must build: {:?}", client().err());
    }

    #[test]
    fn the_pinned_index_url_is_itself_allowlisted() {
        assert!(host_allowed(INDEX_URL), "the index URL must satisfy the same check every fetch does");
    }
}
