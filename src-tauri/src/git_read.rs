//! Read side of GitCat: open a repository and walk its commit DAG with libgit2.
//!
//! Reads only — mutations will go through the git CLI later (read/write split).

use git2::{Oid, Repository, Sort};
use std::collections::HashMap;

use crate::model::RefChip;

/// A raw commit pulled from the object DB, before layout.
pub struct RawCommit {
    pub id: Oid,
    pub parents: Vec<Oid>,
    pub subject: String,
    pub author: (String, String, i64),
    pub committer: (String, String, i64),
}

pub struct RepoRead {
    pub commits: Vec<RawCommit>,
    /// oid (as string) -> ref chips pointing at that commit
    pub refs: HashMap<String, Vec<RefChip>>,
}

/// Walk up to `limit` commits reachable from all branches + HEAD, most-recent
/// first — or, when `visible_local`/`visible_remote` are `Some`, only from
/// the NAMED local/remote branches + HEAD (the current branch always stays
/// reachable regardless of the filter — see [`push_head`]'s own call below).
///
/// `visible_local`/`visible_remote` are INDEPENDENT, each its own `None`
/// ("no filter for this kind — walk every branch of it, today's default") or
/// `Some` ("only these named branches of this kind" — an empty slice means
/// "none of this kind"). They are NOT required to agree: filtering local
/// branches while leaving every remote branch visible (or vice versa) is a
/// legitimate, expected combination, not an edge case.
///
/// [`push_head`]: git2::Revwalk::push_head
pub fn read_repo(
    path: &str,
    limit: usize,
    visible_local: Option<&[String]>,
    visible_remote: Option<&[String]>,
) -> Result<RepoRead, git2::Error> {
    let repo = crate::trust::open_repo(path)?;

    // --- ref chips: map each commit oid to the refs pointing at it ---
    let mut refs = collect_refs(&repo);
    filter_hidden_chips(&mut refs, visible_local, visible_remote);

    // --- revwalk: topological + time, seeded from every branch tip + HEAD,
    // or only the selected ones when a filter is active — independently per
    // kind, see this function's own doc comment ---
    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    match visible_local {
        // push_glob peels refs to their commit target; ignore globs that match nothing.
        None => {
            let _ = walk.push_glob("refs/heads/*");
        }
        Some(names) => {
            // push_ref on a stale/renamed/deleted branch name is ignored,
            // same tolerance push_glob already has for "matches nothing" —
            // a filter referencing a since-deleted branch shouldn't error.
            for name in names {
                let _ = walk.push_ref(&format!("refs/heads/{name}"));
            }
        }
    }
    match visible_remote {
        None => {
            let _ = walk.push_glob("refs/remotes/*");
        }
        Some(names) => {
            for name in names {
                let _ = walk.push_ref(&format!("refs/remotes/{name}"));
            }
        }
    }
    // Always pushed, filter or not — the current branch's commits must stay
    // reachable even if its own name isn't in the (or is explicitly excluded
    // from the) visible set.
    let _ = walk.push_head();

    let mut commits = Vec::with_capacity(limit.min(4096));
    for oid in walk {
        let oid = oid?;
        let c = repo.find_commit(oid)?;
        let a = c.author();
        let cm = c.committer();
        commits.push(RawCommit {
            id: oid,
            parents: c.parent_ids().collect(),
            subject: c.summary().unwrap_or("").to_string(),
            author: (
                a.name().unwrap_or("").to_string(),
                a.email().unwrap_or("").to_string(),
                a.when().seconds(),
            ),
            committer: (
                cm.name().unwrap_or("").to_string(),
                cm.email().unwrap_or("").to_string(),
                cm.when().seconds(),
            ),
        });
        if commits.len() >= limit {
            break;
        }
    }

    Ok(RepoRead { commits, refs })
}

/// Drop `"branch"`/`"remote"` chips for names NOT in the visible set —
/// independently per kind (a no-op for `"branch"` chips specifically when
/// `visible_local` is `None`, regardless of `visible_remote`'s own state,
/// and vice versa — see `read_repo`'s own doc comment on why the two are
/// independent). `"head"`/`"tag"` chips are never touched: HEAD's own chip
/// is unaffected by definition (the current branch is always visible), and
/// tags were never part of this filter's scope — they aren't walk roots
/// either, filtered or not. This keeps a hidden branch's label from
/// lingering on some ancestor commit that's still reachable via a visible
/// branch/HEAD.
fn filter_hidden_chips(
    refs: &mut HashMap<String, Vec<RefChip>>,
    visible_local: Option<&[String]>,
    visible_remote: Option<&[String]>,
) {
    if visible_local.is_none() && visible_remote.is_none() {
        return; // fast path: neither kind is filtered
    }
    let local_set: Option<std::collections::HashSet<&str>> =
        visible_local.map(|v| v.iter().map(String::as_str).collect());
    let remote_set: Option<std::collections::HashSet<&str>> =
        visible_remote.map(|v| v.iter().map(String::as_str).collect());
    for chips in refs.values_mut() {
        chips.retain(|c| match c.t.as_str() {
            "branch" => local_set.as_ref().is_none_or(|s| s.contains(c.n.as_str())),
            "remote" => remote_set.as_ref().is_none_or(|s| s.contains(c.n.as_str())),
            _ => true, // "head" | "tag" (or any future kind) — always keep
        });
    }
}

fn collect_refs(repo: &Repository) -> HashMap<String, Vec<RefChip>> {
    let mut map: HashMap<String, Vec<RefChip>> = HashMap::new();

    // Which branch is HEAD on? -> that ref chip is styled "head".
    let head_name = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    if let Ok(refs) = repo.references() {
        for r in refs.flatten() {
            // Peel to the commit this ref ultimately points at (handles annotated tags).
            let oid = match r.peel_to_commit() {
                Ok(c) => c.id(),
                Err(_) => continue,
            };
            let full = r.name().unwrap_or("");
            let (label, kind) = classify_ref(full, head_name.as_deref());
            if label.is_empty() {
                continue;
            }
            map.entry(oid.to_string())
                .or_default()
                .push(RefChip { n: label, t: kind });
        }
    }
    map
}

fn classify_ref(full: &str, head_name: Option<&str>) -> (String, String) {
    if let Some(name) = full.strip_prefix("refs/heads/") {
        let kind = if Some(name) == head_name { "head" } else { "branch" };
        (name.to_string(), kind.to_string())
    } else if let Some(name) = full.strip_prefix("refs/remotes/") {
        // drop the trailing HEAD symrefs like origin/HEAD
        if name.ends_with("/HEAD") {
            (String::new(), String::new())
        } else {
            (name.to_string(), "remote".to_string())
        }
    } else if let Some(name) = full.strip_prefix("refs/tags/") {
        (name.to_string(), "tag".to_string())
    } else {
        (String::new(), String::new())
    }
}
