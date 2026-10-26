//! Running-jobs registry: every cancellable long-running git op (today the
//! fetch/pull/push family in git_remote.rs) registers here for its lifetime,
//! so the frontend can list what is running and cancel any of it (#133).
//!
//! A job is a `(JobInfo, CancelToken)` pair. Cancelling only flips the token;
//! the op's own `procutil::run_with` poll loop sees it and kills the whole
//! process tree on the thread that owns the `Child` (see `CancelToken`'s doc
//! for why the kill never happens here). So `job_cancel` is a trivial sync
//! command, exactly like `git_bisect::bisect_run_cancel`, and can never block.
//!
//! Lifecycle events, all through `event_util::emit_on_main`:
//!   - `"job-started"`  (`JobInfo`)     — on `begin`
//!   - `"job-progress"` (`JobProgress`) — when the op becomes stalled (no git
//!     output for `NETWORK_STALL`) or resumes; stall only INFORMS, nothing is
//!     ever killed automatically
//!   - `"job-finished"` (`JobFinished`) — on `Job::finish`, or on drop if the
//!     op panicked before finishing
//!
//! Each GitCat window is its own process with its own registry, so ids only
//! need to be unique per process.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, State, Wry};

use crate::procutil::CancelToken;

pub type JobId = u64;

/// No git output for this long and a network job is reported as stalled.
/// Well above a cold WSL VM start (a few silent seconds), well below "the user
/// has given up and force-quit".
pub const NETWORK_STALL: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    Fetch,
    Pull,
    Push,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum JobOutcome {
    Ok,
    Failed,
    Cancelled,
}

/// One registered job, as `jobs_list` returns it and `"job-started"` carries it.
#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JobInfo {
    pub id: JobId,
    pub kind: JobKind,
    pub repo: String,
    /// Machine detail — the remote name for a named fetch, the branch for a
    /// push, otherwise empty. The UI localizes the kind itself.
    pub label: String,
    /// Unix epoch milliseconds.
    pub started_at_ms: u64,
    /// True for the silent fetch/pull/push (auto-fetch timer, resolver flows),
    /// false for the user-initiated streaming ops the progress modal shows.
    pub background: bool,
    pub stalled: bool,
    pub cancelling: bool,
}

/// Emitted as `"job-progress"` when a job's stalled flag flips.
#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub id: JobId,
    pub stalled: bool,
    /// The stall threshold at the moment of the transition — this event fires
    /// only on change, so it is not a live counter.
    pub idle_secs: u32,
}

/// Emitted as `"job-finished"` once a job leaves the registry.
#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JobFinished {
    pub id: JobId,
    pub outcome: JobOutcome,
}

struct Inner {
    next: JobId,
    jobs: BTreeMap<JobId, (JobInfo, CancelToken)>,
}

impl Default for Inner {
    fn default() -> Self {
        Self { next: 1, jobs: BTreeMap::new() }
    }
}

/// `app.manage()`d once in lib.rs. Every method takes the lock briefly and
/// never does I/O under it.
#[derive(Default)]
pub struct JobRegistry {
    inner: Mutex<Inner>,
}

impl JobRegistry {
    // A poisoned lock only means some other thread panicked mid-update of a
    // plain map; the map itself is still consistent, so keep going rather
    // than wedge every later cancel.
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn register(&self, kind: JobKind, repo: &str, label: &str, background: bool) -> (JobInfo, CancelToken) {
        let mut g = self.lock();
        let id = g.next;
        g.next += 1;
        let started_at_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let info = JobInfo {
            id,
            kind,
            repo: repo.to_string(),
            label: label.to_string(),
            started_at_ms,
            background,
            stalled: false,
            cancelling: false,
        };
        let token = CancelToken::new();
        g.jobs.insert(id, (info.clone(), token.clone()));
        (info, token)
    }

    /// Ascending id (a `BTreeMap` iterates in key order).
    pub fn list(&self) -> Vec<JobInfo> {
        self.lock().jobs.values().map(|(i, _)| i.clone()).collect()
    }

