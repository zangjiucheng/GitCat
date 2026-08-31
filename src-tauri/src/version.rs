//! The host's own version number, in one place.
//!
//! GitCat's version is spelled out in five files that have to agree:
//! `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`,
//! `package.json` and `nix/package.nix`. Every release bumps all five by hand
//! and, until this module, nothing would have caught one of them being missed
//! — the 1.2.0 cut did exactly that and got away with it.
//!
//! `Cargo.toml` is the source of truth, because Cargo already hands its value
//! to the compiler: [`HOST_VERSION`] is `CARGO_PKG_VERSION`, resolved at build
//! time with no parsing, no I/O and nothing to keep in sync. Rust code that
//! needs to know what version it is running reads that constant and nothing
//! else.
//!
//! The other four are CHECKED, not derived. Deriving them would mean a build
//! script rewriting files inside the source tree, and `tauri.conf.json` in
//! particular is read by `tauri build` before our `build.rs` runs, so it cannot
//! be generated late. That is a lot of machinery for a value that changes once
//! per release. The test at the bottom of this file reads all five instead and
//! fails naming whichever one drifted, which buys the same protection for none
//! of the surgery.
//!
//! Note the app already has a second version accessor,
//! `app.package_info().version` (`commands.rs:37`). It reads
//! `tauri.conf.json`, it needs an `AppHandle`, and it is fine where it is used.
//! [`HOST_VERSION`] exists alongside it because the places that need to COMPARE
//! versions — plugin manifest validation, in particular — run nowhere near an
//! `AppHandle`. The test below is what keeps the two from ever disagreeing.

/// GitCat's version, straight from `src-tauri/Cargo.toml` by way of Cargo's
/// own `CARGO_PKG_VERSION`.
///
/// This is the single value the Rust side compares against. It is a `&'static
/// str` of the literal text in the manifest (`"1.2.0"`), not a parsed
/// structure — parse it where you need to order two versions.
pub const HOST_VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use super::HOST_VERSION;
    use std::path::PathBuf;

    /// The repository root: the parent of `src-tauri/`, which is what Cargo
    /// points `CARGO_MANIFEST_DIR` at. Resolved at COMPILE time, so this holds
    /// whatever working directory the test runner happens to use.
    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri/ always has a parent")
            .to_path_buf()
    }

    fn read(rel: &str) -> String {
        let path = repo_root().join(rel);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("could not read {}: {e}", path.display()))
    }

    /// The top-level `"version"` string of a JSON file.
    fn json_version(rel: &str) -> String {
        let value: serde_json::Value =
            serde_json::from_str(&read(rel)).unwrap_or_else(|e| panic!("{rel} is not valid JSON: {e}"));
        value
            .get("version")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_else(|| panic!("{rel} has no top-level string `version`"))
            .to_string()
    }

    /// `key = "value"` off one line, for the two files that are not JSON. Only
    /// matches when `key` is the WHOLE left-hand side, so `versionSuffix = "x"`
    /// does not answer a query for `version`.
    fn quoted_value(line: &str, key: &str) -> Option<String> {
        let rest = line.trim().strip_prefix(key)?.trim_start().strip_prefix('=')?.trim_start();
        let rest = rest.strip_prefix('"')?;
        let end = rest.find('"')?;
        Some(rest[..end].to_string())
    }

    /// The version Cargo.lock records for the `gitcat` package itself. Scoped
    /// to that one `[[package]]` block, so none of the several hundred
    /// dependency versions in the same file can answer instead.
    fn cargo_lock_version() -> String {
        let text = read("src-tauri/Cargo.lock");
        let mut lines = text.lines();
        while let Some(line) = lines.next() {
            if line.trim() != r#"name = "gitcat""# {
                continue;
            }
            for line in lines.by_ref() {
                if line.trim() == "[[package]]" {
                    break;
                }
                if let Some(v) = quoted_value(line, "version") {
                    return v;
                }
            }
            panic!("src-tauri/Cargo.lock has a `gitcat` package block with no `version`");
        }
        panic!("src-tauri/Cargo.lock has no package named `gitcat`");
    }

    /// The `version = "…";` attribute in the Nix derivation.
    fn nix_version() -> String {
        let text = read("nix/package.nix");
        text.lines()
            .find_map(|line| quoted_value(line, "version"))
            .unwrap_or_else(|| panic!("nix/package.nix has no `version = \"…\";` attribute"))
    }

    /// The whole point of this module. `src-tauri/Cargo.toml` is authoritative
    /// (it is what `HOST_VERSION` compiles from); every other file that spells
    /// the version out has to match it, and this is what says so out loud when
    /// a release bump misses one.
    #[test]
    fn every_file_that_spells_out_the_host_version_agrees_with_cargo_toml() {
        let others = [
            ("package.json", json_version("package.json")),
            ("src-tauri/tauri.conf.json", json_version("src-tauri/tauri.conf.json")),
            ("src-tauri/Cargo.lock", cargo_lock_version()),
            ("nix/package.nix", nix_version()),
        ];
        for (file, found) in others {
            assert_eq!(
                found, HOST_VERSION,
                "{file} says {found:?} but src-tauri/Cargo.toml — the source of truth — says {HOST_VERSION:?}. \
                 Bump every file listed in src-tauri/src/version.rs's module doc together."
            );
        }
    }
}
