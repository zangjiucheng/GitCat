//! Git identity (user.name/user.email) — setup wizard + Settings.
//!
//! WRITES are unconditionally `--local`-only, no exceptions: `set_git_identity`
//! passes an explicit `--local` to the git CLI, so it can NEVER write
//! `~/.gitconfig` or the system config — stricter than
//! rerere::rerere_set_enabled's reliance on plain `git config`'s
//! local-by-default behavior.
//!
//! READS are more permissive by design: `get_git_identity` reports the
//! EFFECTIVE identity a commit made right now would actually use — this
//! repo's own local override where it has one, falling back to `--global`
//! otherwise, independently PER FIELD (exactly matching git's own real
//! config-layering semantics: a repo that locally overrides only
//! `user.name` still inherits `user.email` from global — see [`resolve`]).
//! Without this fallback, the overwhelmingly common case — an identity set
//! once, globally, years ago, never overridden per-repo — would show up as
//! "unconfigured" everywhere: the setup wizard would force every single new
//! repo through its own identity-entry step, and Settings would show
//! misleadingly blank Name/Email fields for a repo that already commits
//! just fine. `local` on the returned struct distinguishes "this repo has
//! its own override" from "inherited from global", for Settings' own
//! messaging and because it's what `set_git_identity` would be overriding
//! were it called.
//!
//! git2::Config is deliberately NOT used for either reads or writes: its
//! layered-config API makes scope selection a matter of picking the right
//! ConfigLevel correctly, whereas `--local`/`--global` on the CLI is an
//! explicit, unambiguous, well-documented restriction (same read/write-via-
//! CLI split as git_write.rs and safety.rs — libgit2 is for reads
//! elsewhere, never for identity here).

use serde::Serialize;

use crate::git_write::WriteResult;
use crate::safety::{self, GitOut};

#[derive(Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    /// Effective value: this repo's own local override if set, otherwise
    /// whatever `--global` resolves to. `None` only when NEITHER has it.
    pub name: Option<String>,
    pub email: Option<String>,
    /// true when an effective name AND email exist from EITHER source — "a
    /// commit made right now would already have an identity". Drives the
    /// setup wizard's skip-the-identity-step gate.
    pub configured: bool,
    /// true only when BOTH are set in THIS repo's own local config
    /// specifically, not inherited from global — lets Settings distinguish
    /// "set for this repo" from "using your global identity".
    pub local: bool,
}

/// JS: `commands.getGitIdentity(path)` -> `Promise<Result<GitIdentity,string>>`.
/// Fails only if `path` isn't a git repository at all (used by the setup
/// wizard as its directory-validation step, doubling as the identity check).
///
/// BUG FIX: was a plain (non-async) `fn` — it opens the repo via `git2` and
/// then shells out to `git config --get` up to four times (local/global x
/// name/email) via `safety::run_git`, waiting on each subprocess in turn. Run
/// synchronously, all of that happened inline on Tauri's MAIN thread, so the
/// setup wizard's directory-validation step (and every Settings panel open)
/// froze the whole window for as long as those four spawns took, not just
/// this one read. `async fn` + `run_blocking` moves it off that thread.
#[tauri::command]
#[specta::specta]
pub async fn get_git_identity(path: String) -> Result<GitIdentity, String> {
    crate::blocking::run_blocking(move || {
        crate::trust::open_repo(&path)
            .map_err(|e| format!("That doesn't look like a git repository — {}", e.message()))?;
        let local_name = read_scoped(&path, "user.name", "--local");
        let local_email = read_scoped(&path, "user.email", "--local");
        let global_name = read_scoped(&path, "user.name", "--global");
        let global_email = read_scoped(&path, "user.email", "--global");
        Ok(resolve(local_name, local_email, global_name, global_email))
    })
    .await
}

