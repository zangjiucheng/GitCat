//! Partial clones (`git clone --filter=blob:none`).
//!
//! Such a clone has every commit and tree but only the blobs its checkout
//! needed. libgit2 can't fetch the rest on demand the way the git CLI does, so
//! reading an older commit's diff used to fail with libgit2's raw
//! `object not found - cannot read header for (<oid>)`. These tests build a
//! real partial clone from a local bare "server" over `file://` (the smart
//! transport, which honours filters; a plain path would take git's local
//! shortcut and copy everything) and check that the reads fetch what they need,
//! and that an unreachable remote produces the translated message instead.

mod common;

use common::TempRepo;
use gitcat_lib::commands::commit_detail;
use gitcat_lib::compare::commit_range_diff_inner;
use std::path::PathBuf;

struct Fixture {
    /// Keeps the source and server alive for the test's duration.
    _source: TempRepo,
    _server: TempRepo,
    /// Holds the clone at `holder/clone`; removed (with the clone) on drop.
    _holder: TempRepo,
    clone: PathBuf,
    /// c0: f.txt v1. c1: f.txt v2 + g.txt. c2: f.txt v3, g.txt edited.
    shas: Vec<String>,
}

impl Fixture {
    fn clone_path(&self) -> String {
        self.clone.to_string_lossy().to_string()
    }

    fn git(&self, args: &[&str]) -> (bool, String, String) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(&self.clone)
            .args(args)
            // Never let the test's own git calls fetch lazily: they are here
            // to OBSERVE what is missing, not to fill it in.
            .env("GIT_NO_LAZY_FETCH", "1")
            .output()
            .expect("spawn git");
        (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        )
    }

    /// Whether the clone's object database has `rev` (e.g. `<sha>:f.txt`),
    /// read through git2 so nothing is fetched as a side effect.
    fn has_blob(&self, rev: &str) -> bool {
        let (ok, oid, err) = self.git(&["rev-parse", rev]);
        assert!(ok, "rev-parse {rev}: {err}");
        let repo = git2::Repository::open(&self.clone).unwrap();
        let odb = repo.odb().unwrap();
        odb.exists(git2::Oid::from_str(&oid).unwrap())
    }
}

fn file_url(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    if s.starts_with('/') {
        format!("file://{s}")
    } else {
        format!("file:///{s}")
    }
}

fn partial_clone(tag: &str) -> Fixture {
    let source = TempRepo::init(&format!("{tag}-src"));
    let mut shas = Vec::new();
    shas.push(source.commit("f.txt", "alpha\nbeta\ngamma\n", "c0: add f"));
    std::fs::write(source.dir.join("g.txt"), "one\ntwo\n").unwrap();
    shas.push(source.commit("f.txt", "alpha\nBETA\ngamma\n", "c1: edit f, add g"));
    std::fs::write(source.dir.join("g.txt"), "one\nTWO\nthree\n").unwrap();
    shas.push(source.commit("f.txt", "alpha\nBETA\ngamma\ndelta\n", "c2: edit f and g"));

    let server = TempRepo::init_bare(&format!("{tag}-srv"));
    server.must(&["config", "uploadpack.allowFilter", "true"]);
    server.must(&["config", "uploadpack.allowAnySHA1InWant", "true"]);
    source.must(&["push", "-q", &server.path(), "main"]);

    let holder = TempRepo::init(&format!("{tag}-holder"));
    holder.must(&["clone", "-q", "--filter=blob:none", "--no-tags", "-b", "main", &file_url(&server.dir), "clone"]);
    let clone = holder.dir.join("clone");
    let fx = Fixture { _source: source, _server: server, _holder: holder, clone, shas };

    // The premise: the checkout has HEAD's blobs, but older versions are
    // genuinely absent — otherwise these tests would prove nothing.
    assert!(fx.has_blob(&format!("{}:f.txt", fx.shas[2])), "HEAD's blob is checked out");
    assert!(!fx.has_blob(&format!("{}:f.txt", fx.shas[0])), "c0's f.txt must be missing in a blob:none clone");
    assert!(!fx.has_blob(&format!("{}:f.txt", fx.shas[1])), "c1's f.txt must be missing in a blob:none clone");
    fx
}

#[test]
fn commit_detail_fetches_missing_blobs_and_returns_the_real_diff() {
    let fx = partial_clone("pc-detail");
    let d = tauri::async_runtime::block_on(commit_detail(fx.clone_path(), fx.shas[1].clone()))
        .expect("commit_detail must succeed in a partial clone");

    let paths: Vec<&str> = d.file_tree.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["f.txt", "g.txt"], "both changed files are listed");
    let f = &d.file_tree[0];
    assert!(!f.binary);
    let lines: Vec<(String, String)> =
        f.hunks.iter().flat_map(|h| h.lines.iter().map(|l| (l.kind.clone(), l.text.clone()))).collect();
    assert!(lines.contains(&("-".to_string(), "beta".to_string())), "old side read: {lines:?}");
    assert!(lines.contains(&("+".to_string(), "BETA".to_string())), "new side read: {lines:?}");
    assert_eq!(d.additions, 3, "1 line in f.txt + 2 lines of the new g.txt");
    assert_eq!(d.deletions, 1);

    // The fetch really landed in the clone's object database.
    assert!(fx.has_blob(&format!("{}:f.txt", fx.shas[1])));
    assert!(fx.has_blob(&format!("{}:f.txt", fx.shas[0])));
}

