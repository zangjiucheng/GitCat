//! Repo-scoped git configuration — a generalized companion to
//! `identity.rs`'s local/global-scoped read/write, which is hardcoded to
//! `user.name`/`user.email` only. Same approach: `git2::Config` is
//! deliberately NOT used (its layered-config API makes scope selection a
//! matter of picking the right `ConfigLevel`, whereas `--local`/`--global`
//! on the CLI is explicit and unambiguous — same read/write-via-CLI split as
//! `identity.rs`/`rerere.rs`/`safety.rs`), and reads resolve per-key exactly
//! like `identity::resolve`: this repo's own `--local` override wins if set,
//! otherwise whatever `--global` resolves to.
//!
//! Unlike `identity.rs` (writes are unconditionally `--local`-only), THIS
//! module's writes go to whichever [`ConfigScope`] the caller asks for,
//! `--local` or `--global` — the whole point is to let Settings fix a
//! machine-wide setting (e.g. `core.autocrlf`) at its actual source, not just
//! shadow it per-repo. Settings drives this in two ways from the SAME two
//! generic commands here — the split between "curated well-known keys with
//! dedicated controls" and "advanced free-form key/value editing" is purely
//! a frontend concern, not a backend one.

use serde::{Deserialize, Serialize};

use crate::git_write::WriteResult;
use crate::safety::{self, GitOut};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum ConfigScope {
    Local,
    Global,
}

impl ConfigScope {
    fn flag(self) -> &'static str {
        match self {
            ConfigScope::Local => "--local",
            ConfigScope::Global => "--global",
        }
    }

    fn label(self) -> &'static str {
        match self {
            ConfigScope::Local => "this repository",
            ConfigScope::Global => "global",
        }
    }
}

/// One config key's value at each scope, plus the effective (local-wins)
/// result — same shape/naming spirit as `identity::GitIdentity`, generalized
/// from two hardcoded fields to an arbitrary caller-supplied key.
#[derive(Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEntry {
    pub key: String,
    pub local: Option<String>,
    pub global: Option<String>,
    /// `local` if set, else `global`, else `None` — identical per-key
    /// fallback to `identity::resolve`'s own name/email handling.
    pub effective: Option<String>,
}

/// One raw `key = value` line from `git config --list`, used by the
/// Settings "Advanced" section to show what's already set at a scope rather
/// than requiring the user to already know a key's exact name. Deliberately
/// NOT deduplicated by key: a genuinely multi-valued key (e.g.
/// `remote.origin.fetch`) shows as one row per value, matching what
/// `git config --list` itself reports — editing such a row through
/// [`set_git_config_value`] (a plain, non-`--add` write) will cleanly fail
/// with git's own "multiple values" error rather than silently collapsing
/// them, since dedicated GitCat UI (Remotes, Submodules) already owns those
/// keys.
#[derive(Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RawConfigEntry {
    pub key: String,
    pub value: String,
}

/// Reject anything that isn't an ordinary `section.key` /
/// `section.subsection.key` git config key name — same charset-allowlist
/// spirit as `tool_settings.rs`'s `normalize_tool` (restrict at the one
/// place the user types it, rather than re-validate at every call site).
/// Real git config keys allow far more exotic characters in a quoted
/// subsection than this accepts — deliberately not trying to support that
/// here; this allowlist covers every ordinary key a settings UI would ever
/// need (letters/digits/`-`/`_` per dot-separated part).
fn validate_key(key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Config key must not be empty.".into());
    }
    let parts: Vec<&str> = key.split('.').collect();
    if parts.len() < 2 {
        return Err(format!("{key:?} doesn't look like a git config key (expected e.g. \"section.key\")."));
    }
    if parts.iter().any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')) {
        return Err(format!(
            "{key:?} contains characters a git config key can't have here — each dot-separated part may only use letters, digits, '-' and '_'."
        ));
    }
    Ok(())
}

/// Reject a value that would be misread as a flag by git's own argv parser —
/// same footgun `tool_settings.rs`'s `validate_arg` / `conflict.rs`'s
/// `validate_path` already guard other commands against. Not a security
/// boundary (`safety::run_git` passes this as one argv element via
/// `Command::args`, never a shell, so there's no injection risk from its
/// content either way) — purely so `git config --local core.editor -x`
/// doesn't get parsed as an unknown `-x` flag instead of a literal value.
fn validate_value(v: &str) -> Result<(), String> {
    if v.starts_with('-') {
        return Err(format!("Refusing a value that looks like a flag: {v:?}"));
    }
    Ok(())
}