/// Pure merge logic, no I/O — independently testable (see module tests
/// below). Mirrors git's own real per-key config layering: `user.name`/
/// `user.email` each fall back to global independently, so a repo that
/// locally overrides only one of the two still inherits the other from
/// global rather than losing it.
fn resolve(
    local_name: Option<String>,
    local_email: Option<String>,
    global_name: Option<String>,
    global_email: Option<String>,
) -> GitIdentity {
    let local = local_name.is_some() && local_email.is_some();
    let name = local_name.or(global_name);
    let email = local_email.or(global_email);
    let configured = name.is_some() && email.is_some();
    GitIdentity { name, email, configured, local }
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

/// JS: `commands.setGitIdentity(path, name, email)` -> `Promise<WriteResult>`
/// (never rejects; `ok:false` + message on failure). Writes ONLY this repo's
/// local config (never `--global`). Non-destructive metadata, no ref/history
/// touched, so — per the safety-model convention used by rerere_set_enabled —
/// this does NOT take a Safety Manager snapshot first.
///
/// BUG FIX: was a plain (non-async) `fn` — it opens the repo via `git2` and
/// then shells out to `git config --local` up to twice (name, email) via
/// `safety::run_git`, blocking on each subprocess. Left synchronous, that
/// wait ran inline on Tauri's MAIN thread, freezing the whole window for the
/// duration of every identity save from the setup wizard or Settings, not
/// just that one field. `async fn` + `run_blocking` moves it off that thread.
#[tauri::command]
#[specta::specta]
pub async fn set_git_identity(path: String, name: String, email: String) -> WriteResult {
    crate::blocking::run_blocking(move || {
        if let Err(e) = crate::trust::open_repo(&path) {
            return WriteResult {
                ok: false,
                message: format!("Cannot open repository: {}", e.message()),
                backup_ref: None,
                conflicting_files: Vec::new(),
            };
        }
        let name = name.trim();
        let email = email.trim();
        if name.is_empty() || email.is_empty() {
            return WriteResult {
                ok: false,
                message: "Name and email must not be empty.".to_string(),
                backup_ref: None,
                conflicting_files: Vec::new(),
            };
        }
        if let Err(msg) = write_local(&path, "user.name", name) {
            return WriteResult { ok: false, message: msg, backup_ref: None, conflicting_files: Vec::new() };
        }
        if let Err(msg) = write_local(&path, "user.email", email) {
            return WriteResult { ok: false, message: msg, backup_ref: None, conflicting_files: Vec::new() };
        }
        WriteResult {
            ok: true,
            message: format!("Set identity for this repository: {name} <{email}>."),
            backup_ref: None,
            conflicting_files: Vec::new(),
        }
    })
    .await
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

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    #[test]
    fn resolve_prefers_local_when_fully_set_regardless_of_global() {
        let id = resolve(s("Local Name"), s("local@x.com"), s("Global Name"), s("global@x.com"));
        assert_eq!(id.name.as_deref(), Some("Local Name"));
        assert_eq!(id.email.as_deref(), Some("local@x.com"));
        assert!(id.local);
        assert!(id.configured);
    }

    #[test]
    fn resolve_falls_back_to_global_when_local_is_entirely_unset() {
        let id = resolve(None, None, s("Global Name"), s("global@x.com"));
        assert_eq!(id.name.as_deref(), Some("Global Name"));
        assert_eq!(id.email.as_deref(), Some("global@x.com"));
        assert!(!id.local);
        assert!(id.configured);
    }

    #[test]
    fn resolve_mixes_local_and_global_independently_per_field() {
        // A repo that only overrides user.name locally still inherits
        // user.email from global — matches git's own real per-key layering,
        // not an atomic all-local-or-all-global choice.
        let id = resolve(s("Local Name"), None, s("Global Name"), s("global@x.com"));
        assert_eq!(id.name.as_deref(), Some("Local Name"));
        assert_eq!(id.email.as_deref(), Some("global@x.com"));
        assert!(!id.local, "only one of the two fields is local — not fully local");
        assert!(id.configured);
    }

    #[test]
    fn resolve_is_unconfigured_when_no_source_supplies_both_fields() {
        assert!(!resolve(None, None, None, None).configured);
        assert!(!resolve(s("Only Local Name"), None, None, None).configured);
        assert!(!resolve(None, None, s("Only Global Name"), None).configured);
    }

    #[test]
    fn resolve_name_from_local_plus_email_from_global_together_still_count_as_configured() {
        // The two fields come from DIFFERENT sources, but together they still
        // form a full identity — configured is about the EFFECTIVE result,
        // not about both fields sharing one source.
        let id = resolve(s("Local Name"), None, None, s("global@x.com"));
        assert!(id.configured);
        assert!(!id.local, "only one of the two fields is local — not fully local");
    }
}
