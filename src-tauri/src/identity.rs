//! Repo-local git identity (user.name/user.email) — setup wizard.
//!
//! Every read/write here passes an explicit `--local` to the git CLI, so it
//! can NEVER read or write `~/.gitconfig` or the system config — stricter
//! than rerere::rerere_set_enabled's reliance on plain `git config`'s
//! local-by-default behavior. git2::Config is deliberately NOT used: its
//! layered-config API makes "local only" a matter of picking the right
//! ConfigLevel correctly, whereas `--local` on the CLI is an explicit,
//! unambiguous, well-documented restriction (same read/write-via-CLI split
//! as git_write.rs and safety.rs — libgit2 is for reads elsewhere, never for
//! identity mutation here).

use serde::Serialize;

use crate::git_write::WriteResult;
use crate::safety::{self, GitOut};

#[derive(Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
    /// true only when BOTH name and email are set in this repo's local config.
    pub configured: bool,
}

/// JS: `commands.getGitIdentity(path)` -> `Promise<Result<GitIdentity,string>>`.
/// Fails only if `path` isn't a git repository at all (used by the setup
/// wizard as its directory-validation step, doubling as the identity check).
#[tauri::command]
#[specta::specta]
pub fn get_git_identity(path: String) -> Result<GitIdentity, String> {
    crate::trust::open_repo(&path)
        .map_err(|e| format!("That doesn't look like a git repository — {}", e.message()))?;
    let name = read_local(&path, "user.name");
    let email = read_local(&path, "user.email");
    let configured = name.is_some() && email.is_some();
    Ok(GitIdentity { name, email, configured })
}

fn read_local(path: &str, key: &str) -> Option<String> {
    let out = safety::run_git(path, &["config", "--local", "--get", key]).ok()?;
    if !out.ok {
        return None; // unset locally (git exits 1) — not an error
    }
    let v = out.stdout.trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// JS: `commands.setGitIdentity(path, name, email)` -> `Promise<WriteResult>`
/// (never rejects; `ok:false` + message on failure). Writes ONLY this repo's
/// local config (never `--global`). Non-destructive metadata, no ref/history
/// touched, so — per the safety-model convention used by rerere_set_enabled —
/// this does NOT take a Safety Manager snapshot first.
#[tauri::command]
#[specta::specta]
pub fn set_git_identity(path: String, name: String, email: String) -> WriteResult {
    if let Err(e) = crate::trust::open_repo(&path) {
        return WriteResult {
            ok: false,
            message: format!("Cannot open repository: {}", e.message()),
            backup_ref: None,
        };
    }
    let name = name.trim();
    let email = email.trim();
    if name.is_empty() || email.is_empty() {
        return WriteResult {
            ok: false,
            message: "Name and email must not be empty.".to_string(),
            backup_ref: None,
        };
    }
    if let Err(msg) = write_local(&path, "user.name", name) {
        return WriteResult { ok: false, message: msg, backup_ref: None };
    }
    if let Err(msg) = write_local(&path, "user.email", email) {
        return WriteResult { ok: false, message: msg, backup_ref: None };
    }
    WriteResult {
        ok: true,
        message: format!("Set identity for this repository: {name} <{email}>."),
        backup_ref: None,
    }
}

fn write_local(path: &str, key: &str, value: &str) -> Result<(), String> {
    match safety::run_git(path, &["config", "--local", key, value]) {
        Ok(out) if out.ok => Ok(()),
        Ok(out) => Err(err_msg(&out)),
        Err(e) => Err(e),
    }
}

/// Best human message from a failed git run (prefer stderr).
fn err_msg(o: &GitOut) -> String {
    if !o.stderr.is_empty() {
        o.stderr.clone()
    } else if !o.stdout.is_empty() {
        o.stdout.clone()
    } else {
        format!("git exited with status {}", o.code)
    }
}
