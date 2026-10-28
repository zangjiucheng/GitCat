//! Optional background `git maintenance` — opt-in repository housekeeping that
//! the frontend's IDLE timer triggers (see `main.ts`'s maintenance loop; gated by
//! the `autoMaintenanceEnabled` setting, default OFF).
//!
//! It runs `git maintenance run --auto`, git's own SAFE background upkeep: with
//! `--auto`, only the tasks whose thresholds are actually met run (commit-graph,
//! loose-objects, incremental-repack, gc, prefetch), so it's cheap when nothing
//! is due and never rewrites visible history or touches the working tree. Hence
//! it needs no Safety snapshot and has no user-facing surface of its own — it
//! just keeps the object database tidy so everyday reads (the graph walk,
//! status) stay fast. Best-effort by design: a failure (most often another git
//! process holding the repo lock) comes back as an `Err` for the caller to log,
//! never shown to the user.

use crate::blocking::run_blocking;
use crate::procutil::{run_with, CancelToken, RunOptions, LONG_OP_TIMEOUT};
use crate::wsl::WslTag;

/// Run `git maintenance run --auto` in `path`, off-thread. `Ok(())` on success;
/// `Err(git's stderr)` otherwise (the caller logs it and simply tries again on a
/// later idle tick). `--auto` keeps this safe to call on a timer — git decides
/// which tasks, if any, are due.
#[tauri::command]
#[specta::specta]
pub async fn run_git_maintenance(path: String) -> Result<(), String> {
    // FOLLOW-UP(jobs): register in JobRegistry and pass job.token(), so quitting
    // or a user cancel stops a long repack instead of waiting it out.
    run_blocking(move || maintenance_run(&path, None)).await
}

/// The [`RunOptions`] [`maintenance_run`] runs under: the long-op timeout. It
/// had none before, so one wedged `git maintenance` (a stuck gc, a dead
/// prefetch connection) pinned a blocking thread for the rest of the session.
/// Split out so the test checks the options the runner actually uses.
fn maintenance_options(cancel: Option<&CancelToken>, tag: Option<WslTag>) -> RunOptions<'static> {
    RunOptions { timeout: Some(LONG_OP_TIMEOUT), cancel: cancel.cloned(), wsl: tag, ..Default::default() }
}

fn maintenance_run(path: &str, cancel: Option<&CancelToken>) -> Result<(), String> {
    // An older git (or one whose version can't be read) has no `maintenance
    // run --auto`; skip quietly rather than fail on every idle tick.
    if !crate::git_version::repo_git_has(path, crate::git_version::GitVersion::has_maintenance) {
        return Ok(());
    }
    // Tagged, so a timeout or cancel also kills the git inside a WSL distro.
    let (cmd, tag) = crate::wsl::git_command_tagged(path, &["maintenance", "run", "--auto"], &[]);
    let out = run_with(cmd, maintenance_options(cancel, tag)).map_err(|e| format!("could not run git maintenance: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if msg.is_empty() { "git maintenance failed".to_string() } else { msg })
    }
}

#[cfg(test)]
mod tests {
    use super::{maintenance_options, maintenance_run, run_git_maintenance};
    use std::process::Command;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "gitcat-maintenance-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn run_git_maintenance_on_a_real_repo_succeeds() {
        // A fresh tiny repo has nothing due, so `--auto` does no work and still
        // exits 0 — that clean exit is the success we assert.
        let dir = tmp_dir("ok");
        let init = Command::new("git").arg("-C").arg(&dir).arg("init").output().expect("git init");
        assert!(init.status.success(), "git init failed: {}", String::from_utf8_lossy(&init.stderr));

        let res = tauri::async_runtime::block_on(run_git_maintenance(dir.to_string_lossy().into_owned()));
        assert!(res.is_ok(), "maintenance on a real repo should succeed, got {res:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn runs_under_a_timeout() {
        // It used to run with no bound at all; maintenance_run now takes its
        // options from maintenance_options, which carries the long-op timeout.
        assert_eq!(maintenance_options(None, None).timeout, Some(crate::procutil::LONG_OP_TIMEOUT));
    }

    #[test]
    fn pre_cancelled_token_stops_it_before_spawning() {
        // run_with checks the token before it spawns anything, so no repo is needed.
        let token = crate::procutil::CancelToken::new();
        token.cancel();
        let res = maintenance_run("/no/such/path/at/all", Some(&token));
        assert_eq!(res, Err("could not run git maintenance: cancelled".to_string()));
    }

    #[test]
    fn run_git_maintenance_on_a_non_repo_path_is_an_err_not_a_panic() {
        // A best-effort command must surface a bad path as a clean Err (the
        // frontend logs it and retries later), never panic.
        let res = tauri::async_runtime::block_on(run_git_maintenance("/no/such/path/at/all".to_string()));
        assert!(res.is_err(), "maintenance on a non-repo path should be an Err, got {res:?}");
    }
}
