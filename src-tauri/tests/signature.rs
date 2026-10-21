//! Commit signature badge (signature.rs): the verdict comes from git's own
//! `%G?`, so these drive a real git. An unsigned commit must read as "none".
//! The signed cases use SSH signing (`gpg.format=ssh`), which needs only
//! `ssh-keygen` — no gpg keyring — and are skipped (not failed) on a machine
//! where ssh-keygen or ssh signing isn't available. Every `%G?` letter is
//! also pinned as a pure mapping in signature.rs's own unit tests.

mod common;

use std::process::Command;

use common::TempRepo;
use gitcat_lib::signature::{commit_signature, SigStatus};

fn verify(repo: &TempRepo, sha: &str) -> gitcat_lib::signature::CommitSignature {
    tauri::async_runtime::block_on(commit_signature(repo.path(), sha.to_string())).expect("commit_signature failed")
}

#[test]
fn unsigned_commit_reads_as_none() {
    let repo = TempRepo::init("sig_unsigned");
    let c0 = repo.commit("f.txt", "0\n", "c0");
    let sig = verify(&repo, &c0);
    assert_eq!(sig.status, SigStatus::None);
    assert_eq!(sig.code, "N");
    assert_eq!(sig.sha, c0);
    assert!(sig.signer.is_empty() && sig.key.is_empty());
}

#[test]
fn short_sha_resolves_to_the_full_oid() {
    let repo = TempRepo::init("sig_short_sha");
    let c0 = repo.commit("f.txt", "0\n", "c0");
    let sig = verify(&repo, &c0[..7]);
    assert_eq!(sig.sha, c0, "the verdict must be keyed by the full oid, whatever form was asked for");
}

#[test]
fn unknown_commit_is_an_error_not_a_verdict() {
    let repo = TempRepo::init("sig_unknown");
    repo.commit("f.txt", "0\n", "c0");
    let res = tauri::async_runtime::block_on(commit_signature(repo.path(), "deadbeefdeadbeef".into()));
    assert!(res.is_err(), "a sha that doesn't resolve must not come back as 'none'");
}

#[test]
fn a_flag_shaped_sha_never_reaches_git() {
    let repo = TempRepo::init("sig_flag");
    repo.commit("f.txt", "0\n", "c0");
    let res = tauri::async_runtime::block_on(commit_signature(repo.path(), "--output=x".into()));
    assert!(res.is_err());
    assert!(!repo.dir.join("x").exists());
}

/// Make an ssh-signed commit. `None` (test skipped) when this machine can't.
fn ssh_signed_commit(repo: &TempRepo) -> Option<(String, String)> {
    let key = repo.dir.join(".sigkey");
    let ok = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-C", "test@gitcat.example", "-f"])
        .arg(&key)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !ok {
        eprintln!("skipping: ssh-keygen unavailable");
        return None;
    }
    let key_s = key.to_string_lossy().replace('\\', "/");
    repo.must(&["config", "gpg.format", "ssh"]);
    repo.must(&["config", "user.signingkey", &key_s]);
    std::fs::write(repo.dir.join("f.txt"), "signed\n").unwrap();
    repo.must(&["add", "f.txt"]);
    let (ok, _, err) = repo.git(&["commit", "-q", "--no-verify", "-S", "-m", "signed"]);
    if !ok {
        eprintln!("skipping: ssh signing unavailable: {err}");
        return None;
    }
    let pubkey = std::fs::read_to_string(format!("{}.pub", key.display())).unwrap();
    Some((repo.must(&["rev-parse", "HEAD"]), pubkey.trim().to_string()))
}

#[test]
fn ssh_signed_commit_without_allowed_signers_is_unverified_not_bad() {
    let repo = TempRepo::init("sig_ssh_unverified");
    repo.commit("base.txt", "0\n", "c0");
    let Some((sha, _)) = ssh_signed_commit(&repo) else { return };
    let sig = verify(&repo, &sha);
    // No gpg.ssh.allowedSignersFile -> git can't check it. git itself even
    // reports "N" here (no signature!) with only an stderr complaint; the
    // commit IS signed, so it must read as unverified — neither "unsigned"
    // nor "bad" — with git's complaint as the reason.
    assert_eq!(sig.status, SigStatus::Unverified, "code was {:?}", sig.code);
    assert!(sig.detail.contains("allowedSignersFile"), "detail was {:?}", sig.detail);
}

#[test]
fn ssh_signed_commit_with_allowed_signers_is_good() {
    let repo = TempRepo::init("sig_ssh_good");
    repo.commit("base.txt", "0\n", "c0");
    let Some((sha, pubkey)) = ssh_signed_commit(&repo) else { return };
    let allowed = repo.dir.join(".allowed_signers");
    std::fs::write(&allowed, format!("test@gitcat.example {pubkey}\n")).unwrap();
    repo.must(&["config", "gpg.ssh.allowedSignersFile", &allowed.to_string_lossy().replace('\\', "/")]);
    let sig = verify(&repo, &sha);
    assert_eq!(sig.status, SigStatus::Good, "code was {:?}", sig.code);
    assert_eq!(sig.signer, "test@gitcat.example");
    assert!(!sig.key.is_empty(), "the key/fingerprint should reach the tooltip");
}
