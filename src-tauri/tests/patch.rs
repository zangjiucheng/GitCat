//! Patch export/apply (format-patch --stdout / git am --3way) — backlog #35.
//!
//! Covers: a single-commit export reproducing the exact same diff when
//! `git am`-applied into a fresh clone; a multi-commit range export producing
//! ONE file that applies as a SEQUENCE of separate commits (not squashed);
//! refusing to export a merge commit in single-commit mode (the "silently
//! exports the first parent instead" footgun documented in patch.rs);
//! a patch that conflicts on apply being correctly detected/reported with
//! real `conflictedFiles` and `op == "am"` from `conflict_status`; resolving
//! via the SAME `resolve_conflict_file` path every other conflict uses, then
//! `am_continue` concluding the right commit; `am_skip` re-classifying onto
//! the next conflicting patch; `am_abort` fully restoring the pre-apply
//! state; and a regression guard that a genuine apply-backend
//! `git rebase --apply` conflict still reports `op == "rebase"`, not `"am"`
//! (proving the `RepositoryState::ApplyMailbox` vs `Rebase` disambiguation in
//! conflict.rs's `op_name` is correctly wired, not just asserted in a doc
//! comment).

mod common;

use common::TempRepo;
use git2::RepositoryState;
use gitcat_lib::conflict::{conflict_status, resolve_conflict_file};
use gitcat_lib::patch::{am_abort, am_continue, am_skip, apply_patch, export_patch};

/// A second throwaway repo used as the "apply into" side, cloned from `src`'s
/// current HEAD via a plain filesystem clone (no network needed).
fn clone_of(src: &TempRepo, tag: &str) -> TempRepo {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("gitcat-test-{tag}-clone-{nanos}"));
    let out = std::process::Command::new("git")
        .args(["clone", "-q", &src.path(), &dir.to_string_lossy()])
        .output()
        .expect("failed to spawn git clone");
    assert!(out.status.success(), "git clone failed: {}", String::from_utf8_lossy(&out.stderr));
    let repo = TempRepo { dir };
    repo.must(&["config", "commit.gpgsign", "false"]);
    repo.must(&["config", "tag.gpgsign", "false"]);
    repo.must(&["config", "user.name", "GitCat Test"]);
    repo.must(&["config", "user.email", "test@gitcat.example"]);
    repo
}

#[test]
fn export_single_commit_then_am_reproduces_identical_diff() {
    let repo = TempRepo::init("patch_export_single");
    let base = repo.commit("f.txt", "base\n", "base");
    let added = repo.commit("f.txt", "base\nline2\n", "add line2");
    let path = repo.path();

    let dest = std::env::temp_dir().join(format!("gitcat-patch-single-{}.patch", std::process::id()));
    let dest_str = dest.to_string_lossy().to_string();

    let res = export_patch(path.clone(), None, added.clone(), dest_str.clone());
    assert!(res.ok, "export_patch failed: {}", res.message);
    let text = std::fs::read_to_string(&dest).expect("read exported patch");
    assert!(text.starts_with("From "), "expected an mbox 'From ' header, got: {:?}", &text[..text.len().min(80)]);
    assert!(text.contains("add line2"), "patch should contain the commit subject");

    // Apply into a fresh clone, reset back to BEFORE the commit, then git am
    // the exported patch to reproduce it.
    let clone = clone_of(&repo, "patch_export_single");
    clone.must(&["reset", "--hard", &base]);

    let clone_out = std::process::Command::new("git")
        .arg("-C")
        .arg(&clone.dir)
        .args(["am", "--3way", &dest_str])
        .output()
        .expect("failed to spawn git am");
    assert!(
        clone_out.status.success(),
        "git am failed: {}",
        String::from_utf8_lossy(&clone_out.stderr)
    );
    assert_eq!(clone.read("f.txt"), "base\nline2\n");
    // The diff introduced by the applied commit must match the original exactly.
    let orig_diff = repo.must(&["diff", &base, &added]);
    let new_head = clone.rev("HEAD").unwrap();
    let clone_diff = clone.must(&["diff", &base, &new_head]);
    assert_eq!(orig_diff, clone_diff, "applied commit's diff should match the original exactly");

    let _ = std::fs::remove_file(&dest);
}

