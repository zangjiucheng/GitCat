//! Repository Summary — a git-log-derived diagnostic shown the first time a
//! repo is opened in GitCat (see `repo_registry.rs`'s
//! `claim_repo_summary_first_open`) and reachable afterward any time via
//! Tools/⌘K. Inspired by
//! <https://piechowski.io/post/git-commands-before-reading-code/>: a handful
//! of `git log` aggregations tell you more about a repo's shape than the
//! first hour of reading source — which files are the real center of
//! gravity, who actually maintains it, whether activity is steady or
//! bursty, and where the recurring trouble spots are.
//!
//! Read/write split: PURE READ — never calls `crate::safety::snapshot`. Owns
//! its own small `Out`/`run_git` pair (this codebase's per-module
//! convention — see `file_history.rs`/`pickaxe.rs`'s own doc comments)
//! rather than `safety::run_git`, which is reserved for mutations that must
//! follow the Safety Manager's own invariants.
//!
//! ONE `git log` walk powers all four sections below — touched files,
//! author, timestamp, and subject are all present in a single commit
//! record, so there is no reason for four separate invocations (unlike, say,
//! a `git shortlog` + a separate `git log --name-only` + ...). Parsing
//! format: `--format=%x00%H%x00%an%x00%ae%x00%at%x00%s%x00` combined with
//! `--name-only`, same NUL-delimited convention as `file_history.rs`/
//! `pickaxe.rs`, with the trailing block per record holding this commit's
//! touched-paths list (one path per line) instead of a `--name-status`
//! block. `-c core.quotePath=false` avoids the same non-ASCII-path
//! C-quoting hazard `file_history.rs` documents. `--no-renames` is passed
//! explicitly so results are deterministic regardless of the caller's
//! ambient `diff.renames` config. HEAD's ancestry only (not `--all`),
//! matching this app's other single-ancestry read views.
//!
//! DELIBERATE SIMPLIFICATIONS, matching existing conventions elsewhere:
//!   - No rename-tracking for churn/problem-areas (same reasoning as
//!     `pickaxe.rs`'s own choice not to `--follow` — too expensive across a
//!     whole-repo, many-file scan). A heavily-renamed file's churn count
//!     splits across its old and new names.
//!   - No mailmap resolution — raw `%an`/`%ae`, same as `blame.rs`/
//!     `git_read.rs` everywhere else in this app, even though GitCat ships a
//!     `.mailmap` editor (`repo_files.rs`) for other purposes.
//!   - The bug/fix keyword match ([`BUG_KEYWORDS`]) is a plain,
//!     word-boundary, case-insensitive heuristic over the commit SUBJECT —
//!     not a classifier. Real false positives/negatives are expected; the
//!     frontend must present this as a heuristic, never as authoritative.
//!
//! Date math: no `chrono`/`time` dependency exists anywhere in this codebase
//! (checked `Cargo.toml`) — [`civil_from_unix`] hand-rolls Howard Hinnant's
//! well-known, public-domain `civil_from_days` algorithm (always UTC, no
//! timezone/locale concerns) rather than taking on a new dependency for the
//! one thing this module needs: a `--since` cutoff date and monthly
//! bucketing.
//!
//! Caps: [`CHURN_WINDOW_DAYS`]/[`MAX_SUMMARY_COMMITS`] — own module
//! constants, matching the "each module owns its own `MAX_*`" convention
//! (`pickaxe::MAX_PICKAXE_MATCHES`, `file_history::MAX_HISTORY_COMMITS`).

use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;

