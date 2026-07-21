//! Rerere panel (M5a) — real end-to-end coverage against an actual `git`
//! binary, mirroring the empirical research in `src-tauri/src/rerere.rs`'s
//! module doc: enable rerere, engineer a real merge conflict, hand-resolve +
//! commit it (recording a resolution), then reproduce the SAME conflict shape
//! on a fresh pair of branches and assert git auto-resolves it via the
//! recorded resolution — and that `rerere_status` reports it accurately at
//! every stage (mid-conflict / just after commit / after replay).

mod common;

use common::TempRepo;
use git2::RepositoryState;
use gitcat_lib::rerere::{rerere_set_enabled, rerere_status};

#[test]
fn rerere_records_a_resolution_and_replays_it_on_the_same_conflict_shape() {
    let repo = TempRepo::init("rerere_e2e");
    repo.must(&["config", "rerere.enabled", "true"]);
    // SYNTHESIS FIX (blocking finding from review): force autoupdate
    // deterministically. With ambient global/system config now isolated (see
    // tests/common/mod.rs), git's own default for rerere.autoupdate is
    // `false`, which would leave the replayed conflict below staged-but-
    // unmerged ("UU") rather than clean-and-staged, and the plain `git commit`
    // that follows would then fail (git refuses to commit unmerged paths).
    // Setting this explicitly makes the "auto-resolved" assertion below
    // environment-independent — true on this machine, CI, or anyone else's.
    repo.must(&["config", "rerere.autoupdate", "true"]);

    let _base_commit = repo.commit("f.txt", "line1\n", "base");
    let base = repo.rev("HEAD").expect("base sha");

    // First occurrence of the conflict: sideA vs sideB, diverging from base.
    repo.must(&["checkout", "-q", "-b", "sideA"]);
    repo.commit("f.txt", "A-version\n", "edit on sideA");
    repo.must(&["checkout", "-q", "main"]);
    repo.must(&["merge", "--ff-only", "sideA"]); // main now carries the A edit

    repo.must(&["checkout", "-q", "-b", "sideB", &base]);
    repo.commit("f.txt", "B-version\n", "edit on sideB");

    repo.must(&["checkout", "-q", "main"]);
    let (merge_ok, _so, _se) = repo.git(&["merge", "sideB"]);
    assert!(!merge_ok, "expected a real, unresolved conflict merging sideB");
    assert_eq!(repo.open().state(), RepositoryState::Merge);

    let path = repo.path();

    // Mid-conflict: rerere has recorded a preimage (unresolved) and can name
    // the live path via `git rerere status`.
    let mid = tauri::async_runtime::block_on(rerere_status(path.clone())).expect("rerere_status failed");
    assert!(mid.enabled, "rerere should be effectively enabled");
    assert_eq!(mid.configured, Some(true));
    assert_eq!(mid.entries.len(), 1, "expected exactly one rr-cache entry mid-conflict");
    assert!(!mid.entries[0].resolved, "no postimage yet — not hand-resolved");
    assert!(mid.live_conflict);
    assert_eq!(mid.live_paths.len(), 1);
    assert_eq!(mid.live_paths[0].path, "f.txt");
    assert!(!mid.live_paths[0].resolved);

    // Hand-resolve and commit — this records the postimage.
    std::fs::write(repo.dir.join("f.txt"), "A-version\nB-version\n").expect("write resolved f.txt");
    repo.must(&["add", "f.txt"]);
    repo.must(&["commit", "--no-verify", "-m", "merge sideB, resolve conflict"]);
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    let after_commit = tauri::async_runtime::block_on(rerere_status(path.clone())).expect("rerere_status failed");
    assert_eq!(after_commit.entries.len(), 1);
    assert!(after_commit.entries[0].resolved, "postimage should now exist");
    assert!(!after_commit.live_conflict, "no conflict is live right after commit");
    assert!(after_commit.live_paths.is_empty());

    // Reproduce the SAME conflict shape on a fresh pair of branches off base.
    repo.must(&["checkout", "-q", "-b", "sideC", &base]);
    repo.commit("f.txt", "A-version\n", "edit on sideC (same shape as sideA)");
    repo.must(&["checkout", "-q", "-b", "sideD", &base]);
    repo.commit("f.txt", "B-version\n", "edit on sideD (same shape as sideB)");

    repo.must(&["checkout", "-q", "sideC"]);
    // Deliberately not asserting the exit code of this merge: git still exits
    // non-zero here because a merge COMMIT is still needed even when rerere
    // fully auto-resolved the content — the assertions below (content + no
    // unmerged paths) are the real proof of auto-resolution.
    let _ = repo.git(&["merge", "sideD"]);

    assert_eq!(
        repo.read("f.txt"),
        "A-version\nB-version\n",
        "rerere should have auto-applied the recorded resolution's content"
    );
    let porcelain = repo.must(&["status", "--porcelain"]);
    assert!(
        !porcelain.contains("UU") && !porcelain.contains("AA"),
        "expected no unmerged paths after rerere auto-resolved (with rerere.autoupdate=true, a\n         successful replay stages the file): {porcelain:?}"
    );

    // A merge commit is still required to conclude, even though content-wise
    // rerere already did the work.
    repo.must(&["commit", "--no-verify", "-m", "merge sideD into sideC (auto-resolved by rerere)"]);
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    let final_status = tauri::async_runtime::block_on(rerere_status(path)).expect("rerere_status failed");
    assert!(
        final_status.entries.iter().any(|e| e.resolved),
        "expected at least one resolved rr-cache entry after replay"
    );
    assert!(!final_status.live_conflict);
    assert!(final_status.live_paths.is_empty());
}

