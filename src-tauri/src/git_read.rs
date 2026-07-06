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

/// Walk up to `limit` commits reachable from all branches + HEAD, most-recent first.
pub fn read_repo(path: &str, limit: usize) -> Result<RepoRead, git2::Error> {
    let repo = Repository::open(path)?;

    // --- ref chips: map each commit oid to the refs pointing at it ---
    let refs = collect_refs(&repo);

    // --- revwalk: topological + time, seeded from every branch tip + HEAD ---
    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    // push_glob peels refs to their commit target; ignore globs that match nothing.
    let _ = walk.push_glob("refs/heads/*");
    let _ = walk.push_glob("refs/remotes/*");
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