/// How far back the whole walk looks — "the last year", matching the
/// article's own example window.
const CHURN_WINDOW_DAYS: i64 = 365;
/// Raw commit-walk cap, passed to `--max-count`. Not yet empirically
/// profiled against a genuinely huge repo the way `pickaxe.rs`'s own cap
/// was — a reasonable starting point, worth tuning once profiled.
const MAX_SUMMARY_COMMITS: usize = 20_000;
const TOP_CHURN_FILES: usize = 20;
const TOP_CONTRIBUTORS: usize = 20;
const TOP_PROBLEM_FILES: usize = 20;
/// Filters one-off-touched files out of the "problem areas" ranking — a file
/// touched once by a single fix commit isn't a meaningful hotspot.
const MIN_TOUCHES_FOR_PROBLEM_FILE: usize = 3;
/// "Bus factor" here means: the minimum number of top contributors (by raw
/// commit count) whose combined commits reach at least half of the window's
/// total commits. One reasonable interpretation among several possible ones
/// (there's no single formal definition) — not a code-ownership/"truck
/// factor" analysis.
const BUS_FACTOR_THRESHOLD: f64 = 0.5;
const BUG_KEYWORDS: &[&str] = &[
    "fix", "fixes", "fixed", "bug", "bugfix", "hotfix", "regression", "revert", "broken", "crash", "issue",
];

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChurnFile {
    pub path: String,
    pub touches: usize,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Contributor {
    pub name: String,
    pub email: String,
    pub commits: usize,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyActivity {
    pub month: String, // "YYYY-MM", UTC, chronological
    pub commits: usize,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProblemFile {
    pub path: String,
    pub bugfix_touches: usize,
    pub total_touches: usize,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProblemAreas {
    pub files: Vec<ProblemFile>,
    pub revert_or_hotfix_commits: usize,
    pub total_commits: usize,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub window_days: i64,
    pub total_commits: usize,
    pub truncated: bool, // hit MAX_SUMMARY_COMMITS
    pub churn: Vec<ChurnFile>,
    pub contributors: Vec<Contributor>,
    pub bus_factor: usize,
    pub monthly: Vec<MonthlyActivity>,
    pub problem_areas: ProblemAreas,
}

fn empty_summary() -> RepoSummary {
    RepoSummary {
        window_days: CHURN_WINDOW_DAYS,
        total_commits: 0,
        truncated: false,
        churn: Vec::new(),
        contributors: Vec::new(),
        bus_factor: 0,
        monthly: Vec::new(),
        problem_areas: ProblemAreas { files: Vec::new(), revert_or_hotfix_commits: 0, total_commits: 0 },
    }
}

// ---------------------------------------------------------------------------
// Tauri command (registered in lib.rs)
// ---------------------------------------------------------------------------

/// Aggregated churn/contributor/monthly-activity/problem-area diagnostics
/// over the last [`CHURN_WINDOW_DAYS`] of `HEAD`'s ancestry. An unborn/empty
/// repo (no commits yet) returns a zeroed summary, not an error — matches
/// `dashboard.rs`'s own "empty repo is a normal state" convention.
///
/// BUG FIX: was a plain (non-async) `fn` — per `blocking.rs`'s doc comment,
/// that runs INLINE on Tauri's main thread, freezing the whole app window for
/// as long as the call takes. This command shells out to a single `git log`
/// walking up to [`MAX_SUMMARY_COMMITS`] commits with a `--name-only` block
/// per commit, which on a large/old repo can take real seconds — and it's
/// invoked on first-open of every repo (see `repo_registry::
/// claim_repo_summary_first_open`), so that stall lands right when the app
/// first shows a repo. `async fn` + `run_blocking` moves the walk onto
/// Tauri's blocking-task thread pool, matching `dashboard_repo_status`'s own
/// established fix.
///
/// JS: `commands.repoSummary(path)`.
#[tauri::command]
#[specta::specta]
pub async fn repo_summary(path: String) -> Result<RepoSummary, String> {
    crate::blocking::run_blocking(move || repo_summary_inner(&path)).await
}

fn repo_summary_inner(path: &str) -> Result<RepoSummary, String> {
    let repo = crate::trust::open_repo(path).map_err(|e| format!("cannot open repository: {}", e.message()))?;
    if repo.head().is_err() {
        return Ok(empty_summary());
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let since_secs = now - CHURN_WINDOW_DAYS * 86_400;
    let (y, m, d) = civil_from_unix(since_secs);
    let since_arg = format!("--since={y:04}-{m:02}-{d:02}");
    let max_count_arg = format!("--max-count={}", MAX_SUMMARY_COMMITS + 1);

    let out = run_git(
        path,
        &[
            "-c",
            "core.quotePath=false",
            "log",
            "--no-renames",
            &since_arg,
            "--format=%x00%H%x00%an%x00%ae%x00%at%x00%s%x00",
            "--name-only",
            &max_count_arg,
            "--end-of-options",
            "HEAD",
        ],
    )?;
    if !out.ok {
        return Err(git_msg(&out));
    }

    let mut records = parse_summary_output(&out.stdout);
    let truncated = records.len() > MAX_SUMMARY_COMMITS;
    if truncated {
        records.truncate(MAX_SUMMARY_COMMITS);
    }

    Ok(aggregate(records, truncated))
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

struct CommitRecord {
    author_name: String,
    author_email: String,
    at: i64,
    subject: String,
    files: Vec<String>,
}

/// Parse the NUL-delimited `--format` output combined with `--name-only` —
/// same "leading empty string, then N-groups-per-record" layout as
/// `file_history.rs`/`pickaxe.rs`, except the trailing group here is a
/// `--name-only` block (one touched path per line) rather than a
/// `--name-status` line or a throwaway terminator.
fn parse_summary_output(raw: &str) -> Vec<CommitRecord> {
    let mut parts = raw.split('\u{0}');
    parts.next(); // the empty string before the very first record's leading NUL
    let mut out = Vec::new();
    loop {
        match parts.next() {
            Some(s) if !s.is_empty() => {}
            _ => break,
        };
        let name = parts.next().unwrap_or("");
        let email = parts.next().unwrap_or("");
        let at: i64 = parts.next().unwrap_or("0").trim().parse().unwrap_or(0);
        let subject = parts.next().unwrap_or("");
        let files_block = parts.next().unwrap_or("");
        let files: Vec<String> =
            files_block.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect();

        out.push(CommitRecord {
            author_name: name.to_string(),
            author_email: email.to_string(),
            at,
            subject: subject.to_string(),
            files,
        });
    }
    out
}

// ---------------------------------------------------------------------------
// aggregation (pure, independently testable)
// ---------------------------------------------------------------------------

fn aggregate(records: Vec<CommitRecord>, truncated: bool) -> RepoSummary {
    let total_commits = records.len();

    let mut churn_counts: HashMap<String, usize> = HashMap::new();
    let mut bugfix_counts: HashMap<String, usize> = HashMap::new();
    let mut contributor_counts: HashMap<(String, String), usize> = HashMap::new();
    let mut monthly_counts: HashMap<String, usize> = HashMap::new();
    let mut revert_or_hotfix_commits = 0usize;

    for rec in &records {
        *contributor_counts.entry((rec.author_name.clone(), rec.author_email.clone())).or_insert(0) += 1;

        let (y, m, _d) = civil_from_unix(rec.at);
        *monthly_counts.entry(format!("{y:04}-{m:02}")).or_insert(0) += 1;

        let is_bugfix = subject_matches_bug_keywords(&rec.subject);
        let lower_subject = rec.subject.to_lowercase();
        if lower_subject.starts_with("revert ") || lower_subject.contains("hotfix") {
            revert_or_hotfix_commits += 1;
        }

        for f in &rec.files {
            *churn_counts.entry(f.clone()).or_insert(0) += 1;
            if is_bugfix {
                *bugfix_counts.entry(f.clone()).or_insert(0) += 1;
            }
        }
    }

    let mut churn: Vec<ChurnFile> =
        churn_counts.iter().map(|(path, &touches)| ChurnFile { path: path.clone(), touches }).collect();
    churn.sort_by(|a, b| b.touches.cmp(&a.touches).then_with(|| a.path.cmp(&b.path)));
    churn.truncate(TOP_CHURN_FILES);

    let mut contributors_full: Vec<Contributor> = contributor_counts
        .into_iter()
        .map(|((name, email), commits)| Contributor { name, email, commits })
        .collect();
    contributors_full.sort_by(|a, b| b.commits.cmp(&a.commits).then_with(|| a.name.cmp(&b.name)));
    let bus_factor = compute_bus_factor(&contributors_full, total_commits);
    contributors_full.truncate(TOP_CONTRIBUTORS);

    let mut monthly: Vec<MonthlyActivity> =
        monthly_counts.into_iter().map(|(month, commits)| MonthlyActivity { month, commits }).collect();
    monthly.sort_by(|a, b| a.month.cmp(&b.month));

    let mut problem_files: Vec<ProblemFile> = bugfix_counts
        .iter()
        .filter_map(|(path, &bugfix_touches)| {
            let total_touches = *churn_counts.get(path).unwrap_or(&0);
            if total_touches >= MIN_TOUCHES_FOR_PROBLEM_FILE {
                Some(ProblemFile { path: path.clone(), bugfix_touches, total_touches })
            } else {
                None
            }
        })
        .collect();
    problem_files.sort_by(|a, b| b.bugfix_touches.cmp(&a.bugfix_touches).then_with(|| a.path.cmp(&b.path)));
    problem_files.truncate(TOP_PROBLEM_FILES);

    RepoSummary {
        window_days: CHURN_WINDOW_DAYS,
        total_commits,
        truncated,
        churn,
        contributors: contributors_full,
        bus_factor,
        monthly,
        problem_areas: ProblemAreas { files: problem_files, revert_or_hotfix_commits, total_commits },
    }
}

/// Minimum number of top contributors (by commit count, already sorted desc)
/// whose cumulative commits reach [`BUS_FACTOR_THRESHOLD`] of `total_commits`.
fn compute_bus_factor(sorted_desc: &[Contributor], total_commits: usize) -> usize {
    if total_commits == 0 {
        return 0;
    }
    let threshold = total_commits as f64 * BUS_FACTOR_THRESHOLD;
    let mut cumulative = 0usize;
    for (i, c) in sorted_desc.iter().enumerate() {
        cumulative += c.commits;
        if cumulative as f64 >= threshold {
            return i + 1;
        }
    }
    sorted_desc.len()
}

/// Word-boundary (not substring) match against [`BUG_KEYWORDS`] — avoids
/// `"fix"` false-matching inside `"prefix"`/`"suffix"`/`"fixture"`.
fn subject_matches_bug_keywords(subject: &str) -> bool {
    let lower = subject.to_lowercase();
    lower.split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty()).any(|tok| BUG_KEYWORDS.contains(&tok))
}

/// Howard Hinnant's public-domain `civil_from_days` algorithm — converts a
/// Unix timestamp (seconds) to a proleptic-Gregorian `(year, month, day)`,
/// always UTC. See module doc for why this is hand-rolled instead of adding
/// a `chrono`/`time` dependency.
fn civil_from_unix(secs: i64) -> (i32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}

// ---------------------------------------------------------------------------
// git CLI runner (own copy — see module doc's "one small self-contained
// helper per module" convention)
// ---------------------------------------------------------------------------

struct Out {
    ok: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run_git(path: &str, args: &[&str]) -> Result<Out, String> {
    let o = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    Ok(Out {
        ok: o.status.success(),
        code: o.status.code(),
        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&o.stderr).trim().to_string(),
    })
}

fn git_msg(o: &Out) -> String {
    if !o.stderr.is_empty() {
        o.stderr.clone()
    } else {
        format!("git exited with status {:?}", o.code)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_from_unix_epoch() {
        assert_eq!(civil_from_unix(0), (1970, 1, 1));
    }

    #[test]
    fn civil_from_unix_leap_year_boundary() {
        assert_eq!(civil_from_unix(1_709_164_800), (2024, 2, 29));
        assert_eq!(civil_from_unix(1_709_251_200), (2024, 3, 1));
    }

    #[test]
    fn civil_from_unix_non_leap_century_and_leap_400_year() {
        // 1900 is NOT a leap year (divisible by 100 but not 400); 2000 IS
        // (divisible by 400) — the classic Gregorian edge case.
        assert_eq!(civil_from_unix(-2_208_988_800), (1900, 1, 1));
        assert_eq!(civil_from_unix(951_782_400), (2000, 2, 29));
    }

    #[test]
    fn civil_from_unix_before_epoch() {
        assert_eq!(civil_from_unix(-86_400), (1969, 12, 31));
    }

    #[test]
    fn civil_from_unix_spot_check() {
        assert_eq!(civil_from_unix(946_684_800), (2000, 1, 1));
        assert_eq!(civil_from_unix(1_592_179_200), (2020, 6, 15));
    }

    #[test]
    fn parse_summary_output_parses_multiple_records_with_name_only_blocks() {
        let raw = "\u{0}aaa\u{0}Ada\u{0}a@x.com\u{0}100\u{0}Fix the thing\u{0}\nsrc/a.rs\nsrc/b.rs\n\u{0}bbb\u{0}Bob\u{0}b@x.com\u{0}200\u{0}Add feature\u{0}\nsrc/a.rs\n";
        let records = parse_summary_output(raw);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].author_name, "Ada");
        assert_eq!(records[0].files, vec!["src/a.rs", "src/b.rs"]);
        assert_eq!(records[1].author_name, "Bob");
        assert_eq!(records[1].files, vec!["src/a.rs"]);
    }

    #[test]
    fn parse_summary_output_handles_a_commit_touching_no_files() {
        // An empty commit (e.g. `git commit --allow-empty`) has no name-only block.
        let raw = "\u{0}aaa\u{0}Ada\u{0}a@x.com\u{0}100\u{0}Empty commit\u{0}\n";
        let records = parse_summary_output(raw);
        assert_eq!(records.len(), 1);
        assert!(records[0].files.is_empty());
    }

    #[test]
    fn bug_keyword_matching_is_word_boundary_not_substring() {
        assert!(subject_matches_bug_keywords("Fix off-by-one error"));
        assert!(subject_matches_bug_keywords("BUG: crash on empty input"));
        assert!(!subject_matches_bug_keywords("Refactor prefix/suffix handling"));
        assert!(!subject_matches_bug_keywords("Add fixture data for tests"));
        assert!(subject_matches_bug_keywords("Revert \"Add feature\""));
    }

    fn rec(name: &str, email: &str, at: i64, subject: &str, files: &[&str]) -> CommitRecord {
        CommitRecord {
            author_name: name.to_string(),
            author_email: email.to_string(),
            at,
            subject: subject.to_string(),
            files: files.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn aggregate_ranks_churn_desc_with_alphabetical_tie_break() {
        let records = vec![
            rec("A", "a@x.com", 0, "one", &["a.rs", "b.rs"]),
            rec("A", "a@x.com", 100, "two", &["a.rs"]),
            rec("A", "a@x.com", 200, "three", &["b.rs"]),
        ];
        let summary = aggregate(records, false);
        assert_eq!(summary.churn[0].path, "a.rs");
        assert_eq!(summary.churn[0].touches, 2);
        assert_eq!(summary.churn[1].path, "b.rs");
        assert_eq!(summary.churn[1].touches, 2);
    }

    #[test]
    fn aggregate_bus_factor_one_dominant_contributor() {
        let records = vec![
            rec("A", "a@x.com", 0, "one", &[]),
            rec("A", "a@x.com", 1, "two", &[]),
            rec("A", "a@x.com", 2, "three", &[]),
            rec("B", "b@x.com", 3, "four", &[]),
        ];
        let summary = aggregate(records, false);
        assert_eq!(summary.bus_factor, 1); // A alone already covers >=50%
    }

    #[test]
    fn aggregate_bus_factor_evenly_split_needs_more_than_half_the_contributors() {
        let records = vec![
            rec("A", "a@x.com", 0, "one", &[]),
            rec("B", "b@x.com", 1, "two", &[]),
            rec("C", "c@x.com", 2, "three", &[]),
            rec("D", "d@x.com", 3, "four", &[]),
        ];
        let summary = aggregate(records, false);
        assert_eq!(summary.bus_factor, 2); // 2 of 4 equal contributors reach 50%
    }

    #[test]
    fn aggregate_monthly_buckets_chronologically() {
        let records = vec![
            rec("A", "a@x.com", 1_592_179_200, "one", &[]),  // 2020-06
            rec("A", "a@x.com", 946_684_800, "two", &[]),    // 2000-01
            rec("A", "a@x.com", 1_592_179_300, "three", &[]), // 2020-06 again
        ];
        let summary = aggregate(records, false);
        assert_eq!(summary.monthly.len(), 2);
        assert_eq!(summary.monthly[0].month, "2000-01");
        assert_eq!(summary.monthly[1].month, "2020-06");
        assert_eq!(summary.monthly[1].commits, 2);
    }

    #[test]
    fn aggregate_propagates_the_truncated_flag_unchanged() {
        // A cheap unit-level check that `truncated` (computed in
        // repo_summary_inner from the raw record count vs.
        // MAX_SUMMARY_COMMITS) survives aggregate() unmodified — a full
        // MAX_SUMMARY_COMMITS(20_000)-commit integration fixture to exercise
        // this end-to-end was empirically measured (own scratch probe) at
        // ~57s just to BUILD the commits, before even calling repo_summary —
        // far too slow to justify for a 3-line truncate()-then-flag pattern
        // this codebase already has proven test coverage for at a smaller
        // scale (see pickaxe.rs's own search_truncates_at_the_match_cap /
        // file_history.rs's history_truncates_at_the_commit_cap).
        assert!(aggregate(vec![], true).truncated);
        assert!(!aggregate(vec![], false).truncated);
    }

    #[test]
    fn aggregate_problem_files_filters_below_min_touches_and_tallies_revert_hotfix() {
        let records = vec![
            rec("A", "a@x.com", 0, "Fix bug in a.rs", &["a.rs"]),
            rec("A", "a@x.com", 1, "Fix another bug", &["a.rs"]),
            rec("A", "a@x.com", 2, "Fix yet another", &["a.rs"]),
            rec("A", "a@x.com", 3, "Fix rare one-off file", &["once.rs"]),
            rec("A", "a@x.com", 4, "Revert \"Add feature\"", &["a.rs"]),
            rec("A", "a@x.com", 5, "hotfix: patch prod", &["a.rs"]),
        ];
        let summary = aggregate(records, false);
        // a.rs touched 5 times total (all fix-flavored subjects here), >=3 threshold
        assert_eq!(summary.problem_areas.files.len(), 1);
        assert_eq!(summary.problem_areas.files[0].path, "a.rs");
        assert_eq!(summary.problem_areas.files[0].total_touches, 5);
        // once.rs has only 1 touch — filtered out by MIN_TOUCHES_FOR_PROBLEM_FILE
        assert_eq!(summary.problem_areas.revert_or_hotfix_commits, 2);
        assert_eq!(summary.problem_areas.total_commits, 6);
    }
}
