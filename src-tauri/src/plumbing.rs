//! Plumbing playground (M5b) — read-only inspection of any git object by
//! rev/sha/ref: commit, tree, blob, or annotated tag.
//!
//! Read/write split: this module is PURE READ. It uses git2 exclusively (like
//! git_read.rs / conflict_status), never shells out, and never calls
//! `crate::safety::snapshot` — there is no mutation of any kind to protect
//! against, so a pre-op backup would be meaningless overhead. `revparse_single`
//! accepts ordinary git rev syntax (a full/short sha, a branch or tag name,
//! `HEAD`, `HEAD~2`, `HEAD^{tree}`, …) so this doubles as a small rev-parse
//! sandbox for power users.

use git2::{ObjectType, Signature};
use serde::Serialize;

/// Blob text is capped to this many lines (mirrors conflict.rs CAP_LINES) so a
/// vendored/generated blob can't blow up the payload.
const CAP_LINES: usize = 400;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// One author/tagger/committer identity. `time` is unix seconds.
#[derive(Serialize, specta::Type, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlumbingPerson {
    pub name: String,
    pub email: String,
    pub time: i64,
}

/// One entry inside a tree listing.
#[derive(Serialize, specta::Type, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntryRow {
    pub name: String,
    /// Octal file mode as git prints it, e.g. `"100644"`, `"100755"`,
    /// `"040000"`, `"120000"` (symlink), `"160000"` (submodule/gitlink).
    pub mode: String,
    /// `"blob"` | `"tree"` | `"commit"` (submodule) — whatever the entry's
    /// object type resolves to.
    pub kind: String,
    pub oid: String,
}

#[derive(Serialize, specta::Type, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitObject {
    pub sha: String,
    pub short_sha: String,
    pub author: PlumbingPerson,
    pub committer: PlumbingPerson,
    pub parents: Vec<String>,
    pub tree: String,
    pub message: String,
}

#[derive(Serialize, specta::Type, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TreeObject {
    pub sha: String,
    pub entries: Vec<TreeEntryRow>,
}

#[derive(Serialize, specta::Type, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlobObject {
    pub sha: String,
    pub size: usize,
    pub is_binary: bool,
    /// UTF-8-lossy content capped to [`CAP_LINES`] lines; `None` for a binary
    /// blob (only `size` is reported).
    pub content: Option<String>,
    pub truncated: bool,
}

#[derive(Serialize, specta::Type, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TagObject {
    pub sha: String,
    pub name: String,
    pub tagger: Option<PlumbingPerson>,
    pub message: String,
    pub target_oid: String,
    pub target_kind: String,
}

/// Whatever `revparse_single` resolved `rev` to. Internally tagged on `kind`
/// (verified empirically against specta 2.0.0-rc.22 — this generates a clean
/// discriminated TS union, each variant's fields flattened alongside the
/// `kind` tag, e.g. `{ kind: "commit", sha, shortSha, … }`).
#[derive(Serialize, specta::Type, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PlumbingObject {
    Commit(CommitObject),
    Tree(TreeObject),
    Blob(BlobObject),
    Tag(TagObject),
}

// ---------------------------------------------------------------------------
// Command: plumbing_inspect (READ — git2 only, no mutation, no snapshot)
// ---------------------------------------------------------------------------

/// Resolve `rev` (sha / short-sha / branch / tag / `HEAD~2` / `HEAD^{tree}` /
/// … — ordinary git rev syntax) and report a detail view of whatever object it
/// names. JS: `invoke("plumbing_inspect", { path, rev })`.
///
/// BUG FIX: was a plain (non-async) `fn` — it opens the repository via git2
/// and calls `revparse_single`, which for a `HEAD~N`/tree/tag walk has to
/// read and parse objects off disk, all inline on Tauri's main thread. That
/// froze the entire app window for as long as the resolve+peel took, not
/// just this playground panel, especially over a WSL/UNC-bridged repo where
/// each object read pays cross-filesystem latency. `async fn` + `run_blocking`
/// moves the work onto Tauri's blocking-task thread pool, matching
/// `workdir_status`'s own fix.
#[tauri::command]
#[specta::specta]
pub async fn plumbing_inspect(path: String, rev: String) -> Result<PlumbingObject, String> {
    crate::blocking::run_blocking(move || plumbing_inspect_inner(path, rev)).await
}