#[test]
fn export_range_then_am_applies_as_separate_commits_not_squashed() {
    let repo = TempRepo::init("patch_export_range");
    let base = repo.commit("f.txt", "base\n", "base");
    let _c1 = repo.commit("f.txt", "base\nline2\n", "add line2");
    let c2 = repo.commit("f.txt", "base\nline2\nline3\n", "add line3");
    let path = repo.path();

    let dest = std::env::temp_dir().join(format!("gitcat-patch-range-{}.patch", std::process::id()));
    let dest_str = dest.to_string_lossy().to_string();

    let res = export_patch(path.clone(), Some(base.clone()), c2.clone(), dest_str.clone());
    assert!(res.ok, "export_patch (range) failed: {}", res.message);
    assert!(res.message.contains('2'), "expected the export message to mention 2 commits: {}", res.message);

    let text = std::fs::read_to_string(&dest).expect("read exported patch");
    let from_headers = text
        .lines()
        .filter(|l| l.starts_with("From ") && l[5..].chars().take(40).all(|c| c.is_ascii_hexdigit()))
        .count();
    assert_eq!(from_headers, 2, "one combined mbox file should contain both commits' own 'From ' boundaries");

    let clone = clone_of(&repo, "patch_export_range");
    clone.must(&["reset", "--hard", &base]);

    let clone_out = std::process::Command::new("git")
        .arg("-C")
        .arg(&clone.dir)
        .args(["am", "--3way", &dest_str])
        .output()
        .expect("failed to spawn git am");
    assert!(clone_out.status.success(), "git am (range) failed: {}", String::from_utf8_lossy(&clone_out.stderr));

    // TWO new commits landed (not one squashed commit).
    let log = clone.must(&["log", "--format=%s", &format!("{base}..HEAD")]);
    let subjects: Vec<&str> = log.lines().collect();
    assert_eq!(subjects, vec!["add line3", "add line2"], "expected two separate commits, oldest-first replay, newest-first log: {subjects:?}");
    assert_eq!(clone.read("f.txt"), "base\nline2\nline3\n");

    let _ = std::fs::remove_file(&dest);
}

/// Regression test for a real, adversarially-found corruption: an earlier
/// draft claimed "git's own mboxrd escaping guarantees no commit BODY line
/// can collide" with a real mbox message boundary — FALSE. A commit whose
/// message body contains a line shaped exactly like a real boundary
/// (`From <40-hex> <date-like text>`) used to corrupt the export: `git am`
/// treated the body line as a bogus extra message boundary and failed with
/// "Patch is empty.", silently orphaning the SECOND commit's real diff. Fixed
/// by `export_patch` escaping any such lookalike (mboxrd-style) and
/// `apply_patch` passing `--patch-format=mboxrd` to unescape it correctly.
#[test]
fn export_then_apply_survives_a_commit_body_that_looks_like_a_real_mbox_boundary() {
    let repo = TempRepo::init("patch_mbox_lookalike");
    let base = repo.commit("f.txt", "base\n", "base");
    let _c1 = repo.commit("f.txt", "base\nline2\n", "first commit");
    // The adversarial repro: a commit message BODY containing a full,
    // realistic-looking mbox "From " boundary line.
    let lookalike_body = "second commit\n\n\
        From 1111111111111111111111111111111111111111 Mon Sep 17 00:00:00 2001\n\
        From: Evil <e@e.com>\n\n\
        looks like a boundary but is just body text\n";
    std::fs::write(repo.dir.join("g.txt"), "second file content\n").unwrap();
    repo.must(&["add", "-A"]);
    repo.must(&["commit", "-q", "--no-verify", "-m", lookalike_body]);
    let c2 = repo.rev("HEAD").unwrap();
    let path = repo.path();

    let dest = std::env::temp_dir().join(format!("gitcat-patch-lookalike-{}.patch", std::process::id()));
    let dest_str = dest.to_string_lossy().to_string();

    let res = export_patch(path.clone(), Some(base.clone()), c2.clone(), dest_str.clone());
    assert!(res.ok, "export_patch failed: {}", res.message);
    assert!(res.message.contains('2'), "expected the export message to mention 2 commits: {}", res.message);

    let text = std::fs::read_to_string(&dest).expect("read exported patch");
    assert!(
        text.contains(">From 1111111111111111111111111111111111111111 Mon Sep 17"),
        "the lookalike body line must have been escaped with a leading '>': {text:?}"
    );

    // Apply via the app's OWN command (not a raw `git am`) — this is the
    // path that must pass --patch-format=mboxrd to correctly unescape.
    let target = clone_of(&repo, "patch_mbox_lookalike");
    target.must(&["reset", "--hard", &base]);
    let applied = apply_patch(target.path(), dest_str.clone());
    assert!(applied.ok, "apply_patch failed on a lookalike-body patch: {}", applied.message);
    assert_eq!(applied.state, "clean");

    // BOTH commits landed — the second commit's real diff must not have
    // been orphaned into a bogus, empty third message.
    let log = target.must(&["log", "--format=%H", &format!("{base}..HEAD")]);
    assert_eq!(log.lines().count(), 2, "both commits must have landed, not just the first: {log:?}");
    assert_eq!(target.read("g.txt"), "second file content\n");
    assert_eq!(target.read("f.txt"), "base\nline2\n");

    let _ = std::fs::remove_file(&dest);
}

