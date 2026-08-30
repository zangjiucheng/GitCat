//! The good/bad/skip judgement `tests/bisect.rs` hands to `git bisect run`.
//!
//! It is a program rather than a shell script because `run_test_command`
//! (git_bisect.rs) runs the judgement through whichever shell the platform
//! has — `sh -c` on unix, `cmd /C` on Windows — and the two share no spelling
//! of the things these tests need: state that survives between separate
//! invocations, and a bounded block so the test's main thread can observe a
//! run mid-flight. cmd has no `sleep`, and `timeout /t` wants a console the
//! app deliberately withholds. An executable is invoked identically by both.
//!
//! An `examples/` target rather than a `[[bin]]` so it never ships in the app:
//! `cargo test` builds examples, and `tests/bisect.rs` finds this one next to
//! its own binary (`target/<profile>/examples/` is a sibling of `deps/`).
//!
//! Exit codes are `git bisect run`'s contract, which `classify_exit` mirrors:
//! 0 = good, 125 = skip, any other 1..=127 = bad.
//!
//! Runs with its working directory set to the repo under test, so every path
//! below is relative to that working tree.
//!
//! Usage:
//!   bisect_judge skip-once <k-index> <marker>
//!   bisect_judge slow-first <marker> <sleep-ms>
//!
//! Arguments are deliberately free of spaces and shell metacharacters — the
//! command reaches the shell as one string, and quoting rules are the other
//! thing `sh` and `cmd` do not agree on.

use std::io::Write;
use std::path::Path;
use std::process::exit;

const GOOD: i32 = 0;
const BAD: i32 = 1;
const SKIP: i32 = 125;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        // "Bad iff bug.txt is present, EXCEPT that the first bad commit which
        // is not K itself is skipped exactly once."
        //
        // K is identified by content rather than by sha, because the judge
        // sees only a checked-out working tree: `history.txt` holds `line <i>`
        // for commit i, so the K commit is the one whose file reads
        // `line <k-index>`. K must never be skipped, or the bisect has no
        // guaranteed convergence point.
        Some("skip-once") => {
            let k_index: usize = args.get(1).expect("skip-once needs <k-index>").parse().expect("k-index must be a number");
            let marker = args.get(2).expect("skip-once needs <marker>");

            let history = std::fs::read_to_string("history.txt").unwrap_or_default();
            let is_k = history.lines().any(|l| l.trim_end() == format!("line {k_index}"));
            if is_k {
                exit(BAD);
            }
            if !Path::new("bug.txt").exists() {
                exit(GOOD);
            }
            if Path::new(marker).exists() {
                exit(BAD);
            }
            std::fs::File::create(marker).expect("create the skip marker");
            exit(SKIP);
        }

        // "Good always, but the FIRST invocation announces itself and then
        // blocks" — the marker is the side channel the test's main thread
        // polls to know a run is genuinely in flight before it cancels, or
        // before it attempts a second concurrent run.
        Some("slow-first") => {
            let marker = args.get(1).expect("slow-first needs <marker>");
            let sleep_ms: u64 = args.get(2).expect("slow-first needs <sleep-ms>").parse().expect("sleep-ms must be a number");

            if !Path::new(marker).exists() {
                // Create and flush before sleeping: the whole point is that the
                // watching thread sees it while this one is still blocked.
                let mut f = std::fs::File::create(marker).expect("create the in-flight marker");
                f.flush().expect("flush the in-flight marker");
                drop(f);
                std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
            }
            exit(GOOD);
        }

        other => {
            eprintln!("bisect_judge: unknown mode {other:?}");
            eprintln!("usage: bisect_judge skip-once <k-index> <marker>");
            eprintln!("       bisect_judge slow-first <marker> <sleep-ms>");
            // Not in 1..=127, so `classify_exit` treats it as "could not run"
            // rather than silently folding a usage error into a "bad" verdict.
            exit(200);
        }
    }
}
