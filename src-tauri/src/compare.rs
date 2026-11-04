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
//!
//! ENDPOINTS ARE ANY REVISION, not just a commit oid: the graph passes full
//! oids, while the sidebar's "Compare with current branch" passes `HEAD` and
//! a fully qualified ref (`refs/heads/x`, `refs/tags/v1`), so a branch or tag
//! name that happens to look like a sha prefix can't be misread as one.
//!
//! TWO KINDS OF DIFF for a diverged pair (`RangeDiff::since_fork`): the
//! direct one between the two tips (`git diff A B`), and "what `to` did since
//! the fork" (`git diff A...B`, i.e. merge base → `to`). The second is the
//! one a reviewer wants for "what would merging this branch bring in": the
//! direct diff also shows everything `from` did since the fork, reversed.

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

/// Resolve one endpoint to its commit. Any revision git understands — see
/// the module doc.
fn resolve<'r>(repo: &'r git2::Repository, rev: &str) -> Result<git2::Commit<'r>, String> {
    repo.revparse_single(rev)
        .and_then(|o| o.peel_to_commit())
        .map_err(|e| ierrp("err_misc.not_a_valid_commit", &[("rev", &format!("{rev:?}")), ("detail", e.message())]))
}

/// The two endpoints in reading order, and how they relate. The ONE place
/// the pair is ordered: the summary and the diff each ordered it themselves
/// once, and drifted — for a diverged pair the summary kept the caller's
/// order while the diff swapped it, so the popover's "+12 −3" described a
/// diff that then opened the other way round.
struct Ordered<'r> {
    from: git2::Commit<'r>,
    to: git2::Commit<'r>,
    /// Commits on `to` but not `from`, and the reverse.
    ahead: usize,
    behind: usize,
    linear: bool,
    /// `None` for unrelated histories, which have no common ancestor.
    merge_base: Option<git2::Oid>,
}

fn order<'r>(repo: &'r git2::Repository, a: &str, b: &str) -> Result<Ordered<'r>, String> {
    let ca = resolve(repo, a)?;
    let cb = resolve(repo, b)?;

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
    // i.e. `a` is an ancestor of `b`. A diverged pair keeps the caller's
    // order: `a` is the anchor (the selected commit, or HEAD from the
    // sidebar), so "since the fork" means what `b` did.
    //
    // `ahead`/`behind` are bound to the ORDERING in the same expression on
    // purpose: computed separately they are trivially mismatched (`ahead` must
    // always mean "on `to`, not on `from`", which flips with the pair).
    let linear = ahead_a == 0 || ahead_b == 0;
    let (from, to, ahead, behind) = if ahead_a == 0 {
        (ca, cb, ahead_b, ahead_a) // a is an ancestor of b
    } else if ahead_b == 0 {
        (cb, ca, ahead_a, ahead_b) // b is an ancestor of a
    } else {
        (ca, cb, ahead_b, ahead_a) // diverged — keep the caller's order
    };
    Ok(Ordered { from, to, ahead, behind, linear, merge_base })
}

fn short_oid(o: git2::Oid) -> String {
    let s = o.to_string();
    s[..7.min(s.len())].to_string()
}

