//! Running-jobs registry: every cancellable long-running git op (the remote
//! ops in git_remote.rs, submodule update/add) registers here for its lifetime,
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

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
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
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    Fetch,
    Pull,
    Push,
    ForcePush,
    PushTag,
    PushBranch,
    ResetToUpstream,
    SubmoduleUpdate,
    SubmoduleAdd,
    Commit,
    Merge,
    CherryPick,
    Revert,
    Rebase,
    ApplyPatch,
    Mergetool,
}

impl JobKind {
    /// How long without git output before the job is reported stalled, or
    /// `None` for a local op that has no output to go quiet on.
    pub fn stall_after(self) -> Option<Duration> {
        match self {
            // Local: git prints little or nothing while it works (or while a
            // hook, gpg or a merge tool runs), so silence says nothing.
            JobKind::ResetToUpstream
            | JobKind::Commit
            | JobKind::Merge
            | JobKind::CherryPick
            | JobKind::Revert
            | JobKind::Rebase
            | JobKind::ApplyPatch
            | JobKind::Mergetool => None,
            _ => Some(NETWORK_STALL),
        }
    }
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
    /// The kind's stall threshold in seconds (`JobKind::stall_after`), 0 when
    /// it has none — so the UI never hard-codes it.
    pub stall_secs: u32,
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
            stall_secs: kind.stall_after().map_or(0, |d| d.as_secs() as u32),
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

    /// Fire every token. Each op's runner then tears its own tree down.
    pub fn cancel_all(&self) {
        let mut g = self.lock();
        for (info, token) in g.jobs.values_mut() {
            info.cancelling = true;
            token.cancel();
        }
    }

