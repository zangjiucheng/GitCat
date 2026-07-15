//! Backlog #34: checkout dirty-tree resolution modes.
//!
//! Drives `checkout` / `create_branch` / `checkout_discard` (git_write.rs) on
//! a throwaway `TempRepo`, covering:
//!   - the plain, non-dirty checkout path is completely unaffected (still
//!     succeeds exactly as before, `conflicting_files` empty);
//!   - a dirty tree that DOES collide with the target is detected and the
//!     exact colliding file list is reported via `conflicting_files`, for
//!     both `checkout` and `create_branch(checkout:true)`;
//!   - a dirty tree that does NOT collide with the target still checks out
//!     cleanly, carrying the dirty file along untouched (today's existing
//!     behavior, regression-guarded);
//!   - `checkout_discard` actually discards a dirty TRACKED file's changes
//!     and switches;
//!   - `checkout_discard` also force-overwrites an UNTRACKED file that
//!     collides with a path the target branch tracks, while leaving a
//!     non-colliding untracked file alone (empirically verified real `git
//!     switch --force` behavior, not assumed).

mod common;

use common::TempRepo;
use gitcat_lib::git_write::{checkout, checkout_discard, create_branch, list_refs};

#[test]
fn checkout_clean_tree_is_completely_unaffected() {
    let repo = TempRepo::init("checkout_clean");
    let _c0 = repo.commit("a.txt", "base\n", "c0");
    repo.must(&["switch", "-q", "-c", "feature"]);
    let c1 = repo.commit("a.txt", "feature\n", "c1");
    repo.must(&["switch", "-q", "main"]);
    let path = repo.path();

    let res = tauri::async_runtime::block_on(checkout(path.clone(), "feature".into()));
    assert!(res.ok, "expected clean checkout to succeed: {}", res.message);
    assert!(res.backup_ref.is_some(), "checkout should snapshot first");
    assert!(res.conflicting_files.is_empty(), "a successful checkout must report no conflicting files");
    assert_eq!(tauri::async_runtime::block_on(list_refs(path)).unwrap().head.as_deref(), Some("feature"));
    assert_eq!(repo.read("a.txt"), "feature\n");
    let _ = c1;
}

#[test]
fn checkout_dirty_collision_reports_the_exact_colliding_files() {
    let repo = TempRepo::init("checkout_collision");
    let _c0 = repo.commit("a.txt", "base\n", "c0");
    // b.txt exists on both branches too, but only differs on feature -> colliding.
    let _c1 = repo.commit("b.txt", "base\n", "add b.txt");
    repo.must(&["switch", "-q", "-c", "feature"]);
    repo.commit("a.txt", "feature-a\n", "feature changes a.txt");
    repo.commit("b.txt", "feature-b\n", "feature changes b.txt");
    repo.must(&["switch", "-q", "main"]);
    let path = repo.path();

    // Dirty BOTH a.txt (unstaged) and b.txt (staged) — both collide with feature.
    std::fs::write(repo.dir.join("a.txt"), "dirty-a\n").unwrap();
    std::fs::write(repo.dir.join("b.txt"), "dirty-b\n").unwrap();
    repo.must(&["add", "--", "b.txt"]);
    assert!(!repo.is_clean());

    let res = tauri::async_runtime::block_on(checkout(path.clone(), "feature".into()));
    assert!(!res.ok, "expected the dirty-tree collision to be refused");
    assert!(res.backup_ref.is_none(), "a refused (never-attempted) mutation must not have snapshotted");
    let mut files = res.conflicting_files.clone();
    files.sort();
    assert_eq!(files, vec!["a.txt".to_string(), "b.txt".to_string()], "unexpected collision file list: {:?}", res.conflicting_files);
    assert!(
        res.message.contains("would be overwritten by checkout"),
        "expected git's stable prose in the message: {}",
        res.message
    );

    // Atomic refusal: git touches nothing on a failed switch.
    assert_eq!(tauri::async_runtime::block_on(list_refs(path)).unwrap().head.as_deref(), Some("main"));
    assert_eq!(repo.read("a.txt"), "dirty-a\n");
    assert_eq!(repo.read("b.txt"), "dirty-b\n");
}

#[test]
fn checkout_dirty_untracked_collision_reports_the_untracked_path() {
    let repo = TempRepo::init("checkout_untracked_collision");
    let _c0 = repo.commit("a.txt", "base\n", "c0");
    repo.must(&["switch", "-q", "-c", "feature"]);
    repo.commit("newfile.txt", "feature content\n", "feature adds newfile.txt tracked");
    repo.must(&["switch", "-q", "main"]);
    let path = repo.path();

    // An UNTRACKED file at the same path feature tracks.
    std::fs::write(repo.dir.join("newfile.txt"), "untracked local content\n").unwrap();
    // A second, NON-colliding untracked file (feature doesn't touch this path).
    std::fs::write(repo.dir.join("other.txt"), "unrelated\n").unwrap();

    let res = tauri::async_runtime::block_on(checkout(path.clone(), "feature".into()));
    assert!(!res.ok, "expected untracked-collision checkout to be refused");
    assert_eq!(res.conflicting_files, vec!["newfile.txt".to_string()]);
    assert_eq!(tauri::async_runtime::block_on(list_refs(path)).unwrap().head.as_deref(), Some("main"));
    assert_eq!(repo.read("newfile.txt"), "untracked local content\n");
    assert_eq!(repo.read("other.txt"), "unrelated\n");
}

