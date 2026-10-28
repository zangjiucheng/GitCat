//! Shared `std::process::Command` helpers, used across every module that
//! shells out to `git`/`wsl.exe`:
//!
//!   - `NoConsoleWindowExt` suppresses the console window Windows otherwise
//!     flashes open for every subprocess a GUI app spawns (`git`, `wsl.exe`,
//!     `cmd`/`sh` for a bisect test-command, ...). GitCat has no attached
//!     console of its own (it's a windowed GUI app), so without this,
//!     Windows creates a brand-new one for each spawned child and tears it
//!     down when the child exits — visible as a black window flashing open
//!     and closing, worse the more subprocesses run in a short span (e.g.
//!     the periodic auto-fetch timer, or a rebase replaying many commits
//!     each via their own `git` invocation). A no-op on every other
//!     platform: this is a Windows-only annoyance (Unix shells don't spawn a
//!     NEW terminal window per child process the way Windows' console
//!     subsystem does).
//!
//!   - [`run_with`] is the one process runner everything else is built on: an
//!     optional hard timeout, an optional [`CancelToken`], live stdout/stderr
//!     line callbacks, and a stall hook (no output for N seconds). Whatever
//!     ends a run early — timeout or cancel — kills the WHOLE process tree,
//!     not just the direct child: `git fetch` alone spawns `git-remote-https`
//!     or `ssh`, plus any hooks, and killing only the leader used to leave
//!     those running (and holding our stdout pipe open, so the reader join
//!     hung right after the "kill"). The tree is a Job Object on Windows and
//!     a fresh process group on Unix (see `KillTree`); a WSL-routed git is
//!     additionally killed INSIDE the distro by its `GITCAT_OP` tag (see
//!     `wsl::kill_tagged`), since killing `wsl.exe` does not reliably take
//!     the Linux-side git down with it.
//!
//!   - `output_with_timeout` / `output_with_timeout_stdin` are the original
//!     timeout-only entry points, now thin wrappers over `run_with` that keep
//!     their exact `io::Error` contract — see their own doc comments.
//!
//!   - [`git_timeout`] is the central policy for how long a git subcommand may
//!     run: network ops get NO hard timeout (a big clone is legitimately slow;
//!     they get stall detection instead, which only informs and never kills),
//!     local ops a generous one.

use std::io::Read;
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::i18n_err::{ierr, ierrp};

/// Shared default for `output_with_timeout` callers that don't have a more
/// specific reason to pick their own value — generous enough to cover a
/// cold WSL2 VM spin-up (the slowest LEGITIMATE case any of this app's git
/// subprocess calls sees; an already-warm `wsl.exe` interop launch is
/// sub-second) while still turning a genuine hang into a bounded,
/// user-visible failure within a reasonable wait.
pub const SUBPROCESS_TIMEOUT: Duration = Duration::from_secs(20);

/// Local ops that can legitimately sit waiting on something outside git:
/// commit/merge/rebase/am/stash/checkout/`tag -s` run hooks and may wait on a
/// gpg pinentry. Still bounded, so a wedged hook is a failure, not a hang.
pub const LOCAL_OP_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Read-only scans whose cost grows with history size: grep/log/rev-list/
/// format-patch/blame over a large monorepo.
pub const READ_SCAN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Whole-repo rewrites and maintenance: filter-repo/gc/maintenance/fsck/
/// bundle/repack. Hours on a huge repo are real; this only catches "never".
pub const LONG_OP_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);

/// How long a cancel waits after the soft stop (SIGTERM on Unix, the in-distro
/// TERM for WSL) before the hard kill. git's own sigchain removes the `.lock`
/// files it holds on SIGTERM, which is the whole reason for a soft step.
pub const CANCEL_GRACE: Duration = Duration::from_secs(2);

/// First gap between `try_wait()` polls in [`run_with`], doubled after each
/// miss up to [`POLL_MAX`].
///
/// The loop used to sleep a flat 30 ms, which is a cost paid IN FULL by every
/// short child: the first poll essentially never finds a freshly spawned
/// process already exited, so the caller waits out a whole quantum to notice a
/// `git config` that finished in 8 ms. Measured by counting polls rather than
/// wall clock (a busy machine moves wall clock and not this): the flat loop
/// took exactly 2.0 polls and 30.00 ms of sleep per spawn — not on average, on
/// every single one.
///
/// 250 µs is below the cost of the spawn itself, so a genuinely fast child is
/// noticed almost immediately, and the doubling means a slow one costs at most
/// a handful of extra wakeups before the gap is back to the old quantum.
const POLL_FIRST: Duration = Duration::from_micros(250);

/// Ceiling on the backoff, deliberately equal to the flat sleep it replaced.
///
/// This is what keeps the timeout contract identical rather than merely
/// similar: a hung child is still noticed within one 30 ms quantum of the
/// deadline, exactly as before, so `SUBPROCESS_TIMEOUT` and every caller's own
/// timeout keep the precision they were written against. The backoff only ever
/// makes the EARLY polls closer together. It is also the upper bound on how
/// long a [`CancelToken::cancel`] takes to be noticed.
const POLL_MAX: Duration = Duration::from_millis(30);

/// The next gap after a miss. Pulled out of the loop so the schedule can be
/// asserted without a clock — see this module's own tests, which walk it over
/// every child duration rather than timing one.
fn next_nap(nap: Duration) -> Duration {
    (nap * 2).min(POLL_MAX)
}

pub trait NoConsoleWindowExt {
    /// Suppress the console window this child would otherwise flash open on
    /// Windows. Does nothing on any other platform. Chain right after
    /// `Command::new(...)`, same as any other builder method.
    fn no_console_window(&mut self) -> &mut Self;
}

impl NoConsoleWindowExt for Command {
    #[cfg(windows)]
    fn no_console_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (0x08000000) — documented Win32 process creation
        // flag: https://learn.microsoft.com/windows/win32/procthread/process-creation-flags
        //
        // `creation_flags` OVERWRITES any flags set before rather than ORing
        // into them. `run_with`'s `KillTree::prepare` sets the flags again
        // (CREATE_NO_WINDOW, plus CREATE_SUSPENDED when the run is
        // cancellable), so a command that goes through `run_with` ends up with
        // whatever `prepare` chose — still no console, which is all this ever
        // set.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        self.creation_flags(CREATE_NO_WINDOW)
    }

    #[cfg(not(windows))]
    fn no_console_window(&mut self) -> &mut Self {
        self
    }
}

