//! Dev harness: `cargo run --release --example pollcheck -- <repo> [spawns]`
//!
//! Answers "what does `procutil::output_with_timeout`'s poll loop cost a short
//! child?" (#78) by spawning a real, trivial git command N times under three
//! policies and reporting both a wall clock and a clock-free count.
//!
//! # Read the poll count first
//!
//! Wall clock is the number people want and the one that lies. This harness was
//! first run on a machine at load average 221 (an unrelated compile swarm) and
//! reported 326 ms/spawn for a plain `Command::output()` and a backoff SLOWER
//! than the flat sleep — pure noise, and in the wrong direction. The poll count
//! and the requested-sleep total are what the POLICY controls; they do not move
//! when the machine is busy the way wall clock does, and on that same
//! load-221 machine they were identical across runs:
//!
//! ```text
//!   flat 30ms (before)     polls/spawn 2.0   requested sleep/spawn 30.00 ms
//!   backoff (after)        polls/spawn 7.0   requested sleep/spawn 16.28 ms
//! ```
//!
//! The `2.0` is the bug in one number. Not an average — every single spawn. The
//! first `try_wait()` never finds a freshly spawned child already exited, so the
//! caller waits out a whole 30 ms quantum to notice a `git config` that took
//! 8 ms. The backoff's own figure being 16 ms rather than the ~5 ms it costs on
//! an idle machine is the schedule working as intended: it follows how long the
//! child actually took, which under that load was genuinely longer. The flat
//! sleep follows nothing.
//!
//! Run the wall-clock columns on a quiet machine or ignore them.

use std::io::Read;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

/// The three policies compared. `Flat30` is what `output_with_timeout` did
/// before #78; `Backoff` mirrors what it does now. Both are reimplemented here
/// rather than called, so this harness can run BOTH and show the difference
/// from one binary — `procutil` itself only has one.
#[derive(Clone, Copy)]
enum Policy {
    Flat30,
    Backoff,
}

struct Run {
    polls: u32,
    requested_sleep: Duration,
}

/// `procutil::output_with_timeout`'s body with the sleep policy parameterised
/// and instrumentation added. Kept structurally identical — same two drain
/// threads, same deadline check, same kill path — so a difference here is a
/// difference in the policy and not in the harness.
fn wait_with_policy(mut cmd: Command, timeout: Duration, policy: Policy) -> std::io::Result<(Output, Run)> {
    let mut child: Child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let mut stdout_pipe = child.stdout.take().expect("stdout was piped above");
    let mut stderr_pipe = child.stderr.take().expect("stderr was piped above");
    let stdout_thread = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut b);
        b
    });
    let stderr_thread = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut b);
        b
    });

    let start = Instant::now();
    let mut nap = Duration::from_micros(250);
    let mut run = Run { polls: 0, requested_sleep: Duration::ZERO };
    let status = loop {
        run.polls += 1;
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out"));
        }
        let gap = match policy {
            Policy::Flat30 => Duration::from_millis(30),
            Policy::Backoff => nap,
        };
        std::thread::sleep(gap);
        run.requested_sleep += gap;
        nap = (nap * 2).min(Duration::from_millis(30));
    };
    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();
    Ok((Output { status, stdout, stderr }, run))
}

/// A deliberately trivial child: reads one config key and exits. It does no
/// repository work at all, so what is being measured is the wait, not git.
fn git(repo: &str) -> Command {
    let mut c = Command::new("git");
    c.arg("-C").arg(repo).args(["config", "--local", "--get", "user.name"]);
    c
}

fn main() {
    let repo = match std::env::args().nth(1) {
        Some(r) => r,
        None => {
            eprintln!("usage: pollcheck <repo> [spawns]");
            std::process::exit(2);
        }
    };
    let n: u32 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(40);
    let timeout = Duration::from_secs(60);

    // Warm the page cache and dyld so the first spawn's one-off cost is not
    // attributed to whichever policy happens to run first.
    for _ in 0..5 {
        let _ = git(&repo).stdin(Stdio::null()).output();
    }

    println!("`git config --local --get user.name` x{n} against {repo}\n");
    println!("{:<26} {:>12} {:>14} {:>22}", "policy", "wall ms/spawn", "polls/spawn", "requested sleep ms/spawn");

    let t = Instant::now();
    for _ in 0..n {
        let _ = git(&repo).stdin(Stdio::null()).output();
    }
    let plain = t.elapsed();
    println!("{:<26} {:>12.2} {:>14} {:>22}", "plain Command::output()", plain.as_secs_f64() * 1000.0 / n as f64, "-", "-");

    for (label, policy) in [("output_with_timeout flat30", Policy::Flat30), ("output_with_timeout backoff", Policy::Backoff)] {
        let (mut polls, mut slept) = (0u32, Duration::ZERO);
        let t = Instant::now();
        for _ in 0..n {
            let (_out, run) = wait_with_policy(git(&repo), timeout, policy).expect("the child should not time out");
            polls += run.polls;
            slept += run.requested_sleep;
        }
        let wall = t.elapsed();
        println!(
            "{:<26} {:>12.2} {:>14.1} {:>22.2}",
            label,
            wall.as_secs_f64() * 1000.0 / n as f64,
            polls as f64 / n as f64,
            slept.as_secs_f64() * 1000.0 / n as f64
        );
    }

    println!("\nIf the machine is busy, trust the last two columns and not the first.");
    println!("Check `uptime` before quoting a wall-clock number from this harness.");
}