/// JS: `commands.getGitConfigValues(path, keys)` ->
/// `Promise<Result<ConfigEntry[], string>>`. Reads each requested key at
/// BOTH `--local` and `--global` (2 subprocess calls per key), used both for
/// the curated fields (`core.autocrlf`, `pull.rebase`, ...) and to re-read a
/// single key right after an Advanced-section save.
///
/// BUG FIX: was a plain (non-async) `fn` — like `identity::get_git_identity`,
/// it opens the repo via `git2` and then shells out to `git config --get`
/// twice per key via `safety::run_git`, waiting on each subprocess. Run
/// synchronously, all of that happened inline on Tauri's MAIN thread,
/// freezing the whole window for as long as every Settings-panel-open git
/// config read took, not just this one call. `async fn` + `run_blocking`
/// moves it off that thread.
#[tauri::command]
#[specta::specta]
pub async fn get_git_config_values(path: String, keys: Vec<String>) -> Result<Vec<ConfigEntry>, String> {
    crate::blocking::run_blocking(move || {
        crate::trust::open_repo(&path).map_err(|e| format!("Cannot open repository: {}", e.message()))?;
        Ok(keys.iter().map(|k| read_entry(&path, k)).collect())
    })
    .await
}

fn read_entry(path: &str, key: &str) -> ConfigEntry {
    let local = read_scoped(path, key, "--local");
    let global = read_scoped(path, key, "--global");
    let effective = local.clone().or_else(|| global.clone());
    ConfigEntry { key: key.to_string(), local, global, effective }
}

fn read_scoped(path: &str, key: &str, scope: &str) -> Option<String> {
    let out = safety::run_git(path, &["config", scope, "--get", key]).ok()?;
    if !out.ok {
        return None; // unset at this scope (git exits 1) — not an error
    }
    let v = out.stdout.trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// JS: `commands.listGitConfigEntries(path, scope)` ->
/// `Promise<Result<RawConfigEntry[], string>>`. Backs the Advanced section's
/// initial listing — `git config <scope> --list -z` (NUL-terminated records,
/// each `key\nvalue`) so a value containing its own newline can never be
/// misparsed as a record boundary the way naive line-splitting would.
///
/// BUG FIX: was never a sync command in the first place (new in this batch)
/// — written `async fn` + `run_blocking` from the start, matching every
/// other repo-touching command fixed this session, rather than introducing a
/// new instance of the same main-thread-freeze bug on day one.
#[tauri::command]
#[specta::specta]
pub async fn list_git_config_entries(path: String, scope: ConfigScope) -> Result<Vec<RawConfigEntry>, String> {
    crate::blocking::run_blocking(move || {
        crate::trust::open_repo(&path).map_err(|e| format!("Cannot open repository: {}", e.message()))?;
        let out = safety::run_git(&path, &["config", scope.flag(), "--list", "-z"])?;
        if !out.ok {
            // `--list` on a scope with no config file at all (e.g. no
            // --local section yet, or global config file missing) exits
            // non-zero with empty output — a clean "nothing set" signal,
            // not an error.
            return Ok(Vec::new());
        }
        Ok(parse_list_z(&out.stdout))
    })
    .await
}

/// Parses `git config --list -z` output: NUL-terminated records, each
/// `key\nvalue` (key and value separated by the FIRST newline; the value
/// itself may contain further newlines for a genuinely multi-line config
/// value, which this correctly preserves since it only splits on the first
/// one). Pure, no I/O — unit-tested directly below.
fn parse_list_z(raw: &str) -> Vec<RawConfigEntry> {
    raw.split('\0')
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            let (key, value) = record.split_once('\n')?;
            Some(RawConfigEntry { key: key.to_string(), value: value.to_string() })
        })
        .collect()
}

/// JS: `commands.setGitConfigValue(path, key, value, scope)` ->
/// `Promise<WriteResult>` (never rejects; `ok:false` + message on failure,
/// same non-`Result` contract as `identity::set_git_identity`).
/// `value: null` unsets the key AT THAT SCOPE (`git config --unset`) rather
/// than writing an empty string. Non-destructive metadata, no ref/history
/// touched, so — per the safety-model convention `rerere_set_enabled`/
/// `set_git_identity` already established — this does NOT take a Safety
/// Manager snapshot first.
///
/// BUG FIX: was never a sync command in the first place (new in this batch)
/// — written `async fn` + `run_blocking` from the start.
#[tauri::command]
#[specta::specta]
pub async fn set_git_config_value(path: String, key: String, value: Option<String>, scope: ConfigScope) -> WriteResult {
    crate::blocking::run_blocking(move || {
        if let Err(e) = crate::trust::open_repo(&path) {
            return err_result(format!("Cannot open repository: {}", e.message()));
        }
        if let Err(msg) = validate_key(&key) {
            return err_result(msg);
        }
        let key = key.trim();
        if let Some(v) = &value {
            if let Err(msg) = validate_value(v) {
                return err_result(msg);
            }
        }
        let scope_flag = scope.flag();
        let result = match &value {
            Some(v) => safety::run_git(&path, &["config", scope_flag, key, v]),
            None => safety::run_git(&path, &["config", scope_flag, "--unset", key]),
        };
        match result {
            Ok(out) if out.ok => ok_result(match &value {
                Some(v) => format!("Set {key} = {v:?} ({}).", scope.label()),
                None => format!("Unset {key} ({}).", scope.label()),
            }),
            // `git config --unset` on a key that's already unset at this
            // scope exits 5 ("you try to unset an option which does not
            // exist", per git's own documented config exit codes) — treat
            // as a successful no-op, matching how `read_scoped` above
            // already treats "unset" as a normal, non-error outcome rather
            // than surfacing git's plumbing-level exit code as a UI error.
            Ok(out) if value.is_none() && out.code == 5 => ok_result(format!("{key} was already unset ({}).", scope.label())),
            Ok(out) => err_result(err_msg(&out)),
            Err(e) => err_result(e),
        }
    })
    .await
}