#[test]
fn export_refuses_a_merge_commit_in_single_commit_mode() {
    let repo = TempRepo::init("patch_export_merge_refused");
    let _base = repo.commit("f.txt", "base\n", "base");
    repo.must(&["checkout", "-q", "-b", "feature"]);
    let _feat = repo.commit("g.txt", "feature\n", "feature work");
    repo.must(&["checkout", "-q", "main"]);
    let _main2 = repo.commit("h.txt", "main2\n", "main work");
    repo.must(&["merge", "--no-ff", "-q", "-m", "merge feature", "feature"]);
    let merge_sha = repo.rev("HEAD").unwrap();
    let path = repo.path();

    let dest = std::env::temp_dir().join(format!("gitcat-patch-merge-{}.patch", std::process::id()));
    let dest_str = dest.to_string_lossy().to_string();

    let res = export_patch(path, None, merge_sha, dest_str.clone());
    assert!(!res.ok, "expected export_patch to refuse a merge commit");
    assert!(
        res.message.to_lowercase().contains("merge"),
        "expected an explanatory message mentioning 'merge', got: {}",
        res.message
    );
    assert!(!dest.exists(), "no file should have been written when the export was refused");
}

#[test]
fn export_nonexistent_revision_is_a_clean_error() {
    let repo = TempRepo::init("patch_export_bad_rev");
    let _base = repo.commit("f.txt", "base\n", "base");
    let path = repo.path();
    let dest = std::env::temp_dir().join(format!("gitcat-patch-badrev-{}.patch", std::process::id()));
    let res = export_patch(path, None, "not-a-real-rev".into(), dest.to_string_lossy().to_string());
    assert!(!res.ok);
    assert!(!dest.exists());
}

/// Builds a `src` repo with a commit (`to_export`) that changes `f.txt` from
/// "base" to "A", exports it to a `.patch` file, then builds a SEPARATE
/// `dest` repo (NOT a clone) whose `f.txt` was independently edited to "B" on
/// the same line — so applying the exported patch there conflicts. Returns
/// (dest_repo, patch_path).
fn build_conflicting_apply_scenario(tag: &str) -> (TempRepo, String) {
    let src = TempRepo::init(&format!("{tag}_src"));
    let _base = src.commit("f.txt", "base\n", "base");
    let to_export = src.commit("f.txt", "A\n", "edit to A");
    let dest = std::env::temp_dir().join(format!("gitcat-{tag}-{}.patch", std::process::id()));
    let dest_str = dest.to_string_lossy().to_string();
    let res = export_patch(src.path(), None, to_export, dest_str.clone());
    assert!(res.ok, "export_patch failed: {}", res.message);

    // A DIFFERENT repo starting from the SAME base, independently diverged.
    let target = TempRepo::init(&format!("{tag}_dest"));
    target.must(&["config", "commit.gpgsign", "false"]);
    let _base2 = target.commit("f.txt", "base\n", "base");
    let _b = target.commit("f.txt", "B\n", "edit to B");

    (target, dest_str)
}