    /// Flag the job as cancelling and fire its token. `false` if the id is
    /// unknown — it already finished, which is a benign race, not an error.
    pub fn cancel(&self, id: JobId) -> bool {
        let mut g = self.lock();
        match g.jobs.get_mut(&id) {
            Some((info, token)) => {
                info.cancelling = true;
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// `true` iff the flag actually changed (so the caller emits only then).
    pub fn set_stalled(&self, id: JobId, stalled: bool) -> bool {
        let mut g = self.lock();
        match g.jobs.get_mut(&id) {
            Some((info, _)) if info.stalled != stalled => {
                info.stalled = stalled;
                true
            }
            _ => false,
        }
    }

    pub fn remove(&self, id: JobId) -> Option<JobInfo> {
        self.lock().jobs.remove(&id).map(|(i, _)| i)
    }

    /// Is another live job registered on the same repo? The lock-cleanup guard:
    /// a cancelled op never deletes a lock while something else of ours may
    /// legitimately hold it (auto-fetch is not gated by the topbar's busy flag).
    pub fn others_on_repo(&self, id: JobId, repo: &str) -> bool {
        self.lock().jobs.iter().any(|(&other, (info, _))| other != id && info.repo == repo)
    }

    /// Fire every token. Called on app exit; each op's runner then tears its
    /// own tree down.
    pub fn cancel_all(&self) {
        let mut g = self.lock();
        for (info, token) in g.jobs.values_mut() {
            info.cancelling = true;
            token.cancel();
        }
    }
}

/// RAII handle for one registered job: `begin` registers it and emits
/// `"job-started"`; `finish` (or, on a panic path, drop) removes it and emits
/// `"job-finished"`. Must be created on a blocking thread (inside
/// `run_blocking`), the same place `bisect_run_start` looks up its state.
pub struct Job {
    app: AppHandle<Wry>,
    info: JobInfo,
    cancel: CancelToken,
    finished: bool,
}

pub fn begin(app: &AppHandle<Wry>, kind: JobKind, repo: &str, label: &str, background: bool) -> Job {
    let (info, cancel) = app.state::<JobRegistry>().register(kind, repo, label, background);
    crate::event_util::emit_on_main(app, "job-started", info.clone());
    Job { app: app.clone(), info, cancel, finished: false }
}

impl Job {
    pub fn id(&self) -> JobId {
        self.info.id
    }

    pub fn token(&self) -> CancelToken {
        self.cancel.clone()
    }

    /// Is another live job registered on this job's repo? See
    /// `JobRegistry::others_on_repo`; evaluated when called, so a cancel path
    /// asks at cancel time, not at start.
    pub fn others_on_repo(&self) -> bool {
        self.app.state::<JobRegistry>().others_on_repo(self.info.id, &self.info.repo)
    }

    /// The `procutil::StallHook::on_change` for this job: records the flag and
    /// emits `"job-progress"` when it changed. Bind it to a local before taking
    /// `&mut` of it.
    pub fn stall_sink(&self) -> impl FnMut(bool) + '_ {
        move |stalled| {
            if self.app.state::<JobRegistry>().set_stalled(self.info.id, stalled) {
                crate::event_util::emit_on_main(
                    &self.app,
                    "job-progress",
                    JobProgress { id: self.info.id, stalled, idle_secs: NETWORK_STALL.as_secs() as u32 },
                );
            }
        }
    }

    pub fn finish(mut self, outcome: JobOutcome) {
        self.end(outcome);
    }

    fn end(&mut self, outcome: JobOutcome) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.app.state::<JobRegistry>().remove(self.info.id);
        crate::event_util::emit_on_main(&self.app, "job-finished", JobFinished { id: self.info.id, outcome });
    }
}

impl Drop for Job {
    // Only reached without `finish` when the op panicked — never leave a ghost
    // row in the registry or a spinner in the UI.
    fn drop(&mut self) {
        self.end(JobOutcome::Failed);
    }
}

/// Every running job in this window, ascending by id.
/// JS: invoke("jobs_list").
#[tauri::command]
#[specta::specta]
pub fn jobs_list(state: State<'_, JobRegistry>) -> Vec<JobInfo> {
    state.list()
}

/// Ask a running job to stop. `false` means it was already gone (it finished
/// between the user's click and this call) — benign, its own result is on the
/// way. Plain sync fn: it only flips a flag, like `bisect_run_cancel`.
/// JS: invoke("job_cancel", { id }).
#[tauri::command]
#[specta::specta]
pub fn job_cancel(state: State<'_, JobRegistry>, id: JobId) -> bool {
    state.cancel(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_monotonic_and_list_is_sorted() {
        let r = JobRegistry::default();
        let (a, _) = r.register(JobKind::Fetch, "/r", "", true);
        let (b, _) = r.register(JobKind::Pull, "/r", "", false);
        let (c, _) = r.register(JobKind::Push, "/s", "main", false);
        assert_eq!((a.id, b.id, c.id), (1, 2, 3));
        r.remove(b.id);
        let (d, _) = r.register(JobKind::Fetch, "/r", "origin", false);
        assert_eq!(d.id, 4, "ids are never reused");
        let ids: Vec<JobId> = r.list().iter().map(|j| j.id).collect();
        assert_eq!(ids, vec![1, 3, 4]);
    }

    #[test]
    fn cancel_sets_flag_and_cancelling() {
        let r = JobRegistry::default();
        let (info, token) = r.register(JobKind::Fetch, "/r", "", false);
        assert!(!token.is_cancelled());
        assert!(r.cancel(info.id));
        assert!(token.is_cancelled());
        assert!(r.list()[0].cancelling);
    }

    #[test]
    fn cancel_unknown_id_is_false() {
        let r = JobRegistry::default();
        assert!(!r.cancel(42));
    }

    #[test]
    fn set_stalled_reports_change_only() {
        let r = JobRegistry::default();
        let (info, _) = r.register(JobKind::Fetch, "/r", "", false);
        assert!(r.set_stalled(info.id, true));
        assert!(!r.set_stalled(info.id, true), "same value is not a change");
        assert!(r.list()[0].stalled);
        assert!(r.set_stalled(info.id, false));
        assert!(!r.set_stalled(99, true), "unknown id");
    }

    #[test]
    fn remove_then_cancel_is_false() {
        let r = JobRegistry::default();
        let (info, token) = r.register(JobKind::Push, "/r", "main", false);
        assert_eq!(r.remove(info.id).map(|i| i.id), Some(info.id));
        assert!(!r.cancel(info.id));
        assert!(!token.is_cancelled(), "a removed job's token is left alone");
        assert!(r.remove(info.id).is_none());
    }

    #[test]
    fn cancel_all_cancels_every_token() {
        let r = JobRegistry::default();
        let tokens: Vec<CancelToken> = (0..3).map(|_| r.register(JobKind::Fetch, "/r", "", true).1).collect();
        r.cancel_all();
        assert!(tokens.iter().all(CancelToken::is_cancelled));
        assert!(r.list().iter().all(|j| j.cancelling));
    }

    #[test]
    fn others_on_repo_ignores_self_and_other_repos() {
        let r = JobRegistry::default();
        let (a, _) = r.register(JobKind::Pull, "/r", "", false);
        assert!(!r.others_on_repo(a.id, "/r"), "itself does not count");
        let (b, _) = r.register(JobKind::Fetch, "/elsewhere", "", true);
        assert!(!r.others_on_repo(a.id, "/r"), "another repo does not count");
        let (c, _) = r.register(JobKind::Fetch, "/r", "", true);
        assert!(r.others_on_repo(a.id, "/r"));
        r.remove(c.id);
        assert!(!r.others_on_repo(a.id, "/r"));
        let _ = b;
    }
}