#[test]
fn checkout_dirty_tree_that_does_not_collide_still_checks_out_cleanly() {
    let repo = TempRepo::init("checkout_no_collision");
    let _c0 = repo.commit("a.txt", "base\n", "c0");
    let _c1 = repo.commit("b.txt", "base\n", "add b.txt");
    repo.must(&["switch", "-q", "-c", "feature"]);
    // feature ONLY changes a.txt -> b.txt never collides.
    repo.commit("a.txt", "feature-a\n", "feature changes a.txt only");
    repo.must(&["switch", "-q", "main"]);
    let path = repo.path();

    // Dirty b.txt, which feature never touches — git carries it along untouched.
    std::fs::write(repo.dir.join("b.txt"), "still-dirty\n").unwrap();
    assert!(!repo.is_clean());

    let res = tauri::async_runtime::block_on(checkout(path.clone(), "feature".into()));
    assert!(res.ok, "a non-colliding dirty tree must still check out cleanly: {}", res.message);
    assert!(res.conflicting_files.is_empty());
    assert_eq!(tauri::async_runtime::block_on(list_refs(path)).unwrap().head.as_deref(), Some("feature"));
    assert_eq!(repo.read("a.txt"), "feature-a\n", "a.txt should reflect feature's content");
    assert_eq!(repo.read("b.txt"), "still-dirty\n", "the non-colliding dirty file must be carried along untouched");
}

#[test]
fn create_branch_switch_dirty_collision_is_classified_the_same_way() {
    let repo = TempRepo::init("create_branch_collision");
    let _c0 = repo.commit("a.txt", "base\n", "c0");
    let path = repo.path();

    std::fs::write(repo.dir.join("a.txt"), "dirty\n").unwrap();
    assert!(!repo.is_clean());

    // create_branch(..., checkout: true) with a start_point identical to
    // HEAD's tree would never collide (nothing to overwrite); use a
    // start_point whose tree differs on a.txt so the same unpack-trees
    // safety check fires.
    repo.must(&["switch", "-q", "-c", "other"]);
    let c1 = repo.commit("a.txt", "other-content\n", "c1 on other");
    repo.must(&["switch", "-q", "main"]);
    // Re-dirty (switching back and forth above needed a clean tree).
    std::fs::write(repo.dir.join("a.txt"), "dirty\n").unwrap();

    let res = tauri::async_runtime::block_on(create_branch(path.clone(), "feature2".into(), Some(c1.clone()), Some(true)));
    assert!(!res.ok, "expected create_branch's checkout:true to be refused on collision");
    assert_eq!(res.conflicting_files, vec!["a.txt".to_string()]);
    assert!(res.backup_ref.is_none());
    // Refused atomically: no new branch should have been created either.
    assert!(repo.rev("refs/heads/feature2").is_none());
}

#[test]
fn checkout_discard_discards_a_dirty_tracked_files_changes_and_switches() {
    let repo = TempRepo::init("checkout_discard_tracked");
    let _c0 = repo.commit("a.txt", "base\n", "c0");
    repo.must(&["switch", "-q", "-c", "feature"]);
    repo.commit("a.txt", "feature-a\n", "feature changes a.txt");
    repo.must(&["switch", "-q", "main"]);
    let path = repo.path();

    std::fs::write(repo.dir.join("a.txt"), "dirty, about to be discarded\n").unwrap();
    assert!(!repo.is_clean());

    // Sanity: the plain checkout would indeed be refused first (mirrors what
    // the frontend does before ever arming this mode).
    let plain = tauri::async_runtime::block_on(checkout(path.clone(), "feature".into()));
    assert!(!plain.ok);
    assert_eq!(plain.conflicting_files, vec!["a.txt".to_string()]);

    let discarded = tauri::async_runtime::block_on(checkout_discard(path.clone(), "feature".into(), None));
    assert!(discarded.ok, "checkout_discard failed: {}", discarded.message);
    assert!(discarded.backup_ref.is_some(), "checkout_discard should still snapshot HEAD first");
    assert_eq!(tauri::async_runtime::block_on(list_refs(path)).unwrap().head.as_deref(), Some("feature"));
    assert_eq!(repo.read("a.txt"), "feature-a\n", "the dirty tracked change must be discarded");
    assert!(repo.is_clean(), "working tree must be clean after a force-discard switch");
}

