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
//!   - `output_with_timeout` bounds how long a `Command` is allowed to run
//!     before this app gives up and kills it — see its own doc comment.

use std::io::Read;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

/// Shared default for `output_with_timeout` callers that don't have a more
/// specific reason to pick their own value — generous enough to cover a
/// cold WSL2 VM spin-up (the slowest LEGITIMATE case any of this app's git
/// subprocess calls sees; an already-warm `wsl.exe` interop launch is
/// sub-second) while still turning a genuine hang into a bounded,
/// user-visible failure within a reasonable wait.
pub const SUBPROCESS_TIMEOUT: Duration = Duration::from_secs(20);

/// First gap between `try_wait()` polls in [`output_with_timeout`], doubled
/// after each miss up to [`POLL_MAX`].
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
/// makes the EARLY polls closer together.
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
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        self.creation_flags(CREATE_NO_WINDOW)
    }

    #[cfg(not(windows))]
    fn no_console_window(&mut self) -> &mut Self {
        self
    }
}

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
/// Polls `try_wait()` on a geometric backoff ([`POLL_FIRST`] doubling to
/// [`POLL_MAX`]) rather than a bare blocking `.wait()`, so the timeout is
/// actually enforceable without taxing every short child a fixed quantum —
/// see [`POLL_FIRST`] for what the flat version cost. stdout/stderr are drained
/// on separate threads
/// CONCURRENTLY with that poll loop (not just read after the child exits,
/// the way a naive `child.wait_with_output()` would) — a `git status`
/// against a large repo with many untracked files can produce more output
/// than one OS pipe buffer holds, and a child blocked writing to a full pipe
/// nobody's draining would itself look identical to "hung" and get killed
/// spuriously by the very timeout meant to catch a REAL hang.
pub fn output_with_timeout(mut cmd: Command, timeout: Duration) -> std::io::Result<Output> {
    let mut child: Child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let mut stdout_pipe = child.stdout.take().expect("stdout was piped above");
    let mut stderr_pipe = child.stderr.take().expect("stderr was piped above");
    let stdout_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        buf
    });
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });

    let start = Instant::now();
    let mut nap = POLL_FIRST;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if start.elapsed() >= timeout {
            let _ = child.kill(); // closes the pipes -> the two reader threads below unblock and finish
            let _ = child.wait();
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, format!("timed out after {timeout:?}")));
        }
        // Sleep no longer than what is left of the timeout, so the deadline
        // above is still checked within a quantum of expiring rather than
        // overshooting it by a full nap on the last iteration.
        std::thread::sleep(nap.min(timeout.saturating_sub(start.elapsed())));
        nap = next_nap(nap);
    };
    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();
    Ok(Output { status, stdout, stderr })
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
}