/// `pub` so the integration suite drives the real logic against a real repo
/// without an async runtime or an `AppHandle` — same reason
/// `plugin_registry::install_from` and `repo_registry::load_from` are `pub`.
pub fn commit_range_summary_inner(path: &str, a: &str, b: &str) -> Result<RangeSummary, String> {
    let repo = crate::trust::open_repo(path)
        .map_err(|e| ierrp("err_misc.cannot_open_repo", &[("detail", e.message())]))?;
    let Ordered { from, to, ahead, behind, linear, merge_base } = order(&repo, a, b)?;
    let (from, to) = (&from, &to);

    let from_tree = from.tree().map_err(|e| e.message().to_string())?;
    let to_tree = to.tree().map_err(|e| e.message().to_string())?;
    let mut opts = git2::DiffOptions::new();
    // No context lines: only the totals are wanted, and asking libgit2 for
    // context it will never render is wasted work.
    opts.context_lines(0).include_typechange(true);
    let diff = repo
        .diff_tree_to_tree(Some(&from_tree), Some(&to_tree), Some(&mut opts))
        .map_err(|e| e.message().to_string())?;
    // Line totals read blob content; a partial clone fetches it first.
    crate::promisor::ensure_blobs(&repo, crate::promisor::diff_blob_oids(&diff))?;
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
            commits.push(RangeCommit { sha: short_oid(oid), subject: c.summary().unwrap_or("").to_string() });
        }
    }

    Ok(RangeSummary {
        from: short_oid(from.id()),
        to: short_oid(to.id()),
        merge_base: merge_base.map(short_oid),
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

/// The actual diff between the two endpoints, not just its totals.
///
/// Same `FileChange` rows a commit's own detail panel renders — produced by the
/// SAME [`crate::commands::diff_trees`], which was extracted from
/// `commit_detail_inner` for this. A second copy of that loop (rename/copy
/// detection, binary handling, the per-file and whole-diff caps) would have
/// drifted from the original one fix at a time.
#[derive(Serialize, specta::Type, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RangeDiff {
    /// Short shas, ORDERED the same way [`RangeSummary`] orders them, so the
    /// diff reads forwards in time regardless of which endpoint was clicked.
    /// With `since_fork`, `from` is the merge base.
    pub from: String,
    pub to: String,
    /// Full oids of the same two trees, for opening one file of this diff in
    /// the external diff tool (`open_diff_tool`'s `from_rev`/`to_rev`).
    pub from_oid: String,
    pub to_oid: String,
    /// The pair diverged and shares a merge base, so a since-the-fork diff
    /// exists and differs from the direct one. The modal offers the toggle
    /// only then.
    pub can_since_fork: bool,
    /// This diff is merge base → `to` (`git diff A...B`), not tip to tip.
    pub since_fork: bool,
    pub files_changed: u32,
    pub additions: u32,
    pub deletions: u32,
    /// Capped like a commit's own detail is; the frontend says so when set.
    pub truncated: bool,
    pub file_tree: Vec<crate::model::FileChange>,
}

/// The full diff between two commits. Read-only.
///
/// Split from [`commit_range_summary`] rather than folded into it: the summary
/// opens a popover on every compare and wants to be cheap (one `Diff::stats`,
/// no per-file patches), while this builds a `Patch` per file and is only
/// asked for when the user actually opens the diff.
///
/// JS: `commands.commitRangeDiff(path, a, b, sinceFork)` -> `Result<RangeDiff, string>`.
///
/// `since_fork` asks for merge base → `to` instead of tip to tip. It is
/// ignored where it would mean nothing: a linear pair (the merge base IS
/// `from`) and unrelated histories (there is no merge base).
#[tauri::command]
#[specta::specta]
pub async fn commit_range_diff(path: String, a: String, b: String, since_fork: bool) -> Result<RangeDiff, String> {
    crate::blocking::run_blocking(move || commit_range_diff_inner(&path, &a, &b, since_fork)).await
}

/// `pub` for the integration suite, same reason as [`commit_range_summary_inner`].
pub fn commit_range_diff_inner(path: &str, a: &str, b: &str, since_fork: bool) -> Result<RangeDiff, String> {
    let repo = crate::trust::open_repo(path)
        .map_err(|e| ierrp("err_misc.cannot_open_repo", &[("detail", e.message())]))?;
    // The SAME ordering as the summary, so the popover's "+12 −3" and the
    // diff the user then opens can never disagree about which way round it is.
    let o = order(&repo, a, b)?;
    let can_since_fork = !o.linear && o.merge_base.is_some();
    let since_fork = since_fork && can_since_fork;
    let base;
    let (from, to) = match o.merge_base {
        Some(mb) if since_fork => {
            base = repo.find_commit(mb).map_err(|e| e.message().to_string())?;
            (&base, &o.to)
        }
        _ => (&o.from, &o.to),
    };

    let from_tree = from.tree().map_err(|e| e.message().to_string())?;
    let to_tree = to.tree().map_err(|e| e.message().to_string())?;
    let d = crate::commands::diff_trees(&repo, Some(&from_tree), Some(&to_tree))
        .map_err(|e| e.message().to_string())?;

    Ok(RangeDiff {
        from: short_oid(from.id()),
        to: short_oid(to.id()),
        from_oid: from.id().to_string(),
        to_oid: to.id().to_string(),
        can_since_fork,
        since_fork,
        files_changed: d.file_tree.len() as u32,
        additions: d.additions as u32,
        deletions: d.deletions as u32,
        truncated: d.truncated,
        file_tree: d.file_tree,
    })
}