#[test]
fn checkout_discard_force_overwrites_colliding_untracked_file_but_spares_others() {
    let repo = TempRepo::init("checkout_discard_untracked");
    let _c0 = repo.commit("a.txt", "base\n", "c0");
    repo.must(&["switch", "-q", "-c", "feature"]);
    repo.commit("newfile.txt", "feature content\n", "feature adds newfile.txt tracked");
    repo.must(&["switch", "-q", "main"]);
    let path = repo.path();

    // Colliding untracked file (same path feature tracks) + a non-colliding one.
    std::fs::write(repo.dir.join("newfile.txt"), "untracked local content\n").unwrap();
    std::fs::write(repo.dir.join("other.txt"), "unrelated, must survive\n").unwrap();

    let discarded = tauri::async_runtime::block_on(checkout_discard(path.clone(), "feature".into(), None));
    assert!(discarded.ok, "checkout_discard failed on untracked collision: {}", discarded.message);
    assert_eq!(tauri::async_runtime::block_on(list_refs(path)).unwrap().head.as_deref(), Some("feature"));
    assert_eq!(
        repo.read("newfile.txt"),
        "feature content\n",
        "the colliding untracked file must be overwritten with the target branch's tracked content"
    );
    assert_eq!(
        repo.read("other.txt"),
        "unrelated, must survive\n",
        "a NON-colliding untracked file must be left completely alone"
    );
}

/// Regression/documentation test for a real, adversarially-found risk: unlike
/// a non-colliding UNTRACKED file (spared — see the test above),
/// `checkout_discard`'s `git switch --force` discards EVERY uncommitted
/// tracked/staged change anywhere in the working tree, including files that
/// have nothing to do with the original checkout collision. This is real git
/// behavior (there is no `git switch` mode scoped to only the colliding
/// paths), not a GitCat bug to fix in this command — but it means the
/// frontend's confirm copy must warn about the WHOLE tree, never just the
/// originally-colliding file count (see sidebar.svelte.ts's
/// `forceDiscardCheckout` and checkout_discard's own doc comment, both fixed
/// alongside this test after the review found the first draft of each
/// understated the blast radius).
#[test]
fn checkout_discard_wipes_an_unrelated_dirty_tracked_file_not_just_the_colliding_one() {
    let repo = TempRepo::init("checkout_discard_blast_radius");
    let _c0 = repo.commit("a.txt", "base\n", "c0");
    repo.commit("unrelated.txt", "unrelated base\n", "c0b: add unrelated.txt");
    repo.must(&["switch", "-q", "-c", "feature"]);
    repo.commit("a.txt", "feature-a\n", "feature changes a.txt");
    repo.must(&["switch", "-q", "main"]);
    let path = repo.path();

    // The ONLY file that actually collides with `feature` is a.txt.
    std::fs::write(repo.dir.join("a.txt"), "dirty, about to be discarded\n").unwrap();
    // unrelated.txt has nothing to do with the collision — plain checkout
    // would carry it along untouched (not asserted here; see the "does not
    // collide" test above for that guarantee) — but a FORCE discard wipes it
    // too, because --force's scope is the whole tree, not just a.txt.
    std::fs::write(repo.dir.join("unrelated.txt"), "unrelated dirty edit, NOT part of the collision\n").unwrap();
    repo.must(&["add", "unrelated.txt"]); // staged, not just working-tree dirty

    let discarded = tauri::async_runtime::block_on(checkout_discard(path.clone(), "feature".into(), None));
    assert!(discarded.ok, "checkout_discard failed: {}", discarded.message);
    assert_eq!(
        repo.read("unrelated.txt"),
        "unrelated base\n",
        "a force-discard checkout wipes uncommitted tracked/staged changes ANYWHERE in the tree, \
         not just the file(s) that made the original plain checkout collide — this is real \
         `git switch --force` behavior, documented here so it's never mistaken for a bug in this \
         command, and so the frontend's confirm copy is never allowed to understate it again"
    );
    assert!(repo.is_clean(), "working tree must be fully clean after a force-discard switch");
}

#[test]
fn checkout_discard_can_create_and_switch_from_a_start_point() {
    // Mirrors checkoutRemote's "new local branch tracking a remote" path:
    // create_branch-shaped (-c <name> <start_point>) but forced.
    let repo = TempRepo::init("checkout_discard_create");
    let _c0 = repo.commit("a.txt", "base\n", "c0");
    repo.must(&["switch", "-q", "-c", "other"]);
    let c1 = repo.commit("a.txt", "other-content\n", "c1 on other");
    repo.must(&["switch", "-q", "main"]);
    let path = repo.path();

    std::fs::write(repo.dir.join("a.txt"), "dirty on main\n").unwrap();
    assert!(!repo.is_clean());

    let res = tauri::async_runtime::block_on(checkout_discard(path.clone(), "brand-new".into(), Some(c1.clone())));
    assert!(res.ok, "checkout_discard with a start_point failed: {}", res.message);
    assert_eq!(tauri::async_runtime::block_on(list_refs(path.clone())).unwrap().head.as_deref(), Some("brand-new"));
    assert_eq!(repo.read("a.txt"), "other-content\n");
    assert_eq!(repo.rev("refs/heads/brand-new").as_deref(), Some(c1.as_str()));
}