#[test]
fn a_root_commit_and_a_range_diff_also_work() {
    let fx = partial_clone("pc-range");
    let root = tauri::async_runtime::block_on(commit_detail(fx.clone_path(), fx.shas[0].clone()))
        .expect("root commit detail");
    assert_eq!(root.additions, 3);

    let r = commit_range_diff_inner(&fx.clone_path(), &fx.shas[0], &fx.shas[2]).expect("range diff");
    assert_eq!(r.files_changed, 2);
    let summary =
        gitcat_lib::compare::commit_range_summary_inner(&fx.clone_path(), &fx.shas[0], &fx.shas[2]).expect("summary");
    assert_eq!(summary.files_changed, 2);
    assert_eq!(summary.additions, r.additions);
}

#[test]
fn preview_blame_and_file_history_work_in_a_partial_clone() {
    let fx = partial_clone("pc-misc");
    let p = tauri::async_runtime::block_on(gitcat_lib::preview::preview_blob(
        fx.clone_path(),
        fx.shas[0].clone(),
        "f.txt".to_string(),
    ))
    .expect("preview")
    .expect("f.txt exists at c0");
    assert_eq!(p.size, "alpha\nbeta\ngamma\n".len());

    let b = tauri::async_runtime::block_on(gitcat_lib::blame::blame_file(
        fx.clone_path(),
        "f.txt".to_string(),
        None,
        false,
    ))
    .expect("blame must walk history in a partial clone");
    assert_eq!(b.lines, vec!["alpha", "BETA", "gamma", "delta"]);
    let line1_sha = &b.hunks.iter().find(|h| h.start_line == 1).expect("hunk for line 1").sha;
    assert_eq!(line1_sha, &fx.shas[0], "line 1 is unchanged since c0");

    // History of a file whose OLD blob is missing: only its kind is checked.
    let h = tauri::async_runtime::block_on(gitcat_lib::file_history::file_history(
        fx.clone_path(),
        "g.txt".to_string(),
        Some(fx.shas[1].clone()),
    ))
    .expect("file history");
    assert_eq!(h.entries.len(), 1);
}

#[test]
fn an_unreachable_promisor_remote_gives_a_clear_message_not_object_not_found() {
    let fx = partial_clone("pc-offline");
    // Point the promisor remote at a server that does not exist — what
    // "offline" looks like to git.
    let gone = fx._holder.dir.join("no-such-server.git");
    let (ok, _, err) = fx.git(&["remote", "set-url", "origin", &file_url(&gone)]);
    assert!(ok, "{err}");

    let e = tauri::async_runtime::block_on(commit_detail(fx.clone_path(), fx.shas[1].clone()))
        .err()
        .expect("the old blobs can't be fetched");
    assert!(e.starts_with("i18n:err_repo.partial_clone_fetch_failed"), "translated message, got: {e}");
    assert!(e.contains("\u{1f}remote\u{1f}origin"), "names the remote: {e}");
    assert!(!e.contains("object not found"), "never libgit2's raw error: {e}");

    // A diff that needs no missing blob never tries the network at all.
    let same = commit_range_diff_inner(&fx.clone_path(), &fx.shas[2], &fx.shas[2]).expect("no blobs needed");
    assert_eq!(same.files_changed, 0);
}

#[test]
fn a_removed_promisor_remote_gives_a_clear_message() {
    let fx = partial_clone("pc-removed");
    let (ok, _, err) = fx.git(&["remote", "remove", "origin"]);
    assert!(ok, "{err}");

    let e = tauri::async_runtime::block_on(commit_detail(fx.clone_path(), fx.shas[1].clone()))
        .err()
        .expect("nowhere to fetch from");
    assert!(e.starts_with("i18n:err_repo.partial_clone_"), "translated message, got: {e}");
    assert!(!e.contains("object not found"), "never libgit2's raw error: {e}");
}

#[test]
fn an_ordinary_clone_is_not_treated_as_partial() {
    let repo = TempRepo::init("pc-ordinary");
    let a = repo.commit("f.txt", "x\n", "a");
    let b = repo.commit("f.txt", "y\n", "b");
    let _ = a;
    let git = repo.open();
    assert!(!gitcat_lib::promisor::is_partial_clone(&git));
    let d = tauri::async_runtime::block_on(commit_detail(repo.path(), b)).expect("detail");
    assert_eq!((d.additions, d.deletions), (1, 1));
}
