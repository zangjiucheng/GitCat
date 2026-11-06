//! Where a commit is: on the current branch or not, which branches and tags
//! contain it, and — when it isn't on the current branch — whether its change
//! landed there anyway as a different commit (a cherry-pick, or the same
//! patch rebased).
//!
//! Read/write split: PURE READ — never calls `crate::safety::snapshot`.
//!
//! THREE QUESTIONS, THREE COSTS.
//! - "On the current branch?" is one `graph_descendant_of`.
//! - "Which refs contain it?" is `git for-each-ref --contains`, not a git2
//!   loop over every ref: git uses the commit-graph's generation numbers to
//!   prune the walk, which matters in a repo with thousands of refs.
//! - "Is its change already here?" only runs when the first answer is no. It
//!   looks at the commits on HEAD that the selected one can't reach (what
//!   `git cherry HEAD <sha>` would compare against), capped at
//!   [`MAX_SCAN`]:
//!   * a `(cherry picked from commit <sha>)` trailer naming the selected
//!     commit, which `git cherry-pick -x` writes — or the selected commit's
//!     own trailer naming a commit that is on HEAD;
//!   * otherwise an equal patch id (`git patch-id --stable`'s notion of "the
//!     same change", via libgit2's `git_diff_patchid`). Commits with the same
//!     subject are compared first, since that is what a cherry-pick or rebase
//!     usually keeps. Skipped in a partial clone: every diff would fetch
//!     blobs from the promisor remote.

use crate::i18n_err::ierrp;
use crate::procutil::{git_timeout, run_with, RunOptions};
use git2::{Oid, Repository};
use serde::Serialize;

/// How many refs come back by name. The rest are counted (`total_refs`):
/// a commit on a long-lived trunk is in every branch cut after it.
const MAX_REFS: usize = 50;

/// How many commits on HEAD are checked for a copy of the selected one.
const MAX_SCAN: usize = 2000;

#[derive(Serialize, specta::Type, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContainRef {
    /// Short name: `main`, `origin/main`, `v1.0`.
    pub name: String,
    /// "local" | "remote" | "tag".
    pub kind: String,
}

#[derive(Serialize, specta::Type, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EquivalentCommit {
    pub sha: String,
    pub subject: String,
    /// "trailer": a `(cherry picked from commit …)` line links the two.
    /// "patch": no link, but the change is identical.
    pub how: String,
}

#[derive(Serialize, specta::Type, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Containment {
    /// HEAD contains the commit (or is it).
    pub on_head: bool,
    /// The current branch's name; `None` when HEAD is detached or unborn.
    pub head: Option<String>,
    /// Local branches, then remote ones, then tags, each A-Z; at most
    /// [`MAX_REFS`].
    pub refs: Vec<ContainRef>,
    pub total_refs: u32,
    /// Only looked for when `on_head` is false.
    pub equivalent: Option<EquivalentCommit>,
    /// HEAD had more commits to check than [`MAX_SCAN`] and none of the
    /// checked ones matched, so "no copy" is not a definite answer.
    pub scan_capped: bool,
    /// The patch comparison was skipped (partial clone); only trailers were
    /// checked.
    pub patch_skipped: bool,
}

/// JS: `commands.commitContainment(path, sha)` -> `Result<Containment, string>`.
#[tauri::command]
#[specta::specta]
pub async fn commit_containment(path: String, sha: String) -> Result<Containment, String> {
    crate::blocking::run_blocking(move || commit_containment_inner(&path, &sha)).await
}

/// `pub` for the integration suite (tests/containment.rs).
pub fn commit_containment_inner(path: &str, sha: &str) -> Result<Containment, String> {
    let repo = crate::trust::open_repo(path)
        .map_err(|e| ierrp("err_misc.cannot_open_repo", &[("detail", e.message())]))?;
    let target = repo
        .revparse_single(sha)
        .and_then(|o| o.peel_to_commit())
        .map_err(|e| ierrp("err_misc.not_a_valid_commit", &[("rev", &format!("{sha:?}")), ("detail", e.message())]))?;
    let t = target.id();

    let head_ref = repo.head().ok();
    let head = head_ref.as_ref().filter(|r| r.is_branch()).and_then(|r| r.shorthand().map(str::to_string));
    let head_oid = head_ref.as_ref().and_then(|r| r.target());
    let on_head = match head_oid {
        Some(h) => h == t || repo.graph_descendant_of(h, t).map_err(|e| e.message().to_string())?,
        None => false, // unborn: nothing is on it
    };

    let (refs, total_refs) = containing_refs(path, &t.to_string())?;

    let mut equivalent = None;
    let mut scan_capped = false;
    let mut patch_skipped = false;
    if let (false, Some(h)) = (on_head, head_oid) {
        let found = find_copy(&repo, &target, h)?;
        equivalent = found.0;
        scan_capped = found.1;
        patch_skipped = found.2;
    }

    Ok(Containment { on_head, head, refs, total_refs, equivalent, scan_capped, patch_skipped })
}