/// Cheap, clonable, one-shot. `cancel()` only sets the flag; the runner's poll
/// loop (<= POLL_MAX) observes it and kills the tree on ITS OWN thread, which
/// owns the Child, so a kill never races the leader's reap.
#[derive(Clone, Default, Debug)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// A per-line callback for [`RunOptions::on_stdout_line`] /
/// [`RunOptions::on_stderr_line`]. `Send` because it runs on that stream's
/// reader thread, not the caller's.
pub type LineSink<'a> = &'a mut (dyn FnMut(&str) + Send);

pub struct StallHook<'a> {
    /// No stdout/stderr bytes for this long => stalled.
    pub after: Duration,
    /// `true` on becoming stalled, `false` when output resumes; called on the
    /// runner thread (the one that called `run_with`).
    pub on_change: &'a mut dyn FnMut(bool),
}

#[derive(Default)]
pub struct RunOptions<'a> {
    /// `None` => `Stdio::null()`. `Some` => piped, written by a detached
    /// thread, then closed so the child sees EOF.
    pub stdin: Option<Vec<u8>>,
    /// `None` => no hard timeout.
    pub timeout: Option<Duration>,
    pub cancel: Option<CancelToken>,
    /// Split on `\n`, trailing `\r` trimmed.
    pub on_stdout_line: Option<LineSink<'a>>,
    /// Split on `\r` AND `\n` via [`feed_progress`] (git's progress meter).
    pub on_stderr_line: Option<LineSink<'a>>,
    pub stall: Option<StallHook<'a>>,
    /// Set when the command came from `wsl::git_command_tagged`.
    pub wsl: Option<crate::wsl::WslTag>,
    /// stdout/stderr = `Stdio::null()`, no readers, `Output` has empty vecs.
    /// The sinks and `stall` must be `None` (nothing would ever feed them).
    pub discard_output: bool,
}

#[derive(Debug)]
pub enum RunError {
    TimedOut(Duration),
    Cancelled,
    Io(std::io::Error),
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunError::TimedOut(d) => write!(f, "timed out after {d:?}"),
            RunError::Cancelled => f.write_str("cancelled"),
            RunError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for RunError {}

impl From<std::io::Error> for RunError {
    fn from(e: std::io::Error) -> Self {
        RunError::Io(e)
    }
}

impl RunError {
    /// Byte-identical to what output_with_timeout returned before:
    /// TimedOut -> io::Error(ErrorKind::TimedOut, "timed out after {d:?}");
    /// Cancelled -> ErrorKind::Interrupted "cancelled"; Io(e) -> e.
    pub fn into_io(self) -> std::io::Error {
        match self {
            RunError::TimedOut(d) => std::io::Error::new(std::io::ErrorKind::TimedOut, format!("timed out after {d:?}")),
            RunError::Cancelled => std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled"),
            RunError::Io(e) => e,
        }
    }

    /// Io(e) -> ierrp(io_key, [("detail", e)]);
    /// TimedOut(d) -> ierrp("err_misc.git_timed_out", [("secs", d.as_secs())]);
    /// Cancelled -> ierr("err_misc.cancelled").
    pub fn to_ierr(&self, io_key: &str) -> String {
        match self {
            RunError::Io(e) => ierrp(io_key, &[("detail", &e.to_string())]),
            RunError::TimedOut(d) => ierrp("err_misc.git_timed_out", &[("secs", &d.as_secs().to_string())]),
            RunError::Cancelled => ierr("err_misc.cancelled"),
        }
    }

    pub fn is_cancelled(&self) -> bool {
        matches!(self, RunError::Cancelled)
    }
}

/// Whether a runner's `Err(String)` (made by [`RunError::to_ierr`]) is a
/// cancel rather than a failure: `to_ierr` turns `Cancelled` into this exact
/// key whatever the caller's own io key is.
pub fn is_cancelled_ierr(err: &str) -> bool {
    err == ierr("err_misc.cancelled")
}

/// Run `cmd` to completion and collect its output. stdout/stderr are piped and
/// fully collected into `Output` unless `discard_output` (the line callbacks
/// are additive — they see the same bytes the buffers get).
///
/// Polls `try_wait()` on a geometric backoff ([`POLL_FIRST`] doubling to
/// [`POLL_MAX`]) rather than a bare blocking `.wait()`, so the timeout, the
/// cancel flag and the stall hook are all enforceable without taxing every
/// short child a fixed quantum — see [`POLL_FIRST`] for what the flat version
/// cost. stdout/stderr are drained on separate threads CONCURRENTLY with that
/// poll loop (not just read after the child exits, the way a naive
/// `child.wait_with_output()` would) — a `git status` against a large repo
/// with many untracked files can produce more output than one OS pipe buffer
/// holds, and a child blocked writing to a full pipe nobody's draining would
/// itself look identical to "hung" and get killed spuriously by the very
/// timeout meant to catch a REAL hang.
///
/// Per poll, in this order: a natural exit (checked first, so it beats a
/// cancel arriving in the same quantum), the stall hook, the timeout, the
/// cancel flag.
///
/// - Timeout: hard-kill the tree (plus a detached in-distro KILL sweep for a
///   WSL run), reap, `Err(TimedOut)`.
/// - Cancel: soft stop (Unix SIGTERM to the group / WSL in-distro TERM; plain
///   Windows has no soft stop and goes straight to the hard kill), wait up to
///   [`CANCEL_GRACE`] for the output pipes to close, then the in-distro KILL
///   sweep (synchronous, so nothing of ours is still running when this
///   returns — lock cleanup after a cancel relies on that), then the hard
///   tree kill, reap, `Err(Cancelled)`.
///
/// Neither path calls `try_wait`/`wait` before its final kill, so on Unix the
/// group leader is never reaped while we may still `killpg` its pgid (see
/// `KillTree`).
///
/// Known limit, the same as before this runner existed: a descendant that
/// escaped the tree and still holds our stdout/stderr pipe keeps the reader
/// threads — and so this call — from returning until it closes the pipe. On a
/// NORMAL exit that is any daemon (e.g. fsmonitor) or escapee, on every
/// platform. On Unix it also applies to timeout and cancel: `killpg` reaches
/// only the process group, so a descendant that called `setsid`/`setpgid`
/// (ssh and `git-remote-*` may) survives it and blocks the return. The Windows
/// Job Object (membership can't be left without BREAKAWAY_OK) and the WSL
/// `GITCAT_OP` sweep (matched by inherited env, whatever the group) don't have
/// that gap.
pub fn run_with(mut cmd: Command, opts: RunOptions<'_>) -> Result<Output, RunError> {
    let RunOptions { stdin, timeout, cancel, on_stdout_line, on_stderr_line, stall, wsl, discard_output } = opts;
    debug_assert!(
        !discard_output || (on_stdout_line.is_none() && on_stderr_line.is_none() && stall.is_none()),
        "discard_output has no readers to feed a line sink or a stall hook"
    );
    if cancel.as_ref().is_some_and(CancelToken::is_cancelled) {
        return Err(RunError::Cancelled);
    }

    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    if discard_output {
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
    } else {
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    }
    let suspended = cancel.is_some() || wsl.is_some();
    KillTree::prepare(&mut cmd, suspended);
    let mut child: Child = cmd.spawn()?;
    let tree = KillTree::attach(&mut child, suspended)?;

    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        std::thread::spawn(move || {
            use std::io::Write;
            // A write error (the child exited / closed stdin early) is not ours
            // to report: the child's own exit status and stderr say what went wrong.
            let _ = pipe.write_all(&input);
            // `pipe` drops here, closing stdin so the child sees EOF.
        });
    }
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let start = Instant::now();
    // Milliseconds since `start` of the last stdout/stderr byte, shared with
    // the readers; the stall hook measures idleness against it.
    let last_activity_ms = AtomicU64::new(0);
    let readers_done = AtomicUsize::new(0);

