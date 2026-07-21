//! Repo-root file editors (backlog #14, final item): .gitignore/.mailmap
//! read/write. Covers: missing file reads as empty (not an error); a
//! write-then-read round-trips exact bytes (including trailing-newline
//! presence/absence — verified byte-exact, not assumed); an unlisted
//! filename is refused for both read and write; a bare repo (no working
//! tree) is refused cleanly for both.

mod common;

use common::TempRepo;
use gitcat_lib::repo_files::{read_repo_file, write_repo_file};

#[test]
fn missing_file_reads_as_empty_not_an_error() {
    let repo = TempRepo::init("repo_files_missing");
    let path = repo.path();

    // Neither .gitignore nor .mailmap exist yet in a freshly-init'd repo.
    let gi = tauri::async_runtime::block_on(read_repo_file(path.clone(), ".gitignore".to_string()));
    assert_eq!(gi, Ok(String::new()), ".gitignore missing should read as empty, not an error");

    let mm = tauri::async_runtime::block_on(read_repo_file(path, ".mailmap".to_string()));
    assert_eq!(mm, Ok(String::new()), ".mailmap missing should read as empty, not an error");
}

#[test]
fn write_then_read_round_trips_exact_bytes_gitignore() {
    let repo = TempRepo::init("repo_files_roundtrip_gi");
    let path = repo.path();

    // No trailing newline.
    let content_no_nl = "node_modules/\ndist/\n*.log".to_string();
    let res = tauri::async_runtime::block_on(write_repo_file(path.clone(), ".gitignore".to_string(), content_no_nl.clone()));
    assert!(res.ok, "write should succeed: {}", res.message);
    let read_back = tauri::async_runtime::block_on(read_repo_file(path.clone(), ".gitignore".to_string())).expect("read should succeed");
    assert_eq!(read_back, content_no_nl, "round-trip must be byte-exact (no trailing newline case)");

    // With trailing newline — must not be silently added or stripped either way.
    let content_with_nl = "node_modules/\ndist/\n*.log\n".to_string();
    let res2 = tauri::async_runtime::block_on(write_repo_file(path.clone(), ".gitignore".to_string(), content_with_nl.clone()));
    assert!(res2.ok, "write should succeed: {}", res2.message);
    let read_back2 = tauri::async_runtime::block_on(read_repo_file(path.clone(), ".gitignore".to_string())).expect("read should succeed");
    assert_eq!(read_back2, content_with_nl, "round-trip must be byte-exact (trailing newline case)");

    // Verify the file genuinely landed at the repo root on disk too, not just
    // readable back through the same command.
    assert_eq!(repo.read(".gitignore"), content_with_nl);
}

#[test]
fn write_then_read_round_trips_exact_bytes_mailmap() {
    let repo = TempRepo::init("repo_files_roundtrip_mm");
    let path = repo.path();

    let content = "Jane Doe <jane@newcorp.com> <jane@oldcorp.com>\n".to_string();
    let res = tauri::async_runtime::block_on(write_repo_file(path.clone(), ".mailmap".to_string(), content.clone()));
    assert!(res.ok, "write should succeed: {}", res.message);
    let read_back = tauri::async_runtime::block_on(read_repo_file(path, ".mailmap".to_string())).expect("read should succeed");
    assert_eq!(read_back, content, ".mailmap round-trip must be byte-exact");
    assert_eq!(repo.read(".mailmap"), content);
}