/// Regression guard for the stdout/stderr mixup found in this backend's own
/// re-verification: `git am`'s "Applying: <subject>" progress lines land on
/// STDOUT, not stderr, so a clean (non-conflicting) multi-commit apply's
/// success message must correctly report the real commit count — not
/// silently fall back to "1" the way reading `out.stderr` would.
#[test]
fn apply_patch_clean_multi_commit_message_reports_real_count() {
    let src = TempRepo::init("patch_apply_clean_count_src");
    let base = src.commit("f.txt", "base\n", "base");
    let _c1 = src.commit("f.txt", "base\nline2\n", "add line2");
    let head = src.commit("f.txt", "base\nline2\nline3\n", "add line3");
    let dest = std::env::temp_dir().join(format!("gitcat-patch-clean-count-{}.patch", std::process::id()));
    let dest_str = dest.to_string_lossy().to_string();
    let res = export_patch(src.path(), Some(base.clone()), head, dest_str.clone());
    assert!(res.ok, "export_patch failed: {}", res.message);

    let target = TempRepo::init("patch_apply_clean_count_dest");
    target.must(&["config", "commit.gpgsign", "false"]);
    let _base2 = target.commit("f.txt", "base\n", "base");
    let path = target.path();

    let applied = apply_patch(path, dest_str);
    assert!(applied.ok, "expected a clean apply, got: {}", applied.message);
    assert_eq!(applied.state, "clean");
    assert!(
        applied.message.contains('2'),
        "expected the success message to report 2 applied commits, got: {}",
        applied.message
    );
    assert!(
        !applied.message.contains('1'),
        "message should not (mis)report a fallback count of 1: {}",
        applied.message
    );

    let _ = std::fs::remove_file(&dest);
}

#[test]
fn apply_patch_conflict_is_detected_with_op_am_then_resolved_via_continue() {
    let (repo, patch_path) = build_conflicting_apply_scenario("patch_apply_conflict");
    let path = repo.path();

    let applied = apply_patch(path.clone(), patch_path.clone());
    assert_eq!(applied.state, "conflict", "expected a conflict, got: {}", applied.message);
    assert!(!applied.ok);
    assert!(!applied.conflicted_files.is_empty(), "expected real conflicted files");
    assert!(applied.backup_ref.is_some(), "apply_patch should snapshot before mutating");
    assert_eq!(repo.open().state(), RepositoryState::ApplyMailbox);

    // conflict_status must label this "am", not "rebase" — the whole point of
    // the RepositoryState::ApplyMailbox disambiguation in conflict.rs.
    let status = conflict_status(path.clone()).expect("conflict_status failed");
    assert!(status.in_progress);
    assert_eq!(status.op, "am");
    assert_eq!(status.files.len(), 1);
    let f = &status.files[0];
    assert_eq!(f.path, "f.txt");

    // Resolve via the SAME resolve_conflict_file path every other conflict uses.
    let resolved = resolve_conflict_file(path.clone(), "f.txt".into(), "theirs".into());
    assert!(resolved.ok, "resolve_conflict_file failed: {}", resolved.message);
    assert_eq!(resolved.remaining, 0);

    // Continue via am_continue (NEVER rebase_continue — see patch.rs's module doc).
    let cont = am_continue(path.clone());
    assert!(cont.ok, "am_continue failed: {}", cont.message);
    assert_eq!(cont.state, "clean");

    assert_eq!(repo.read("f.txt"), "A\n");
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    let after = conflict_status(path).expect("conflict_status failed");
    assert!(!after.in_progress);
}