    std::thread::scope(|s| {
        let stdout_reader = stdout_pipe.map(|pipe| {
            let (last, done) = (&last_activity_ms, &readers_done);
            s.spawn(move || pump(pipe, on_stdout_line, false, start, last, done))
        });
        let stderr_reader = stderr_pipe.map(|pipe| {
            let (last, done) = (&last_activity_ms, &readers_done);
            s.spawn(move || pump(pipe, on_stderr_line, true, start, last, done))
        });
        let join = |h: Option<std::thread::ScopedJoinHandle<'_, Vec<u8>>>| h.and_then(|h| h.join().ok()).unwrap_or_default();

        let mut stall = stall;
        let mut stalled = false;
        let mut nap = POLL_FIRST;
        let ended: Result<ExitStatus, RunError> = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => {}
                Err(e) => {
                    // Can't tell whether it is still running: take the tree
                    // down so the readers can finish, and report the error.
                    hard_kill(&mut child, tree.as_ref(), wsl.as_ref(), true);
                    let _ = child.wait();
                    break Err(RunError::Io(e));
                }
            }
            if let Some(hook) = stall.as_mut() {
                let now_ms = start.elapsed().as_millis() as u64;
                let idle = Duration::from_millis(now_ms.saturating_sub(last_activity_ms.load(Ordering::SeqCst)));
                if !stalled && idle >= hook.after {
                    stalled = true;
                    (hook.on_change)(true);
                } else if stalled && idle < hook.after {
                    stalled = false;
                    (hook.on_change)(false);
                }
            }
            if let Some(t) = timeout {
                if start.elapsed() >= t {
                    // Leader unreaped. The in-distro sweep runs detached: a
                    // timeout has no lock-cleanup step waiting on it.
                    hard_kill(&mut child, tree.as_ref(), wsl.as_ref(), true);
                    let _ = child.wait();
                    break Err(RunError::TimedOut(t));
                }
            }
            if cancel.as_ref().is_some_and(CancelToken::is_cancelled) {
                cancel_tree(&mut child, tree.as_ref(), wsl.as_ref(), discard_output, &readers_done);
                let _ = child.wait();
                break Err(RunError::Cancelled);
            }
            // Sleep no longer than what is left of the timeout, so the deadline
            // above is still checked within a quantum of expiring rather than
            // overshooting it by a full nap on the last iteration.
            let left = timeout.map_or(nap, |t| t.saturating_sub(start.elapsed()));
            std::thread::sleep(nap.min(left));
            nap = next_nap(nap);
        };

        match ended {
            Ok(status) => {
                if let Some(tree) = tree {
                    tree.release();
                }
                let stdout = join(stdout_reader);
                let stderr = join(stderr_reader);
                Ok(Output { status, stdout, stderr })
            }
            Err(e) => {
                // The tree is dead, so both pipes are closed and these return —
                // except, on Unix, when a descendant left our process group
                // still holding a pipe (the known limit in the doc above).
                join(stdout_reader);
                join(stderr_reader);
                Err(e)
            }
        }
    })
}