    /// [`cancel_all`](Self::cancel_all), then wait up to `timeout` for every
    /// job to leave the registry; `true` if they all did. For app exit: a
    /// Windows Job Object dies with GitCat anyway, but on Unix an in-flight git
    /// (and its ssh) would otherwise outlive the quit. Each job's runner kills
    /// its tree and then `Job::finish` removes it — removal happens before the
    /// "job-finished" emit, so this never waits on the (blocked) main thread.
    pub fn cancel_all_and_wait(&self, timeout: Duration) -> bool {
        self.cancel_all();
        let start = std::time::Instant::now();
        loop {
            if self.lock().jobs.is_empty() {
                return true;
            }
            if start.elapsed() >= timeout {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// The job the current thread is running, if any — so a deep helper (the one
/// that finally runs git) can pick up the cancel token without every layer in
/// between growing a parameter. Set by [`with_current`] for exactly the
/// duration of a command's body, which runs synchronously on one blocking
/// thread; outside a job (tests, untracked callers) it is `None` and the
/// helpers behave as before.
#[derive(Clone)]
pub struct CurrentJob {
    token: CancelToken,
    others_on_repo: Rc<dyn Fn() -> bool>,
}

impl CurrentJob {
    /// A current job that isn't in a registry — for tests, which drive a
    /// command's core with their own token through [`with_current`].
    pub fn new(token: CancelToken, others_on_repo: impl Fn() -> bool + 'static) -> Self {
        Self { token, others_on_repo: Rc::new(others_on_repo) }
    }

    pub fn token(&self) -> CancelToken {
        self.token.clone()
    }

    /// See `JobRegistry::others_on_repo`; asked when called.
    pub fn others_on_repo(&self) -> bool {
        (self.others_on_repo)()
    }
}

thread_local! {
    static CURRENT: RefCell<Option<CurrentJob>> = const { RefCell::new(None) };
}

/// The job this thread is running, if any.
pub fn current() -> Option<CurrentJob> {
    CURRENT.with(|c| c.borrow().clone())
}

/// Run `body` with `job` as this thread's current job, restoring whatever
/// was current before (also on panic).
pub fn with_current<R>(job: CurrentJob, body: impl FnOnce() -> R) -> R {
    struct Restore(Option<CurrentJob>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let prev = self.0.take();
            CURRENT.with(|c| *c.borrow_mut() = prev);
        }
    }
    let _restore = Restore(CURRENT.with(|c| c.borrow_mut().replace(job)));
    body()
}

/// Register a job around a command body that runs synchronously on this
/// (blocking) thread: begin, make it the current job for the body, finish
/// with the result's outcome. For ops whose cancel token is picked up deep
/// inside via [`current`] rather than passed down.
pub fn run_job<R: JobResult>(
    app: &AppHandle<Wry>,
    kind: JobKind,
    repo: &str,
    label: &str,
    body: impl FnOnce() -> R,
) -> R {
    let job = begin(app, kind, repo, label, true);
    let current = {
        let app = job.app.clone();
        let (id, repo) = (job.info.id, job.info.repo.clone());
        CurrentJob {
            token: job.token(),
            others_on_repo: Rc::new(move || app.state::<JobRegistry>().others_on_repo(id, &repo)),
        }
    };
    let res = with_current(current, body);
    job.finish(res.outcome());
    res
}

/// What a job's command returns, read for the `"job-finished"` outcome.
pub trait JobResult {
    fn outcome(&self) -> JobOutcome;
}

impl JobResult for crate::git_write::WriteResult {
    fn outcome(&self) -> JobOutcome {
        if self.cancelled {
            JobOutcome::Cancelled
        } else if self.ok {
            JobOutcome::Ok
        } else {
            JobOutcome::Failed
        }
    }
}

fn outcome_of(ok: bool, cancelled: bool) -> JobOutcome {
    if cancelled {
        JobOutcome::Cancelled
    } else if ok {
        JobOutcome::Ok
    } else {
        JobOutcome::Failed
    }
}

impl JobResult for crate::workdir::WorkdirResult {
    fn outcome(&self) -> JobOutcome {
        outcome_of(self.ok, self.cancelled)
    }
}

impl JobResult for crate::conflict::ResolveResult {
    fn outcome(&self) -> JobOutcome {
        outcome_of(self.ok, self.cancelled)
    }
}

/// The history ops report a cancel as `state: "cancelled"` (their results
/// already carry a state string the UI switches on).
macro_rules! state_job_result {
    ($($t:ty),*) => {$(
        impl JobResult for $t {
            fn outcome(&self) -> JobOutcome {
                outcome_of(self.ok, self.state == "cancelled")
            }
        }
    )*};
}
state_job_result!(
    crate::git_merge::MergeResult,
    crate::git_pick::PickResult,
    crate::git_revert::RevertResult,
    crate::git_rebase::RebaseResult,
    crate::patch::ApplyPatchResult
);

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
                    JobProgress { id: self.info.id, stalled, idle_secs: self.info.stall_secs },
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
    fn stall_secs_follow_the_kind() {
        let r = JobRegistry::default();
        assert_eq!(r.register(JobKind::Fetch, "/r", "", true).0.stall_secs, 60);
        assert_eq!(r.register(JobKind::SubmoduleUpdate, "/r", "", true).0.stall_secs, 60);
        assert_eq!(r.register(JobKind::ResetToUpstream, "/r", "main", true).0.stall_secs, 0, "a local op never stalls");
    }

    #[test]
    fn cancel_all_and_wait_returns_once_the_jobs_are_gone() {
        let r = std::sync::Arc::new(JobRegistry::default());
        let (info, token) = r.register(JobKind::Fetch, "/r", "", true);
        let worker = {
            let r = r.clone();
            std::thread::spawn(move || {
                while !token.is_cancelled() {
                    std::thread::sleep(Duration::from_millis(5));
                }
                std::thread::sleep(Duration::from_millis(50)); // tearing its tree down
                r.remove(info.id);
            })
        };
        assert!(r.cancel_all_and_wait(Duration::from_secs(5)));
        worker.join().unwrap();
        let (_, _stuck) = r.register(JobKind::Push, "/r", "main", true);
        assert!(!r.cancel_all_and_wait(Duration::from_millis(100)), "a job that never finishes times the wait out");
    }

    #[test]
    fn current_is_set_only_inside_with_current_and_restored_after() {
        assert!(current().is_none());
        let token = CancelToken::new();
        let job = CurrentJob { token: token.clone(), others_on_repo: Rc::new(|| true) };
        let seen = with_current(job, || {
            let c = current().expect("set inside");
            token.cancel();
            (c.token().is_cancelled(), c.others_on_repo())
        });
        assert_eq!(seen, (true, true));
        assert!(current().is_none(), "restored after");
        let r = std::panic::catch_unwind(|| {
            with_current(CurrentJob { token: CancelToken::new(), others_on_repo: Rc::new(|| false) }, || panic!("boom"))
        });
        assert!(r.is_err());
        assert!(current().is_none(), "restored after a panic too");
    }

    #[test]
    fn current_is_per_thread() {
        let job = CurrentJob { token: CancelToken::new(), others_on_repo: Rc::new(|| false) };
        with_current(job, || {
            assert!(std::thread::spawn(|| current().is_none()).join().unwrap());
        });
    }

    #[test]
    fn kinds_serialize_snake_case() {
        assert_eq!(serde_json::to_string(&JobKind::ForcePush).unwrap(), "\"force_push\"");
        assert_eq!(serde_json::to_string(&JobKind::Fetch).unwrap(), "\"fetch\"");
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