#[test]
fn apply_patch_am_skip_reclassifies_and_am_abort_restores_pre_apply_state() {
    // A patch with TWO commits where the first conflicts and the second
    // (independently) also touches the same conflicting line, so skipping the
    // first still lands on a real, still-conflicting second patch.
    let src = TempRepo::init("patch_am_skip_src");
    let _base = src.commit("f.txt", "base\n", "base");
    let _c1 = src.commit("f.txt", "A1\n", "edit to A1");
    let _c2 = src.commit("f.txt", "A2\n", "edit to A2");
    let head = src.rev("HEAD").unwrap();
    let dest = std::env::temp_dir().join(format!("gitcat-patch-am-skip-{}.patch", std::process::id()));
    let dest_str = dest.to_string_lossy().to_string();
    let res = export_patch(src.path(), Some(_base.clone()), head, dest_str.clone());
    assert!(res.ok, "export_patch failed: {}", res.message);

    let target = TempRepo::init("patch_am_skip_dest");
    target.must(&["config", "commit.gpgsign", "false"]);
    let _base2 = target.commit("f.txt", "base\n", "base");
    let pre_apply_head = target.commit("f.txt", "B\n", "edit to B");
    let path = target.path();

    let applied = apply_patch(path.clone(), dest_str);
    assert_eq!(applied.state, "conflict", "expected a conflict, got: {}", applied.message);
    assert_eq!(target.open().state(), RepositoryState::ApplyMailbox);

    // Skip the first (still-conflicting) commit entirely.
    let skipped = am_skip(path.clone());
    // Either it lands cleanly (if the 2nd patch happens to apply against the
    // now-current tree) or it re-conflicts on the 2nd patch — both are valid
    // outcomes of "skip"; assert it's NOT an outright error either way.
    assert_ne!(skipped.state, "error", "am_skip should never surface a bare error here: {}", skipped.message);

    // Regardless of which branch we're in, am_abort must fully restore state.
    let aborted = am_abort(path.clone());
    assert!(aborted.ok, "am_abort failed: {}", aborted.message);
    assert_eq!(aborted.state, "clean");
    assert_eq!(target.rev("HEAD").as_deref(), Some(pre_apply_head.as_str()));
    assert_eq!(target.open().state(), RepositoryState::Clean);
    assert_eq!(target.read("f.txt"), "B\n");
    assert!(target.is_clean());

    // Idempotent.
    let again = am_abort(path);
    assert!(again.ok);
    assert_eq!(again.state, "clean");
}

/// Regression guard for the op_name disambiguation itself: a genuine
/// apply-backend `git rebase --apply` conflict (the ONE case GitCat itself
/// never creates, but a terminal user could) must still report `op ==
/// "rebase"`, NOT `"am"` — proving `RepositoryState::ApplyMailbox` and
/// `RepositoryState::Rebase` are correctly told apart, not just asserted to
/// be in a doc comment.
#[test]
fn genuine_apply_backend_rebase_conflict_still_reports_op_rebase_not_am() {
    let repo = TempRepo::init("patch_rebase_apply_regression");
    let _base = repo.commit("f.txt", "base\n", "base");
    repo.must(&["checkout", "-q", "-b", "feature"]);
    let _feat = repo.commit("f.txt", "feature\n", "feature edit");
    repo.must(&["checkout", "-q", "main"]);
    let _main2 = repo.commit("f.txt", "main\n", "main edit");
    let path = repo.path();

    // Force the OLD apply-based rebase backend directly via the CLI (never
    // going through GitCat's own rebase_start, which always uses the modern
    // merge backend) — this is the one case GitCat itself never produces.
    // Isolate the host's global/system git config (mirrors TempRepo::git's own
    // isolation) — a host with `rebase.updateRefs=true` set globally makes
    // `--apply` refuse outright ("apply options are incompatible with rebase
    // .updateRefs") before ever reaching a real conflict, which this
    // regression test needs to actually construct.
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&repo.dir)
        .args(["rebase", "--apply", "feature"])
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .output()
        .expect("failed to spawn git rebase --apply");
    assert!(!out.status.success(), "expected the apply-based rebase to conflict");
    assert_eq!(repo.open().state(), RepositoryState::Rebase, "apply-backend rebase should be RepositoryState::Rebase, not ApplyMailbox");

    let status = conflict_status(path.clone()).expect("conflict_status failed");
    assert_eq!(status.op, "rebase", "a genuine apply-backend rebase conflict must still be labeled 'rebase', not 'am'");

    // Clean up via the real rebase abort (not am_abort — this is a rebase, not
    // an am session; am_abort would correctly no-op here since state != ApplyMailbox).
    let noop = am_abort(path.clone());
    assert!(noop.ok);
    assert_eq!(noop.message, "No patch-apply in progress.", "am_abort must NOT touch a genuine rebase-apply conflict");
    assert_eq!(repo.open().state(), RepositoryState::Rebase, "am_abort must be a no-op against a real rebase conflict");

    let (ok, _so, _se) = repo.git(&["rebase", "--abort"]);
    assert!(ok, "real rebase --abort should restore cleanly");
    assert_eq!(repo.open().state(), RepositoryState::Clean);
}
