//! trust::open_repo — passthrough regression coverage.
//!
//! There's no portable, CI-safe way to fabricate a real libgit2 "dubious
//! ownership" failure (it requires an actual network/UNC-mounted path, e.g.
//! WSL's `\\wsl.localhost\...`) — that side of trust::open_repo is covered by
//! a unit test in src/trust.rs (is_dubious_ownership, exercised directly via
//! git2::Error::new) plus manual end-to-end verification against a real WSL
//! repo. What DOES need automated coverage is the 99% case: for an ordinary
//! local repo, trust::open_repo must behave exactly like a plain
//! Repository::open — no auto-trust retry triggered, no config mutated.

mod common;

use common::TempRepo;
use gitcat_lib::trust::open_repo;

#[test]
fn open_repo_passes_through_normally_for_an_ordinary_local_repo() {
    let repo = TempRepo::init("trust_passthrough");
    let _c0 = repo.commit("f.txt", "hello\n", "c0");

    let opened = open_repo(&repo.path());
    assert!(opened.is_ok(), "an ordinary local repo must open with no auto-trust involved");

    // No config mutation should have happened — safe.directory should still
    // be whatever it was (unset, for a fresh TempRepo) locally.
    let (_, local_safe_dir, _) = repo.git(&["config", "--local", "--get-all", "safe.directory"]);
    assert!(local_safe_dir.trim().is_empty(), "passthrough must never touch safe.directory");
}

#[test]
fn open_repo_errors_cleanly_on_a_path_that_is_not_a_repository() {
    let dir = std::env::temp_dir().join(format!(
        "gitcat-test-trust-not-a-repo-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("mkdir scratch dir");

    let result = open_repo(&dir.to_string_lossy());
    assert!(result.is_err(), "a non-repository path must error, not panic");

    let _ = std::fs::remove_dir_all(&dir);
}