fn plumbing_inspect_inner(path: String, rev: String) -> Result<PlumbingObject, String> {
    // Local-validation-first (SYNTHESIS FIX vs. the reviewed draft, which
    // opened the repo before this check — this order matches this fn's own
    // doc/contract that an empty rev never touches git2 at all, and gives a
    // clearer message when BOTH `path` is bad and `rev` is empty).
    if rev.trim().is_empty() {
        return Err("Enter a rev, sha, or ref to inspect.".to_string());
    }
    let repo =
        crate::trust::open_repo(&path).map_err(|e| format!("cannot open repository: {}", e.message()))?;
    let obj = repo
        .revparse_single(&rev)
        .map_err(|e| format!("Not a valid rev in this repository: {rev:?} ({})", e.message()))?;

    match obj.kind() {
        Some(ObjectType::Commit) => {
            let c = obj.peel_to_commit().map_err(|e| e.message().to_string())?;
            let sha = c.id().to_string();
            // Bind these as owned values (not inline in the struct literal): the
            // borrow checker's temporary-scope rules would otherwise try to keep
            // `c.author()`'s temporary Signature alive past `c` itself, since
            // both are dropped at the end of this match arm's block.
            let author = person(&c.author());
            let committer = person(&c.committer());
            let parents = c.parent_ids().map(|o| o.to_string()).collect();
            let tree = c.tree_id().to_string();
            let message = lossy(c.message_raw_bytes());
            Ok(PlumbingObject::Commit(CommitObject {
                short_sha: short(&sha),
                sha,
                author,
                committer,
                parents,
                tree,
                message,
            }))
        }
        Some(ObjectType::Tree) => {
            let t = obj.peel_to_tree().map_err(|e| e.message().to_string())?;
            let entries = t
                .iter()
                .map(|e| TreeEntryRow {
                    name: e.name().unwrap_or("").to_string(),
                    mode: mode_str(e.filemode()),
                    kind: kind_str(e.kind()),
                    oid: e.id().to_string(),
                })
                .collect();
            Ok(PlumbingObject::Tree(TreeObject { sha: t.id().to_string(), entries }))
        }
        Some(ObjectType::Blob) => {
            let b = obj.peel_to_blob().map_err(|e| e.message().to_string())?;
            let is_binary = b.is_binary();
            let (content, truncated) = if is_binary {
                (None, false)
            } else {
                let (text, trunc) = cap_lines(&lossy(b.content()));
                (Some(text), trunc)
            };
            Ok(PlumbingObject::Blob(BlobObject {
                sha: b.id().to_string(),
                size: b.size(),
                is_binary,
                content,
                truncated,
            }))
        }
        Some(ObjectType::Tag) => {
            // `revparse_single` on an annotated tag's name returns the tag
            // object itself (unpeeled) — matches `git rev-parse <tag>`.
            let tag = obj
                .into_tag()
                .map_err(|_| "Resolved object claims kind Tag but is not one.".to_string())?;
            // Same reasoning as the Commit arm above: bind `tagger` before the
            // struct literal so its temporary Signature drops before `tag` does.
            let tagger = tag.tagger().as_ref().map(person);
            Ok(PlumbingObject::Tag(TagObject {
                sha: tag.id().to_string(),
                name: tag.name().unwrap_or("").to_string(),
                tagger,
                message: tag.message().unwrap_or("").to_string(),
                target_oid: tag.target_id().to_string(),
                target_kind: kind_str(tag.target_type()),
            }))
        }
        other => Err(format!(
            "Unsupported object kind ({}) for {rev:?} — expected a commit, tree, blob, or tag.",
            other.map(|k| k.str().to_string()).unwrap_or_else(|| "unknown".to_string())
        )),
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn person(sig: &Signature) -> PlumbingPerson {
    PlumbingPerson {
        name: sig.name().unwrap_or("").to_string(),
        email: sig.email().unwrap_or("").to_string(),
        time: sig.when().seconds(),
    }
}

/// `TreeEntry::filemode()` returns libgit2's normalized `GIT_FILEMODE_*`
/// (e.g. `0o100644` as a plain decimal i32) — formatting it in octal
/// reproduces exactly what `git ls-tree` prints.
fn mode_str(mode: i32) -> String {
    format!("{mode:06o}")
}

fn kind_str(k: Option<ObjectType>) -> String {
    match k {
        Some(ObjectType::Blob) => "blob",
        Some(ObjectType::Tree) => "tree",
        Some(ObjectType::Commit) => "commit",
        Some(ObjectType::Tag) => "tag",
        _ => "unknown",
    }
    .to_string()
}

/// Keep the first [`CAP_LINES`] lines; if more remain, append a truncation
/// marker. Returns `(text, was_truncated)`.
fn cap_lines(s: &str) -> (String, bool) {
    let mut lines = s.lines();
    let head: Vec<&str> = lines.by_ref().take(CAP_LINES).collect();
    let remaining = lines.count(); // consumes the tail; 0 when nothing was cut
    if remaining == 0 {
        (head.join("\n"), false)
    } else {
        (format!("{}\n… ({remaining} more line(s) truncated)", head.join("\n")), true)
    }
}