#[test]
fn rerere_set_enabled_toggles_the_local_config_and_status_reflects_it() {
    let repo = TempRepo::init("rerere_toggle");
    let _c0 = repo.commit("f.txt", "x\n", "c0");
    let path = repo.path();

    let on = tauri::async_runtime::block_on(rerere_set_enabled(path.clone(), true));
    assert!(on.ok, "enable failed: {}", on.message);
    let (_, local_on, _) = repo.git(&["config", "--local", "--get", "rerere.enabled"]);
    assert_eq!(local_on.trim(), "true");

    let st_on = tauri::async_runtime::block_on(rerere_status(path.clone())).expect("rerere_status failed");
    assert_eq!(st_on.configured, Some(true));
    assert!(st_on.enabled);

    let off = tauri::async_runtime::block_on(rerere_set_enabled(path.clone(), false));
    assert!(off.ok, "disable failed: {}", off.message);
    let (_, local_off, _) = repo.git(&["config", "--local", "--get", "rerere.enabled"]);
    assert_eq!(local_off.trim(), "false");

    let st_off = tauri::async_runtime::block_on(rerere_status(path)).expect("rerere_status failed");
    assert_eq!(st_off.configured, Some(false));
    assert!(!st_off.enabled, "an explicit false must win regardless of any rr-cache fallback");
}

#[test]
fn rerere_status_on_a_repo_that_never_touched_rerere_reports_no_cache_entries() {
    let repo = TempRepo::init("rerere_untouched");
    let _c0 = repo.commit("f.txt", "x\n", "c0");
    let path = repo.path();

    let st = tauri::async_runtime::block_on(rerere_status(path)).expect("rerere_status failed");
    // With the ambient global/system config now isolated (tests/common/mod.rs),
    // `cache_dir_present` is reliably false here — but we deliberately do NOT
    // assert on it directly, keying "nothing recorded" off `entries.is_empty()`
    // instead, since that is the field the UI itself uses (see rerere.rs docs).
    assert!(st.entries.is_empty(), "a repo with no conflicts ever should have no rr-cache entries");
    assert!(!st.live_conflict);
    assert!(st.live_paths.is_empty());
}