#[test]
fn unlisted_file_name_is_refused_for_read_and_write() {
    let repo = TempRepo::init("repo_files_unlisted");
    let path = repo.path();

    let read_res = tauri::async_runtime::block_on(read_repo_file(path.clone(), "config".to_string()));
    assert!(read_res.is_err(), "reading an unlisted filename must be refused");

    let read_res2 = tauri::async_runtime::block_on(read_repo_file(path.clone(), "../etc/passwd".to_string()));
    assert!(read_res2.is_err(), "reading a path-traversal-shaped filename must be refused");

    let write_res = tauri::async_runtime::block_on(write_repo_file(path.clone(), "config".to_string(), "malicious".to_string()));
    assert!(!write_res.ok, "writing an unlisted filename must be refused");

    let write_res2 = tauri::async_runtime::block_on(write_repo_file(path, "../etc/passwd".to_string(), "malicious".to_string()));
    assert!(!write_res2.ok, "writing a path-traversal-shaped filename must be refused");
}

#[test]
fn bare_repo_is_refused_cleanly_for_read_and_write() {
    let repo = TempRepo::init_bare("repo_files_bare");
    let path = repo.path();

    let read_res = tauri::async_runtime::block_on(read_repo_file(path.clone(), ".gitignore".to_string()));
    assert!(read_res.is_err(), "a bare repo (no working tree) must refuse cleanly on read");
    assert!(
        read_res.unwrap_err().contains("working tree"),
        "error message should clearly explain there is no working tree"
    );

    let write_res = tauri::async_runtime::block_on(write_repo_file(path, ".gitignore".to_string(), "*.log\n".to_string()));
    assert!(!write_res.ok, "a bare repo (no working tree) must refuse cleanly on write");
    assert!(
        write_res.message.contains("working tree"),
        "error message should clearly explain there is no working tree"
    );
}

/// Regression test for a real vulnerability an adversarial review found:
/// plain `fs::read_to_string`/`fs::write` both follow symlinks, so a
/// `.gitignore`/`.mailmap` that's actually a symlink pointing OUTSIDE the
/// repo used to silently disclose that outside file's content on read, and
/// silently overwrite it on write. Fixed by refusing outright whenever the
/// target path is a symlink (mirroring workdir.rs's/submodule.rs's own
/// established `fs::symlink_metadata`-based fix for this exact bug class).
#[cfg(unix)]
#[test]
fn a_dot_gitignore_that_is_a_symlink_is_refused_for_both_read_and_write() {
    let repo = TempRepo::init("repo_files_symlink");
    let path = repo.path();

    // A file OUTSIDE the repo entirely — the thing a malicious symlink
    // could disclose/overwrite if this bug were still present.
    let outside_dir = std::env::temp_dir().join(format!("gitcat-test-repo-files-outside-{}", std::process::id()));
    std::fs::create_dir_all(&outside_dir).unwrap();
    let outside_file = outside_dir.join("secret.txt");
    std::fs::write(&outside_file, "SECRET OUTSIDE CONTENT\n").unwrap();

    let gitignore_path = repo.dir.join(".gitignore");
    std::os::unix::fs::symlink(&outside_file, &gitignore_path).expect("failed to create symlink");

    let read_res = tauri::async_runtime::block_on(read_repo_file(path.clone(), ".gitignore".to_string()));
    assert!(read_res.is_err(), "reading through a symlinked .gitignore must be refused, not silently disclose the target's content");
    assert!(
        !read_res.unwrap_err().is_empty(),
        "expected a clear error message"
    );

    let write_res = tauri::async_runtime::block_on(write_repo_file(path, ".gitignore".to_string(), "malicious content\n".to_string()));
    assert!(!write_res.ok, "writing through a symlinked .gitignore must be refused, not silently overwrite the target");

    // The outside file must be completely untouched.
    assert_eq!(
        std::fs::read_to_string(&outside_file).unwrap(),
        "SECRET OUTSIDE CONTENT\n",
        "the symlink target outside the repo must never be read from or written to"
    );
    // The symlink itself must still be a symlink — never silently replaced.
    assert!(
        std::fs::symlink_metadata(&gitignore_path).unwrap().file_type().is_symlink(),
        "the symlink at .gitignore must be left exactly as it was"
    );

    let _ = std::fs::remove_dir_all(&outside_dir);
}