fn ok_result(message: String) -> WriteResult {
    WriteResult { ok: true, message, backup_ref: None, conflicting_files: Vec::new() }
}

fn err_result(message: String) -> WriteResult {
    WriteResult { ok: false, message, backup_ref: None, conflicting_files: Vec::new() }
}

/// Best human message from a failed git run (prefer stderr) — identical copy
/// to every other module's own (`identity.rs`, `rerere.rs`, `conflict.rs`,
/// `tool_settings.rs`).
fn err_msg(o: &GitOut) -> String {
    if !o.stderr.is_empty() {
        o.stderr.clone()
    } else if !o.stdout.is_empty() {
        o.stdout.clone()
    } else {
        format!("git exited with status {}", o.code)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_key_accepts_ordinary_keys() {
        assert!(validate_key("core.autocrlf").is_ok());
        assert!(validate_key("pull.rebase").is_ok());
        assert!(validate_key("difftool.meld.cmd").is_ok());
        assert!(validate_key("  core.autocrlf  ").is_ok(), "surrounding whitespace should be trimmed, not rejected");
    }

    #[test]
    fn validate_key_rejects_bare_or_malformed() {
        assert!(validate_key("").is_err());
        assert!(validate_key("   ").is_err());
        assert!(validate_key("nosection").is_err(), "a key needs at least one dot");
        assert!(validate_key("core..autocrlf").is_err(), "an empty dot-separated part is invalid");
        assert!(validate_key("core.auto crlf").is_err(), "a space isn't allowed in a part");
        assert!(validate_key("core.auto;rm -rf").is_err(), "shell-metacharacter-looking input is still just rejected as an invalid key, not specially detected");
    }

    #[test]
    fn validate_value_rejects_flaglike_input() {
        assert!(validate_value("-x").is_err());
        assert!(validate_value("--evil").is_err());
        assert!(validate_value("input").is_ok());
        assert!(validate_value("").is_ok(), "an empty value is legal git config content (e.g. an intentionally blank credential.helper)");
    }

    #[test]
    fn parse_list_z_splits_nul_records_and_first_newline_only() {
        let raw = "core.autocrlf\ntrue\0core.editor\nvim\0";
        let entries = parse_list_z(raw);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].key, "core.autocrlf");
        assert_eq!(entries[0].value, "true");
        assert_eq!(entries[1].key, "core.editor");
        assert_eq!(entries[1].value, "vim");
    }

    #[test]
    fn parse_list_z_preserves_a_value_containing_its_own_newline() {
        // Only the FIRST newline in a record separates key from value —
        // everything after it, including further newlines, is part of the
        // value. A naive line-based (non -z) parse would misread this as
        // two separate malformed records.
        let raw = "alias.multi\nline one\nline two\0";
        let entries = parse_list_z(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].key, "alias.multi");
        assert_eq!(entries[0].value, "line one\nline two");
    }

    #[test]
    fn parse_list_z_handles_empty_input() {
        assert!(parse_list_z("").is_empty());
    }

    #[test]
    fn parse_list_z_keeps_duplicate_keys_as_separate_rows() {
        // A genuinely multi-valued key (e.g. two remote.origin.fetch
        // refspecs) must show as two rows, not silently collapse to one —
        // see RawConfigEntry's own doc comment for why.
        let raw = "remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*\0remote.origin.fetch\n+refs/tags/*:refs/tags/*\0";
        let entries = parse_list_z(raw);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].key, "remote.origin.fetch");
        assert_eq!(entries[1].key, "remote.origin.fetch");
        assert_ne!(entries[0].value, entries[1].value);
    }
}
