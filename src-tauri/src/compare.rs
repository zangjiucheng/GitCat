//! Compare two commits (#49): the net delta between them, plus the commits in
//! between when one is an ancestor of the other.
//!
//! Read/write split: PURE READ — never calls `crate::safety::snapshot`.
//!
//! WHAT "LINES CHANGED" MEANS HERE, and why. This reports the NET delta — one
//! `diff_tree_to_tree` between the two endpoints — not cumulative per-commit
//! churn. A line edited three times and then reverted counts as zero, which is
//! what "what is different between these two points" means and what a reviewer
//! reaching for this is asking. Cumulative churn is a different number and a
//! much more expensive one (a diff per commit in the range, not one diff), so
//! it is deliberately not what this returns.
//!
//! WHY git2 AND NOT SHELLING OUT: every primitive this needs already exists as
//! a single libgit2 call that avoids materializing history —
//! `Repository::merge_base` (one call, no walk), `graph_ahead_behind` (git2's
//! own count-between, already used for branch-vs-upstream in git_write.rs), and
//! `Diff::stats` (totals without building a Patch per file, unlike the
//! per-delta `line_stats()` accumulation `commit_detail_inner` needs because it
//! also renders every hunk).
//!
//! THE COMMIT LIST IS CAPPED. A range can be the entire history of a large
//! repo; the popup that renders it cannot be. The walk stops at
//! [`MAX_RANGE_COMMITS`] + 1 so the caller can be told it was trimmed rather
//! than silently shown a partial chain.

use crate::i18n_err::ierrp;
use serde::Serialize;

/// How many commits the range list will return before reporting `truncated`.
///
/// Small on purpose — this feeds a cursor-anchored popup, not a scrollable
/// history view, and a user comparing two points thousands of commits apart
/// wants the counts, not five thousand rows. Contrast `MAX_LIVE_COMMITS`
/// (500_000) in commands.rs, which backs the actual graph.
const MAX_RANGE_COMMITS: usize = 500;

/// One row of the linear subgraph: short sha + subject, nothing else. The popup
/// draws a plain vertical list, so lane/colour data would be unused weight.
#[derive(Serialize, specta::Type, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RangeCommit {
    pub sha: String,
    pub subject: String,
}

/// The answer to "what happened between these two commits".
#[derive(Serialize, specta::Type, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RangeSummary {
    /// Short shas of the two endpoints, ORDERED: when one is an ancestor of the
    /// other, `from` is the ancestor, so the diff reads forwards in time no
    /// matter which one the user right-clicked. When they diverge the caller's
    /// own order is kept.
    pub from: String,
    pub to: String,
    /// Short sha of the merge base, or `None` when the two share no ancestor at
    /// all (separate root commits — `git checkout --orphan`, a grafted import).
    /// The delta below is still computed and still meaningful in that case.
    pub merge_base: Option<String>,
    /// One endpoint is an ancestor of the other, so the range is a single
    /// chain. Only then is `commits` populated — see the module doc.
    pub linear: bool,
    /// Commits reachable from `to` but not `from`, and vice versa. Together
    /// they describe the fork when the two diverge; one of them is 0 when
    /// linear.
    pub ahead: u32,
    pub behind: u32,
    /// Net delta between the two endpoint trees.
    pub files_changed: u32,
    pub additions: u32,
    pub deletions: u32,
    /// The chain, newest first (the graph's own order). Empty when diverged.
    pub commits: Vec<RangeCommit>,
    /// The chain was longer than [`MAX_RANGE_COMMITS`] and has been trimmed.
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// Tauri command (registered in lib.rs)
// ---------------------------------------------------------------------------

/// Summarize the range between two commits. Read-only.
///
/// JS: `commands.commitRangeSummary(path, a, b)` -> `Result<RangeSummary, string>`.
///
/// `async fn` + `run_blocking` for the same reason as every other repo-touching
/// command here: `graph_ahead_behind` walks the commit graph and the tree diff
/// walks two trees, and neither belongs on the thread driving the window.
#[tauri::command]
#[specta::specta]
pub async fn commit_range_summary(path: String, a: String, b: String) -> Result<RangeSummary, String> {
    crate::blocking::run_blocking(move || commit_range_summary_inner(&path, &a, &b)).await
}