/// Refs whose history includes `oid`, classified and capped.
fn containing_refs(path: &str, oid: &str) -> Result<(Vec<ContainRef>, u32), String> {
    let contains = format!("--contains={oid}");
    let args = [
        "for-each-ref",
        &contains,
        // A symbolic ref (`refs/remotes/origin/HEAD`) would repeat the branch
        // it points at; `%(symref)` is non-empty for those, so they're dropped.
        "--format=%(refname)%00%(symref)",
        "refs/heads",
        "refs/remotes",
        "refs/tags",
    ];
    let cmd = crate::wsl::git_command(path, &args);
    let opts = RunOptions { timeout: git_timeout(&args), ..Default::default() };
    let o = run_with(cmd, opts).map_err(|e| e.to_ierr("err_tools.could_not_run_git"))?;
    if !o.status.success() {
        return Err(String::from_utf8_lossy(&o.stderr).trim().to_string());
    }
    let mut all: Vec<ContainRef> = String::from_utf8_lossy(&o.stdout)
        .lines()
        .filter_map(|l| {
            let (name, symref) = l.split_once('\0').unwrap_or((l, ""));
            if !symref.is_empty() {
                return None;
            }
            let (kind, short) = if let Some(s) = name.strip_prefix("refs/heads/") {
                ("local", s)
            } else if let Some(s) = name.strip_prefix("refs/remotes/") {
                ("remote", s)
            } else {
                ("tag", name.strip_prefix("refs/tags/")?)
            };
            Some(ContainRef { name: short.to_string(), kind: kind.to_string() })
        })
        .collect();
    let rank = |k: &str| match k {
        "local" => 0,
        "remote" => 1,
        _ => 2,
    };
    all.sort_by(|a, b| rank(&a.kind).cmp(&rank(&b.kind)).then_with(|| a.name.cmp(&b.name)));
    let total = all.len() as u32;
    all.truncate(MAX_REFS);
    Ok((all, total))
}

/// The `<sha>`s named by `(cherry picked from commit <sha>)` lines.
fn picked_from(message: &str) -> impl Iterator<Item = &str> {
    message.lines().filter_map(|l| {
        let s = l.trim().strip_prefix("(cherry picked from commit ")?.strip_suffix(')')?;
        (s.len() >= 7 && s.bytes().all(|b| b.is_ascii_hexdigit())).then_some(s)
    })
}

fn patch_id(repo: &Repository, c: &git2::Commit) -> Result<Option<Oid>, git2::Error> {
    if c.parent_count() > 1 {
        return Ok(None); // a merge has no single patch
    }
    let parent_tree = match c.parent(0) {
        Ok(p) => Some(p.tree()?),
        Err(_) => None, // root commit: everything is added
    };
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&c.tree()?), None)?;
    if diff.deltas().len() == 0 {
        return Ok(None); // an empty commit matches nothing meaningfully
    }
    diff.patchid(None).map(Some)
}

/// Look on HEAD for a copy of `target`. Returns (copy, scan capped, patch
/// comparison skipped).
fn find_copy(repo: &Repository, target: &git2::Commit, head: Oid) -> Result<(Option<EquivalentCommit>, bool, bool), String> {
    let err = |e: git2::Error| e.message().to_string();
    let found = |c: &git2::Commit, how: &str| EquivalentCommit {
        sha: c.id().to_string(),
        subject: c.summary().unwrap_or("").to_string(),
        how: how.to_string(),
    };

    // The selected commit is itself the copy: its trailer names a commit
    // that is on HEAD.
    for s in picked_from(target.message().unwrap_or("")) {
        if let Ok(orig) = repo.revparse_single(s).and_then(|o| o.peel_to_commit()) {
            if orig.id() == head || repo.graph_descendant_of(head, orig.id()).unwrap_or(false) {
                return Ok((Some(found(&orig, "trailer")), false, false));
            }
        }
    }

    // HEAD's side of the fork: what HEAD has that the selected commit doesn't.
    let mut walk = repo.revwalk().map_err(err)?;
    walk.push(head).map_err(err)?;
    walk.hide(target.id()).map_err(err)?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL).map_err(err)?;
    let mut candidates = Vec::new();
    let mut capped = false;
    for oid in walk {
        if candidates.len() == MAX_SCAN {
            capped = true;
            break;
        }
        candidates.push(repo.find_commit(oid.map_err(err)?).map_err(err)?);
    }

    let full = target.id().to_string();
    if let Some(c) = candidates.iter().find(|c| picked_from(c.message().unwrap_or("")).any(|s| full.starts_with(s))) {
        return Ok((Some(found(c, "trailer")), false, false));
    }

    if crate::promisor::is_partial_clone(repo) {
        return Ok((None, capped, true));
    }
    let Some(want) = patch_id(repo, target).map_err(err)? else {
        return Ok((None, capped, false));
    };
    // Same subject first: the likely match, and usually the only diff needed.
    let subject = target.summary().unwrap_or("");
    let (likely, rest): (Vec<_>, Vec<_>) = candidates.iter().partition(|c| c.summary().unwrap_or("") == subject);
    for c in likely.into_iter().chain(rest) {
        if patch_id(repo, c).map_err(err)? == Some(want) {
            return Ok((Some(found(c, "patch")), false, false));
        }
    }
    Ok((None, capped, false))
}

#[cfg(test)]
mod tests {
    use super::picked_from;

    #[test]
    fn picked_from_reads_cherry_pick_trailers_only() {
        let msg = "Fix it\n\nbody\n(cherry picked from commit 0123456789abcdef0123456789abcdef01234567)\n";
        assert_eq!(picked_from(msg).collect::<Vec<_>>(), ["0123456789abcdef0123456789abcdef01234567"]);
        assert_eq!(picked_from("(cherry picked from commit nothex!)").count(), 0);
        assert_eq!(picked_from("mentions (cherry picked from commit abc) inline").count(), 0);
    }
}
