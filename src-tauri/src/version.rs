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

/// A version reduced to the three numbers that order it.
pub type Version = (u64, u64, u64);

/// Parse `major[.minor[.patch]]` into the triple that orders it, or `None` if
/// the string is not a version at all.
///
/// Two deliberate leniencies, both in the direction of accepting what an author
/// obviously meant:
///
/// * A missing component reads as zero, so `"1.3"` is `1.3.0`. A plugin author
///   writing the two-component form means the 1.3 line, and refusing it would
///   be pedantry with an install error attached.
/// * A `-prerelease` or `+build` suffix is DROPPED before parsing. Nightly
///   builds carry one (`1.3.0-nightly.4`), and a plugin asking for 1.3.0 wants
///   the feature set, not a particular build of it. The corollary is that a
///   nightly counts as its base version, which is the answer that makes a
///   nightly useful for testing plugins.
///
/// Anything else — empty, non-numeric, more than three components, a component
/// that overflows `u64` — is `None`, and callers turn that into a manifest
/// error rather than guessing.
pub fn parse(v: &str) -> Option<Version> {
    let core = v.trim();
    let core = core.split(['-', '+']).next()?;
    if core.is_empty() {
        return None;
    }
    let mut parts = core.split('.');
    let mut out = [0u64; 3];
    for slot in out.iter_mut() {
        match parts.next() {
            None => break,
            Some(p) => *slot = p.parse().ok()?,
        }
    }
    if parts.next().is_some() {
        return None; // four or more components is not a version we understand
    }
    Some((out[0], out[1], out[2]))
}

/// Is this host at least `required`?
///
/// `None` means `required` is not parseable as a version — the caller's job is
/// to report that as a bad manifest, NOT to fall back to allowing the install.
/// Silently admitting a plugin whose floor we could not read is exactly the
/// failure mode this whole mechanism exists to prevent.
pub fn host_meets(required: &str) -> Option<bool> {
    let required = parse(required)?;
    let host = parse(HOST_VERSION).expect("HOST_VERSION comes from Cargo.toml and always parses");
    Some(host >= required)
}

#[cfg(test)]
mod tests {
    use super::{host_meets, parse, HOST_VERSION};
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

    #[test]
    fn parse_accepts_the_forms_a_manifest_author_actually_writes() {
        assert_eq!(parse("1.3.0"), Some((1, 3, 0)));
        assert_eq!(parse("1.3"), Some((1, 3, 0)), "a missing component reads as zero");
        assert_eq!(parse("2"), Some((2, 0, 0)));
        assert_eq!(parse(" 1.3.0 "), Some((1, 3, 0)), "surrounding whitespace is not a syntax error");
        assert_eq!(parse("1.3.0-nightly.4"), Some((1, 3, 0)), "a prerelease counts as its base version");
        assert_eq!(parse("1.3.0+build7"), Some((1, 3, 0)), "build metadata is dropped");
        assert_eq!(parse("10.0.0"), Some((10, 0, 0)), "components are numbers, not characters");
    }

    #[test]
    fn parse_rejects_what_is_not_a_version() {
        for bad in ["", "   ", "banana", "1.x", "1.3.0.1", "v1.3.0", "1..0", "-1.0.0", "1.3.-0"] {
            assert_eq!(parse(bad), None, "{bad:?} must not parse as a version");
        }
    }

    #[test]
    fn parse_orders_by_number_not_by_string() {
        // The whole reason this is a triple and not a string compare: "10" < "9"
        // lexicographically, and a plugin floor of 1.9.0 must not lock out 1.10.0.
        assert!(parse("1.10.0") > parse("1.9.0"));
        assert!(parse("2.0.0") > parse("1.99.99"));
    }

    #[test]
    fn host_meets_compares_against_this_build_and_reports_an_unreadable_floor() {
        let (maj, min, patch) = parse(HOST_VERSION).expect("the host version must parse");
        assert_eq!(host_meets(HOST_VERSION), Some(true), "a host always meets its own version");
        assert_eq!(host_meets(&format!("{maj}.{min}.{patch}")), Some(true));
        assert_eq!(host_meets(&format!("{}.0.0", maj + 1)), Some(false), "a newer major is not met");
        assert_eq!(host_meets("0.0.1"), Some(true), "an ancient floor is met");
        assert_eq!(host_meets("banana"), None, "an unreadable floor is None, never a silent yes");
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