/// `pub` so the integration suite drives the real logic against a real repo
/// without an async runtime or an `AppHandle` — same reason
/// `plugin_registry::install_from` and `repo_registry::load_from` are `pub`.
pub fn commit_range_summary_inner(path: &str, a: &str, b: &str) -> Result<RangeSummary, String> {
    let repo = crate::trust::open_repo(path)
        .map_err(|e| ierrp("err_misc.cannot_open_repo", &[("detail", e.message())]))?;
    let find = |rev: &str| {
        repo.find_commit_by_prefix(rev)
            .map_err(|e| ierrp("err_misc.not_a_valid_commit", &[("rev", &format!("{rev:?}")), ("detail", e.message())]))
    };
    let ca = find(a)?;
    let cb = find(b)?;

    // One call, no walk. `Err` here is the unrelated-histories case, not a
    // failure — two roots genuinely have no common ancestor.
    let merge_base = repo.merge_base(ca.id(), cb.id()).ok();

    // git2's own count-between: counts without building a sha list. Unrelated
    // histories still count (each side's whole history), which is why this is
    // not gated on merge_base being Some.
    let (ahead_a, ahead_b) = repo
        .graph_ahead_behind(ca.id(), cb.id())
        .map_err(|e| e.message().to_string())?;

    // Order by ancestry when there is one, so the delta always reads forwards
    // in time regardless of which endpoint the user right-clicked. `ahead_a ==
    // 0` means nothing is reachable from `a` that is not reachable from `b`,
    // i.e. `a` is an ancestor of `b`.
    //
    // `ahead`/`behind` are bound to the ORDERING in the same expression on
    // purpose: computed separately they are trivially mismatched (`ahead` must
    // always mean "on `to`, not on `from`", which flips with the pair).
    let linear = ahead_a == 0 || ahead_b == 0;
    let (from, to, ahead, behind) = if ahead_a == 0 {
        (&ca, &cb, ahead_b, ahead_a) // a is an ancestor of b
    } else if ahead_b == 0 {
        (&cb, &ca, ahead_a, ahead_b) // b is an ancestor of a
    } else {
        (&ca, &cb, ahead_b, ahead_a) // diverged — keep the caller's order
    };

    let from_tree = from.tree().map_err(|e| e.message().to_string())?;
    let to_tree = to.tree().map_err(|e| e.message().to_string())?;
    let mut opts = git2::DiffOptions::new();
    // No context lines: only the totals are wanted, and asking libgit2 for
    // context it will never render is wasted work.
    opts.context_lines(0).include_typechange(true);
    let diff = repo
        .diff_tree_to_tree(Some(&from_tree), Some(&to_tree), Some(&mut opts))
        .map_err(|e| e.message().to_string())?;
    let stats = diff.stats().map_err(|e| e.message().to_string())?;

    // The chain, only when there is one. A diverged pair has two legs and the
    // popup draws a single list, so it reports the fork counts instead of a
    // list that would silently show one leg as if it were the whole range.
    let mut commits: Vec<RangeCommit> = Vec::new();
    let mut truncated = false;
    if linear && from.id() != to.id() {
        let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
        walk.push(to.id()).map_err(|e| e.message().to_string())?;
        walk.hide(from.id()).map_err(|e| e.message().to_string())?;
        // Reachability, not dates — same reason ancestors_of skips the costlier
        // default time-sort.
        walk.set_sorting(git2::Sort::TOPOLOGICAL).map_err(|e| e.message().to_string())?;

        // MAX + 1 so hitting the cap is distinguishable from exactly filling it.
        for oid in walk.take(MAX_RANGE_COMMITS + 1) {
            let oid = oid.map_err(|e| e.message().to_string())?;
            if commits.len() == MAX_RANGE_COMMITS {
                truncated = true;
                break;
            }
            let c = repo.find_commit(oid).map_err(|e| e.message().to_string())?;
            let full = oid.to_string();
            commits.push(RangeCommit {
                sha: full[..7.min(full.len())].to_string(),
                subject: c.summary().unwrap_or("").to_string(),
            });
        }
    }

    let short = |c: &git2::Commit| {
        let s = c.id().to_string();
        s[..7.min(s.len())].to_string()
    };
    Ok(RangeSummary {
        from: short(from),
        to: short(to),
        merge_base: merge_base.map(|o| {
            let s = o.to_string();
            s[..7.min(s.len())].to_string()
        }),
        linear,
        ahead: ahead as u32,
        behind: behind as u32,
        files_changed: stats.files_changed() as u32,
        additions: stats.insertions() as u32,
        deletions: stats.deletions() as u32,
        commits,
        truncated,
    })
}