/// One reader thread's whole life: drain `pipe` into a buffer, feeding `sink`
/// line by line, stamping `last` on every chunk, and counting itself into
/// `done` at EOF (the cancel path's "pipes are closed" signal).
fn pump(mut pipe: impl Read, mut sink: Option<LineSink<'_>>, progress: bool, start: Instant, last: &AtomicU64, done: &AtomicUsize) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut seg = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                last.store(start.elapsed().as_millis() as u64, Ordering::SeqCst);
                buf.extend_from_slice(&chunk[..n]);
                if let Some(sink) = sink.as_mut() {
                    if progress {
                        feed_progress(&chunk[..n], &mut seg, &mut **sink);
                    } else {
                        feed_lines(&chunk[..n], &mut seg, &mut **sink);
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    if let Some(sink) = sink.as_mut() {
        if !seg.is_empty() {
            let text = String::from_utf8_lossy(&seg);
            sink(if progress { text.trim_end() } else { text.trim_end_matches('\r') });
        }
    }
    done.fetch_add(1, Ordering::SeqCst);
    buf
}

/// stdout's segmenter: `\n`-terminated lines with a trailing `\r` trimmed (so
/// a CRLF-emitting Windows tool reads the same as LF). Empty lines are kept —
/// unlike progress output, a blank stdout line can be meaningful.
fn feed_lines(chunk: &[u8], seg: &mut Vec<u8>, on_line: &mut dyn FnMut(&str)) {
    for &b in chunk {
        if b == b'\n' {
            on_line(String::from_utf8_lossy(seg).trim_end_matches('\r'));
            seg.clear();
        } else {
            seg.push(b);
        }
    }
}

/// Feed one chunk of raw progress bytes through the segmenter, invoking
/// `on_line` once per completed segment. git rewrites its current progress line
/// with a bare `\r` (carriage return) between updates and only ends a phase with
/// `\n`, so a `\n`-only reader would see nothing until the whole op finished —
/// we split on BOTH. `seg` carries the partial trailing segment across chunk
/// boundaries; because a completed segment is UTF-8-decoded only once it's whole,
/// a multi-byte char split across two reads is handled correctly. Pure + no I/O,
/// so it's unit-tested directly (see tests below). The caller flushes a final
/// non-empty `seg` itself once the stream ends.
pub fn feed_progress(chunk: &[u8], seg: &mut Vec<u8>, on_line: &mut dyn FnMut(&str)) {
    for &b in chunk {
        if b == b'\r' || b == b'\n' {
            if !seg.is_empty() {
                on_line(String::from_utf8_lossy(seg).trim_end());
                seg.clear();
            }
        } else {
            seg.push(b);
        }
    }
}

/// The hard stop: the whole tree if we have one, else just the leader. For a
/// WSL run, the in-distro KILL sweep too — detached when nobody waits on its
/// result (timeout), inline when the caller needs everything dead on return
/// (cancel). Never reaps the leader.
fn hard_kill(child: &mut Child, tree: Option<&KillTree>, wsl: Option<&crate::wsl::WslTag>, detach_wsl_sweep: bool) {
    if let Some(tag) = wsl {
        if detach_wsl_sweep {
            let tag = tag.clone();
            std::thread::spawn(move || crate::wsl::kill_tagged(&tag, crate::wsl::WslSignal::Kill));
        } else {
            crate::wsl::kill_tagged(tag, crate::wsl::WslSignal::Kill);
        }
    }
    match tree {
        Some(tree) => tree.kill(),
        None => {
            let _ = child.kill();
        }
    }
}

/// The cancel sequence up to (not including) the reap — see `run_with`'s doc.
fn cancel_tree(child: &mut Child, tree: Option<&KillTree>, wsl: Option<&crate::wsl::WslTag>, discard_output: bool, readers_done: &AtomicUsize) {
    let soft = match (wsl, tree) {
        (Some(tag), _) => {
            crate::wsl::kill_tagged(tag, crate::wsl::WslSignal::Term);
            true
        }
        (None, Some(tree)) => tree.terminate(),
        (None, None) => false,
    };
    if soft {
        // Wait for the pipes to close (every process holding them is gone) or
        // the grace to run out — WITHOUT `try_wait`, which would reap the
        // leader and free its pgid while we may still `killpg` it below. With
        // `discard_output` there are no pipes to watch, so the grace runs out
        // in full: a few seconds' delay on a cancel beats skipping the soft
        // stop that lets a process clean up after itself.
        let grace = Instant::now();
        let mut nap = POLL_FIRST;
        while grace.elapsed() < CANCEL_GRACE && (discard_output || readers_done.load(Ordering::SeqCst) < 2) {
            std::thread::sleep(nap.min(CANCEL_GRACE.saturating_sub(grace.elapsed())));
            nap = next_nap(nap);
        }
    }
    hard_kill(child, tree, wsl, false);
}

/// The process tree a run's leader heads, killable as one unit.
///
/// Windows: a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Children
/// inherit job membership, so `git-remote-https`/`ssh`/hooks are inside it, and
/// `TerminateJobObject` takes them all. The handle is ours, so unlike a pid it
/// can never point at a reused process. A cancellable run (or a WSL one) is
/// spawned `CREATE_SUSPENDED`, assigned, then resumed, so not even its first
/// instruction runs outside the job. Every other run is assigned right after a
/// normal spawn: that leaves a spawn-to-assign window of microseconds against
/// the child's own loader start-up, in which a grandchild could in principle
/// be born outside the job. Those runs carry no cancel, the only cost is an
/// incomplete tree kill on a timeout, and a Toolhelp snapshot per spawn to
/// close the window isn't worth paying on every `git config`.
///
/// Unix: the child leads a fresh session (`setsid`, so it also has no
/// controlling terminal to be job-control-stopped on — see `prepare`) and so a
/// fresh process group, which its descendants inherit, and `killpg` signals
/// them all. A descendant that `setsid`/`setpgid`s itself out of the group is
/// not reached (see the known limit on [`run_with`]). Invariant: `killpg` is
/// only ever called while the leader is unreaped — alive or a zombie — so its
/// pgid can't have been reused; `run_with` never calls `try_wait`/`wait` on the
/// cancel/timeout paths before the final `kill()`.
#[cfg(windows)]
struct KillTree {
    job: windows_sys::Win32::Foundation::HANDLE,
}

// SAFETY: a job HANDLE is a kernel object reference, usable from any thread.
#[cfg(windows)]
unsafe impl Send for KillTree {}

#[cfg(windows)]
impl KillTree {
    fn prepare(cmd: &mut Command, suspended: bool) {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        // Overwrites (not ORs) whatever `no_console_window` set — fine, since
        // CREATE_NO_WINDOW is all that ever sets, and it's included here.
        cmd.creation_flags(CREATE_NO_WINDOW | if suspended { CREATE_SUSPENDED } else { 0 });
    }

    fn attach(child: &mut Child, suspended: bool) -> std::io::Result<Option<Self>> {
        let tree = Self::new_job_with(child);
        if suspended && !resume_process(child.id()) {
            // Never leave a child suspended forever.
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::other("could not resume suspended child"));
        }
        Ok(tree)
    }

    /// A kill-on-close job with `child` assigned, or `None` if any step fails
    /// (then the callers fall back to killing just the leader).
    fn new_job_with(child: &Child) -> Option<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        // SAFETY: plain Win32 calls on a handle we own; `info` outlives the call
        // that reads it, and the job handle is closed by `Drop` on every path.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let tree = Self { job };
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if set == 0 || AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0 {
                return None; // `tree` drops -> CloseHandle
            }
            Some(tree)
        }
    }

    /// No soft stop exists for an arbitrary Windows process tree; `false` tells
    /// the cancel path to skip the grace and go straight to `kill`.
    fn terminate(&self) -> bool {
        false
    }

    fn kill(&self) {
        // SAFETY: `self.job` is a live job handle we own.
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
        }
    }

    /// Normal exit: drop KILL_ON_JOB_CLOSE before the handle closes, so a
    /// daemon the run legitimately started (fsmonitor) outlives it.
    fn release(self) {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        };
        // SAFETY: as in `new_job_with`.
        unsafe {
            let info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            SetInformationJobObject(
                self.job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
        }
    }
}

#[cfg(windows)]
impl Drop for KillTree {
    fn drop(&mut self) {
        // SAFETY: closed exactly once, here.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

/// Resume every thread of a process spawned `CREATE_SUSPENDED` (in practice its
/// single initial thread), found through a Toolhelp thread snapshot. `false` if
/// nothing was resumed.
#[cfg(windows)]
fn resume_process(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    // SAFETY: plain Win32 calls; `entry.dwSize` is set as Thread32First
    // requires, and every handle opened here is closed here.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snap == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut resumed = false;
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut ok = Thread32First(snap, &mut entry) != 0;
        while ok {
            if entry.th32OwnerProcessID == pid {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if !thread.is_null() {
                    if ResumeThread(thread) != u32::MAX {
                        resumed = true;
                    }
                    CloseHandle(thread);
                }
            }
            ok = Thread32Next(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
        resumed
    }
}

#[cfg(unix)]
struct KillTree {
    pgid: libc::pid_t,
}

#[cfg(unix)]
impl KillTree {
    fn prepare(cmd: &mut Command, _suspended: bool) {
        use std::os::unix::process::CommandExt;
        // A new SESSION, not just `process_group(0)`: a background group that
        // still shares GitCat's controlling terminal (launched from a shell,
        // e.g. `pnpm tauri dev`) gets SIGTTIN/SIGTTOU-stopped the moment ssh's
        // host-key question, its passphrase prompt or pinentry-curses opens
        // /dev/tty — a silent hang, and a stopped process ignores the cancel's
        // SIGTERM. With no controlling terminal, /dev/tty fails to open and
        // they fall back (SSH_ASKPASS) or error out, exactly as they already
        // do when GitCat is launched from the desktop. The session leader's
        // pgid is its pid, so `killpg(child.id())` is unchanged.
        // SAFETY: setsid is async-signal-safe, and it cannot fail with EPERM
        // here: the freshly forked child is never already a group leader.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    fn attach(child: &mut Child, _suspended: bool) -> std::io::Result<Option<Self>> {
        Ok(Some(Self { pgid: child.id() as libc::pid_t }))
    }

    /// SIGTERM to the group — git's sigchain removes its `.lock` files on it.
    fn terminate(&self) -> bool {
        // SAFETY: plain signal send; the leader is unreaped (see the invariant
        // on `KillTree`), so `pgid` is still ours.
        unsafe {
            libc::killpg(self.pgid, libc::SIGTERM);
        }
        true
    }

    fn kill(&self) {
        // SAFETY: as in `terminate`.
        unsafe {
            libc::killpg(self.pgid, libc::SIGKILL);
        }
    }

    fn release(self) {}
}

/// `output_with_timeout` callers (and anything predating [`run_with`]): run
/// with a hard timeout and nothing else.
///
/// `Command::output()` has no timeout at all — if the child ever hangs (a
/// `wsl.exe` interop call is a real OS process crossing into a whole other
/// virtualized Linux environment; USER-REPORTED against a real WSL repo
/// (CPython) — a Dashboard row stuck on "reading status…" forever, every
/// single time the modal opened, not just once. This doesn't reproduce on
/// demand here, so the exact underlying wsl.exe/WSL2 condition is
/// unconfirmed, but a subprocess call with literally no timeout is a real
/// gap regardless of root cause — used by BOTH `wsl.rs`'s `wsl_status`
/// (originally the only caller) and `safety::run_git` (the single most
/// widely-shared git-shelling helper in this codebase, ~20 call sites —
/// `trust::open_repo`'s own WSL "dubious ownership" auto-trust retry runs
/// THROUGH `run_git` on every single WSL-path repo open, even before
/// `wsl_status` is ever reached, so THIS was very plausibly the actual
/// stuck-forever call all along, not `wsl_status` itself), the calling IPC
/// command's promise never resolves either: not a whole-app freeze
/// (`run_blocking` already keeps this off the main thread), but the ONE
/// row/action that triggered it is stuck forever, with no way back short of
/// restarting GitCat.
///
/// Errors are exactly what this returned before `run_with` existed (see
/// [`RunError::into_io`]): `ErrorKind::TimedOut` "timed out after {d:?}" on a
/// timeout, the spawn/io error otherwise. A timeout now kills the whole tree.
pub fn output_with_timeout(cmd: Command, timeout: Duration) -> std::io::Result<Output> {
    run_with(cmd, RunOptions { timeout: Some(timeout), ..Default::default() }).map_err(RunError::into_io)
}

/// [`output_with_timeout`], but feeds `input` to the child's stdin (then
/// closes it) instead of giving it a null stdin. Used for `git fetch --stdin`
/// (see `promisor.rs`), where the object list can be far longer than a
/// Windows command line allows. The write happens on its own thread so a
/// child that stops reading stdin early can never deadlock the poll loop; the
/// timeout still applies to the whole run.
pub fn output_with_timeout_stdin(cmd: Command, input: Vec<u8>, timeout: Duration) -> std::io::Result<Output> {
    run_with(cmd, RunOptions { stdin: Some(input), timeout: Some(timeout), ..Default::default() }).map_err(RunError::into_io)
}

/// Central timeout policy for git argv. Skips leading "-C <p>", "-c <kv>",
/// "--git-dir=…"/"--work-tree=…" and other leading flags to find the
/// subcommand, then:
///
/// - network (`fetch`/`pull`/`push`/`clone`/`ls-remote`, `submodule
///   update`/`add`) and interactive tools (`mergetool`/`difftool`): `None` —
///   no hard timeout; a long network op gets stall detection instead;
/// - whole-repo rewrites/maintenance: [`LONG_OP_TIMEOUT`];
/// - history scans: [`READ_SCAN_TIMEOUT`];
/// - local ops that may run hooks or wait on gpg: [`LOCAL_OP_TIMEOUT`];
/// - everything else (rev-parse, config, branch, update-ref, ...):
///   [`SUBPROCESS_TIMEOUT`].
pub fn git_timeout(args: &[&str]) -> Option<Duration> {
    // Global options that take their value as the NEXT argv token.
    const VALUED: &[&str] = &["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"];
    let mut rest = args.iter().copied();
    let sub = loop {
        match rest.next() {
            None => return Some(SUBPROCESS_TIMEOUT), // `git --version` and friends
            Some(a) if VALUED.contains(&a) => {
                rest.next();
            }
            Some(a) if a.starts_with('-') => {}
            Some(a) => break a,
        }
    };
    match sub {
        "fetch" | "pull" | "push" | "clone" | "ls-remote" | "mergetool" | "difftool" => None,
        "submodule" => match rest.find(|a| !a.starts_with('-')) {
            Some("update" | "add") => None,
            _ => Some(LOCAL_OP_TIMEOUT),
        },
        "filter-repo" | "gc" | "maintenance" | "fsck" | "repack" | "prune" | "bundle" => Some(LONG_OP_TIMEOUT),
        "grep" | "log" | "rev-list" | "format-patch" | "blame" | "shortlog" => Some(READ_SCAN_TIMEOUT),
        "commit" | "merge" | "rebase" | "cherry-pick" | "revert" | "am" | "apply" | "stash" | "switch" | "checkout" | "reset" | "restore"
        | "clean" | "add" | "rm" | "mv" | "tag" | "bisect" | "worktree" | "status" | "diff" => Some(LOCAL_OP_TIMEOUT),
        _ => Some(SUBPROCESS_TIMEOUT),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // output_with_timeout: platform-agnostic sleep/echo commands (matching
    // git_bisect.rs's own run_test_command convention — `cmd /C` on Windows,
    // `sh -c` elsewhere) since these exercise the generic wait/kill/drain
    // logic directly, with no WSL involved at all.
    fn sleep_command(seconds: u64) -> Command {
        if cfg!(target_os = "windows") {
            let mut c = Command::new("cmd");
            c.args(["/C", &format!("ping -n {} 127.0.0.1 >NUL", seconds + 1)]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", &format!("sleep {seconds}")]);
            c
        }
    }

    fn echo_command(text: &str) -> Command {
        if cfg!(target_os = "windows") {
            let mut c = Command::new("cmd");
            c.args(["/C", &format!("echo {text}")]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", &format!("echo {text}")]);
            c
        }
    }

    /// Walk the nap schedule the way the loop does, returning the cumulative
    /// sleep after each poll. No clock: this is the POLICY, not a measurement.
    fn cumulative_naps(count: usize) -> Vec<Duration> {
        let mut nap = POLL_FIRST;
        let mut total = Duration::ZERO;
        (0..count)
            .map(|_| {
                total += nap;
                nap = next_nap(nap);
                total
            })
            .collect()
    }

    /// When is a child that exits at `t` actually NOTICED? The first poll whose
    /// cumulative sleep has reached `t` — which is the whole subject of #78.
    fn observed_at(t: Duration, naps: &[Duration]) -> Duration {
        naps.iter().copied().find(|&c| c >= t).expect("the schedule must outrun the durations tested")
    }

    #[test]
    fn the_nap_schedule_starts_small_and_stops_at_the_quantum_it_replaced() {
        assert_eq!(POLL_FIRST, Duration::from_micros(250));
        let mut nap = POLL_FIRST;
        let mut seen = vec![nap];
        for _ in 0..12 {
            nap = next_nap(nap);
            seen.push(nap);
        }
        assert_eq!(
            &seen[..8],
            &[
                Duration::from_micros(250),
                Duration::from_micros(500),
                Duration::from_millis(1),
                Duration::from_millis(2),
                Duration::from_millis(4),
                Duration::from_millis(8),
                Duration::from_millis(16),
                Duration::from_millis(30), // 32 would overshoot the ceiling
            ]
        );
        assert!(seen.iter().all(|&d| d <= POLL_MAX), "the backoff must never sleep longer than the flat loop did");
        assert_eq!(*seen.last().unwrap(), POLL_MAX, "and it must actually reach the ceiling, not creep toward it");
    }

    /// The trade, stated as a test rather than as a claim.
    ///
    /// The flat 30ms loop notices a child only on a 30ms boundary. The backoff
    /// notices most children far sooner, but there is a window — a child that
    /// exits between the 7th cumulative nap (31.75ms) and the first flat
    /// boundary (30ms) — where it can land slightly LATER. That window is real
    /// and small, and pinning its size here is what keeps "this is a win" from
    /// being a thing nobody checked.
    #[test]
    fn the_backoff_beats_the_flat_quantum_everywhere_that_matters_and_never_loses_by_much() {
        let naps = cumulative_naps(40);
        let flat: Vec<Duration> = (1..40).map(|k| Duration::from_millis(30 * k as u64)).collect();

        let (mut worst_loss, mut worst_at) = (Duration::ZERO, Duration::ZERO);
        let mut t = Duration::from_micros(100);
        while t < Duration::from_millis(200) {
            let b = observed_at(t, &naps);
            let f = observed_at(t, &flat);
            if b > f && b - f > worst_loss {
                worst_loss = b - f;
                worst_at = t;
            }
            t += Duration::from_micros(100);
        }
        assert!(
            worst_loss < Duration::from_millis(2),
            "the backoff is {worst_loss:?} slower than the flat loop for a child exiting at {worst_at:?} — \
             the known window is ~1.75ms wide; anything larger means the schedule changed shape"
        );

        // And the case the issue is actually about: a short child.
        for ms in [1u64, 5, 8, 12] {
            let t = Duration::from_millis(ms);
            let saved = observed_at(t, &flat) - observed_at(t, &naps);
            assert!(
                saved >= Duration::from_millis(13),
                "a {ms}ms child should be noticed at least 13ms sooner, saved only {saved:?}"
            );
        }
    }

    #[test]
    fn output_with_timeout_kills_a_hung_child_and_reports_timed_out() {
        let cmd = sleep_command(30);
        let err = output_with_timeout(cmd, Duration::from_millis(200)).expect_err("a 30s sleep must not finish within a 200ms timeout");
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
    }

    #[test]
    fn output_with_timeout_returns_normally_for_a_command_that_finishes_well_within_it() {
        let out = output_with_timeout(echo_command("hello_gitcat"), Duration::from_secs(10)).expect("a fast command should succeed well within the timeout");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("hello_gitcat"));
    }

    #[test]
    fn no_console_window_is_chainable_and_still_runs_the_command() {
        // Not asserting anything Windows-specific here (this test runs on
        // whatever platform CI/the dev machine actually is) — just proving
        // the trait method chains cleanly and doesn't break a real spawn.
        let out = Command::new(if cfg!(windows) { "cmd" } else { "true" })
            .no_console_window()
            .args(if cfg!(windows) { vec!["/C", "exit 0"] } else { vec![] })
            .output()
            .expect("failed to spawn");
        assert!(out.status.success());
    }

    // ---- run_with ----------------------------------------------------------

    /// A shell running `script` — `cmd /C` on Windows, `sh -c` elsewhere.
    fn shell(script: &str) -> Command {
        if cfg!(target_os = "windows") {
            let mut c = Command::new("cmd");
            c.args(["/C", script]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", script]);
            c
        }
    }

    /// A shell whose CHILD (not the shell itself) sleeps ~30 s while holding
    /// the inherited stdout: Windows `ping` is a separate process of `cmd`,
    /// and the trailing `; :` stops `sh` from exec-ing `sleep` in its own
    /// place. Killing only the leader would leave the pipe open and hang the
    /// reader join — returning promptly at all proves the whole tree (this
    /// one stays in its group; see the known limit on `run_with`) died.
    fn grandchild_holding_stdout() -> Command {
        if cfg!(target_os = "windows") {
            shell("ping -n 30 127.0.0.1")
        } else {
            shell("sleep 30; :")
        }
    }

    #[test]
    fn run_with_collects_stdout_and_status_like_output_with_timeout() {
        let out = run_with(echo_command("hello_run_with"), RunOptions::default()).expect("echo should run");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("hello_run_with"));
        let failed = run_with(shell("exit 3"), RunOptions::default()).expect("exit 3 still runs");
        assert_eq!(failed.status.code(), Some(3));
    }

    #[test]
    fn timeout_none_lets_a_slow_child_finish() {
        let out = run_with(sleep_command(1), RunOptions { timeout: None, ..Default::default() }).expect("no timeout means no kill");
        assert!(out.status.success());
    }

    #[test]
    fn timeout_returns_timed_out_and_wrapper_keeps_io_kind() {
        let err = run_with(sleep_command(30), RunOptions { timeout: Some(Duration::from_millis(200)), ..Default::default() })
            .expect_err("a 30s sleep must not finish within 200ms");
        assert!(matches!(err, RunError::TimedOut(d) if d == Duration::from_millis(200)), "{err:?}");
        assert_eq!(err.to_ierr("err_misc.could_not_run_git"), "i18n:err_misc.git_timed_out\u{1f}secs\u{1f}0");
        let io = err.into_io();
        assert_eq!(io.kind(), std::io::ErrorKind::TimedOut);
        assert!(io.to_string().starts_with("timed out after"), "{io}");
    }

    #[test]
    fn cancel_before_spawn_never_spawns() {
        let token = CancelToken::new();
        token.cancel();
        let err = run_with(Command::new("gitcat-definitely-missing-exe"), RunOptions { cancel: Some(token), ..Default::default() })
            .expect_err("a pre-cancelled run must not succeed");
        assert!(err.is_cancelled(), "expected Cancelled (no spawn attempted), got {err:?}");
        assert_eq!(err.to_ierr("x.y"), "i18n:err_misc.cancelled");
        assert_eq!(err.into_io().kind(), std::io::ErrorKind::Interrupted);
    }

    #[test]
    fn spawn_failure_is_io() {
        let err = run_with(Command::new("gitcat-definitely-missing-exe"), RunOptions::default()).expect_err("missing exe");
        assert!(matches!(err, RunError::Io(_)), "{err:?}");
        assert!(err.to_ierr("err_misc.could_not_run_git").starts_with("i18n:err_misc.could_not_run_git\u{1f}detail\u{1f}"));
    }

    #[test]
    fn cancel_kills_the_grandchild_holding_stdout() {
        let token = CancelToken::new();
        let remote = token.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            remote.cancel();
        });
        let started = Instant::now();
        let err = run_with(grandchild_holding_stdout(), RunOptions { cancel: Some(token), ..Default::default() })
            .expect_err("a cancelled run must not succeed");
        let elapsed = started.elapsed();
        canceller.join().unwrap();
        assert!(err.is_cancelled(), "{err:?}");
        assert!(elapsed < Duration::from_secs(5), "cancel took {elapsed:?} — the grandchild kept the pipe open");
    }

    #[test]
    fn timeout_kills_the_grandchild_too() {
        let started = Instant::now();
        let err = run_with(grandchild_holding_stdout(), RunOptions { timeout: Some(Duration::from_millis(500)), ..Default::default() })
            .expect_err("must time out");
        let elapsed = started.elapsed();
        assert!(matches!(err, RunError::TimedOut(_)), "{err:?}");
        assert!(elapsed < Duration::from_secs(5), "timeout took {elapsed:?} — the grandchild kept the pipe open");
    }

    #[test]
    fn cancellable_run_resumes_and_completes_normally() {
        // On Windows a cancellable run is spawned suspended and resumed after
        // the job assign; a missed resume would hang here forever.
        let token = CancelToken::new();
        let out = run_with(echo_command("hi"), RunOptions { cancel: Some(token), ..Default::default() }).expect("never cancelled");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hi");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unix_child_leads_its_own_session() {
        // Session leader (sid == pid) means no controlling terminal, so a
        // /dev/tty prompt fails fast instead of SIGTTIN-stopping the child when
        // GitCat runs from a shell. Field 6 of /proc/<pid>/stat is the sid
        // (the `(sh)` comm field has no spaces).
        let out = run_with(shell(r#"read -r _ _ _ _ _ sid _ < /proc/$$/stat; echo "$$ $sid""#), RunOptions::default()).expect("ran");
        let text = String::from_utf8_lossy(&out.stdout);
        let ids: Vec<&str> = text.split_whitespace().collect();
        assert_eq!(ids.len(), 2, "unexpected output: {text:?}");
        assert_eq!(ids[0], ids[1], "child is not a session leader: {text:?}");
    }

    // Drive `feed_progress` chunk-by-chunk (mirroring run_with's reader loop,
    // including the final flush) and collect every emitted segment.
    fn segment(chunks: &[&[u8]]) -> Vec<String> {
        let mut seg: Vec<u8> = Vec::new();
        let mut lines: Vec<String> = Vec::new();
        let mut on_line = |s: &str| lines.push(s.to_string());
        for c in chunks {
            feed_progress(c, &mut seg, &mut on_line);
        }
        if !seg.is_empty() {
            on_line(String::from_utf8_lossy(&seg).trim_end());
        }
        lines
    }

    #[test]
    fn stderr_sink_splits_on_cr_and_lf() {
        // git rewrites the SAME progress line with \r, ending a phase with \n.
        let input = b"remote: Counting objects: 100%\rReceiving objects:  42% (42/100)\rReceiving objects: 100% (100/100)\nResolving deltas: 100% (10/10)\n";
        assert_eq!(
            segment(&[input]),
            vec![
                "remote: Counting objects: 100%",
                "Receiving objects:  42% (42/100)",
                "Receiving objects: 100% (100/100)",
                "Resolving deltas: 100% (10/10)",
            ]
        );
        // A final segment with no trailing delimiter is flushed.
        assert_eq!(segment(&[b"done."]), vec!["done."]);
        // A segment (and a multi-byte char, "é" = 0xC3 0xA9) split across two
        // reads must reassemble, not corrupt or drop.
        assert_eq!(segment(&[b"Receiving obj\xc3", b"\xa9cts: 5%\rok\n"]), vec!["Receiving objécts: 5%", "ok"]);
        // Back-to-back delimiters (e.g. \r\n or a blank line) must not emit "".
        assert_eq!(segment(&[b"a\r\n\nb\n"]), vec!["a", "b"]);

        // And live, through a real child's stderr.
        let mut lines: Vec<String> = Vec::new();
        let mut sink = |s: &str| lines.push(s.to_string());
        let script = if cfg!(target_os = "windows") { "(echo live_err)1>&2" } else { r"printf 'one\rtwo\n' >&2" };
        let out = run_with(shell(script), RunOptions { on_stderr_line: Some(&mut sink), ..Default::default() }).expect("runs");
        assert!(out.status.success());
        let expected: &[&str] = if cfg!(target_os = "windows") { &["live_err"] } else { &["one", "two"] };
        assert_eq!(lines, expected);
        assert!(!out.stderr.is_empty(), "the buffer still gets the bytes the sink saw");
    }

    #[test]
    fn stdout_sink_receives_lines() {
        let mut lines: Vec<String> = Vec::new();
        let mut sink = |s: &str| lines.push(s.to_string());
        let script = if cfg!(target_os = "windows") { "echo one& echo two" } else { "echo one; echo two" };
        let out = run_with(shell(script), RunOptions { on_stdout_line: Some(&mut sink), ..Default::default() }).expect("runs");
        assert!(out.status.success());
        assert_eq!(lines, ["one", "two"]);
        assert!(String::from_utf8_lossy(&out.stdout).contains("two"));
    }

    #[test]
    fn stall_hook_fires_then_clears() {
        let mut events: Vec<bool> = Vec::new();
        let mut on_change = |s: bool| events.push(s);
        // A ~3 s silence (past the 1.5 s threshold) between `a` and `b`, then a
        // ~0.5-1 s pause (under it) that keeps the child alive after `b`, so
        // the poll loop sees output resume before it sees the exit and never
        // sees a second stall.
        let script = if cfg!(target_os = "windows") {
            "echo a& ping -n 4 127.0.0.1 >NUL& echo b& ping -n 2 127.0.0.1 >NUL"
        } else {
            "echo a; sleep 3; echo b; sleep 0.5"
        };
        let out = run_with(
            shell(script),
            RunOptions { stall: Some(StallHook { after: Duration::from_millis(1500), on_change: &mut on_change }), ..Default::default() },
        )
        .expect("runs");
        assert!(out.status.success());
        assert_eq!(events, [true, false]);
    }

    #[test]
    fn stdin_is_fed_and_closed() {
        // `findstr`/`cat` read to EOF, so this only returns if stdin is closed.
        let cmd = if cfg!(target_os = "windows") {
            let mut c = Command::new("findstr");
            c.arg("x");
            c
        } else {
            Command::new("cat")
        };
        let out = output_with_timeout_stdin(cmd, b"x1\nx2\n".to_vec(), Duration::from_secs(10)).expect("runs");
        assert!(out.status.success());
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("x1") && text.contains("x2"), "{text:?}");
    }

    #[test]
    fn discard_output_returns_status_with_empty_buffers() {
        let script = if cfg!(target_os = "windows") { "echo noise& exit 4" } else { "echo noise; exit 4" };
        let out = run_with(shell(script), RunOptions { discard_output: true, ..Default::default() }).expect("runs");
        assert_eq!(out.status.code(), Some(4));
        assert!(out.stdout.is_empty() && out.stderr.is_empty());
    }

    #[test]
    fn git_timeout_policy_table() {
        for sub in ["fetch", "pull", "push", "clone", "ls-remote", "mergetool", "difftool"] {
            assert_eq!(git_timeout(&[sub]), None, "{sub}");
        }
        assert_eq!(git_timeout(&["submodule", "update", "--init"]), None);
        assert_eq!(git_timeout(&["submodule", "--quiet", "add", "url"]), None);
        assert_eq!(git_timeout(&["submodule", "init"]), Some(LOCAL_OP_TIMEOUT));
        assert_eq!(git_timeout(&["submodule", "sync"]), Some(LOCAL_OP_TIMEOUT));
        assert_eq!(git_timeout(&["submodule"]), Some(LOCAL_OP_TIMEOUT));
        for sub in ["filter-repo", "gc", "maintenance", "fsck", "repack", "prune", "bundle"] {
            assert_eq!(git_timeout(&[sub]), Some(LONG_OP_TIMEOUT), "{sub}");
        }
        for sub in ["grep", "log", "rev-list", "format-patch", "blame", "shortlog"] {
            assert_eq!(git_timeout(&[sub]), Some(READ_SCAN_TIMEOUT), "{sub}");
        }
        for sub in [
            "commit", "merge", "rebase", "cherry-pick", "revert", "am", "apply", "stash", "switch", "checkout", "reset", "restore", "clean", "add",
            "rm", "mv", "tag", "bisect", "worktree", "status", "diff",
        ] {
            assert_eq!(git_timeout(&[sub]), Some(LOCAL_OP_TIMEOUT), "{sub}");
        }
        for sub in ["rev-parse", "config", "branch", "remote", "update-ref", "symbolic-ref", "for-each-ref", "merge-file", "rerere"] {
            assert_eq!(git_timeout(&[sub]), Some(SUBPROCESS_TIMEOUT), "{sub}");
        }
        assert_eq!(git_timeout(&["--version"]), Some(SUBPROCESS_TIMEOUT));
        assert_eq!(git_timeout(&[]), Some(SUBPROCESS_TIMEOUT));
        // Leading global options are skipped, valued ones with their value —
        // even a value that happens to spell a subcommand.
        assert_eq!(git_timeout(&["-C", "/repo/fetch", "fetch", "origin"]), None);
        assert_eq!(git_timeout(&["-C", "fetch", "status"]), Some(LOCAL_OP_TIMEOUT));
        assert_eq!(git_timeout(&["-c", "core.quotepath=off", "-C", "/r", "log", "--all"]), Some(READ_SCAN_TIMEOUT));
        assert_eq!(git_timeout(&["--git-dir=/r/.git", "--work-tree=/r", "--no-pager", "gc"]), Some(LONG_OP_TIMEOUT));
        assert_eq!(git_timeout(&["--git-dir", "/r/.git", "push"]), None);
    }
}
