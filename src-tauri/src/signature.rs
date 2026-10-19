//! Commit signature status for the detail panel's signature badge.
//!
//! Deliberately NOT part of `commit_detail`: verifying a signature shells out
//! to whatever git is configured to verify with (gpg, ssh-keygen for
//! `gpg.format=ssh`, gpgsm for X.509), which can be slow — a cold gpg-agent, a
//! keyring that wants to refresh, a WSL interop round trip. The diff and file
//! tree must never wait on that, so the frontend asks for this separately, for
//! the ONE selected commit only, and the commit list never touches it.
//!
//! Verification is git's own (`%G?` and friends), routed through
//! `wsl::git_command_env`, so a WSL repo verifies with the distro's keyring and
//! allowed-signers file — the same answer `git log --show-signature` would give
//! in that shell. libgit2 can EXTRACT a signature but cannot verify one, which
//! is why this is the git CLI rather than git2.

use std::time::Duration;

use serde::Serialize;

use crate::i18n_err::ierrp;
use crate::procutil::output_with_timeout;

/// How long one verification may take before the badge gives up on it. Well
/// under `SUBPROCESS_TIMEOUT`: this is a badge, not an operation, and a user
/// clicking through commits should not have a slow keyring pile up behind them.
pub const SIGNATURE_TIMEOUT: Duration = Duration::from_secs(8);

/// Signature verdict, collapsed from git's `%G?` letter to what the badge
/// actually distinguishes.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum SigStatus {
    /// `N` — the commit carries no signature at all.
    None,
    /// `G` — good signature from a key the verifier trusts.
    Good,
    /// `U` — the signature is cryptographically good, but the key's validity
    /// is unknown (not certified in the web of trust). Not a failure; it just
    /// doesn't say WHO, only that the key matches.
    Untrusted,
    /// `X` / `Y` — good signature, but the signature or the key has expired.
    Expired,
    /// `B` / `R` — a bad signature, or one made by a revoked key.
    Bad,
    /// `E` (or anything git adds later) — git could not check it at all: no
    /// gpg installed, the public key isn't in the keyring, no
    /// `gpg.ssh.allowedSignersFile`. Says nothing about whether the
    /// signature is valid, so it must never be shown as "bad".
    Unverified,
}

/// Map git's `%G?` letter to a [`SigStatus`]. Pure — the unit tests below pin
/// every letter, since a real signed commit needs a real key to produce most
/// of them.
pub fn map_sig_code(code: &str) -> SigStatus {
    match code.trim() {
        "N" | "" => SigStatus::None,
        "G" => SigStatus::Good,
        "U" => SigStatus::Untrusted,
        "X" | "Y" => SigStatus::Expired,
        "B" | "R" => SigStatus::Bad,
        _ => SigStatus::Unverified, // "E", and any letter a newer git invents
    }
}

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitSignature {
    pub sha: String,         // full oid this verdict is for (the frontend's staleness key)
    pub status: SigStatus,
    pub code: String,        // git's raw %G? letter, for the tooltip/debugging
    pub signer: String,      // %GS — signer name/principal (may be empty)
    pub key: String,         // %GK — key id used to sign (may be empty)
    pub fingerprint: String, // %GF — key fingerprint (may be empty)
    pub detail: String,      // why git could not verify (tooltip), else empty
}

/// The `--format` handed to git: NUL-separated so a signer name containing
/// anything at all can't shift the fields. `%GG` (the verifier's own raw
/// report) goes LAST because it is multi-line: for `E` it is the only place
/// the reason appears — git writes nothing to stderr in that case.
const SIG_FORMAT: &str = "--format=%G?%x00%GS%x00%GK%x00%GF%x00%GG";

/// Parse the stdout of `git log -1 SIG_FORMAT`. Pure, for the tests.
pub fn parse_sig_output(sha: &str, stdout: &str) -> CommitSignature {
    let mut it = stdout.trim_end_matches(['\r', '\n']).split('\0');
    let mut next = || it.next().unwrap_or("").trim().to_string();
    let code = next();
    let signer = next();
    let key = next();
    let fingerprint = next();
    // The raw %GG report, kept in `detail` until resolve_status decides
    // whether this verdict needs a reason at all.
    let report = it.collect::<Vec<_>>().join("\0").trim().to_string();
    CommitSignature { sha: sha.to_string(), status: map_sig_code(&code), code, signer, key, fingerprint, detail: report }
}

/// Tauri command: verify ONE commit's signature with git itself. Read-only.
///
/// `sha` is resolved through libgit2 first (it may be the 7-char abbreviation
/// the graph rows carry), so what reaches the git command line is always a
/// full hex oid — never a user-shaped string git could read as an option.
#[tauri::command]
#[specta::specta]
pub async fn commit_signature(path: String, sha: String) -> Result<CommitSignature, String> {
    crate::blocking::run_blocking(move || commit_signature_inner(&path, &sha)).await
}

pub fn commit_signature_inner(path: &str, sha: &str) -> Result<CommitSignature, String> {
    let (full, has_signature) = {
        let repo = crate::trust::open_repo(path).map_err(|e| ierrp("err_history.cannot_open", &[("detail", e.message())]))?;
        let commit = repo
            .find_commit_by_prefix(sha)
            .map_err(|e| ierrp("err_history.cannot_find_commit", &[("sha", sha), ("detail", e.message())]))?;
        let oid = commit.id();
        // Whether the commit object CARRIES a signature at all — libgit2 can
        // tell that much without verifying anything (see `resolve_status`).
        let signed = repo.extract_signature(&oid, None).is_ok() || repo.extract_signature(&oid, Some("gpgsig-sha256")).is_ok();
        (oid.to_string(), signed)
    };
    // --no-show-signature: a user's `log.showSignature=true` would otherwise
    // prepend gpg's own report to stdout, ahead of the formatted line.
    // LC_ALL=C keeps git's stderr parseable/consistent with the rest of the app.
    // --no-replace-objects: libgit2 above ignores refs/replace, so git must
    // too, or the two could be looking at different commit objects.
    let cmd = crate::wsl::git_command_env(path, &["--no-replace-objects", "log", "-1", "--no-show-signature", SIG_FORMAT, &full], &[("LC_ALL", "C")]);
    let out = output_with_timeout(cmd, SIGNATURE_TIMEOUT).map_err(|e| {
        if e.kind() == std::io::ErrorKind::TimedOut {
            ierrp("err_history.signature_timed_out", &[("secs", &SIGNATURE_TIMEOUT.as_secs().to_string())])
        } else {
            ierrp("err_history.could_not_run_git", &[("detail", &e.to_string())])
        }
    })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let detail = if stderr.is_empty() { format!("git exited with {}", out.status) } else { stderr };
        return Err(ierrp("err_history.signature_check_failed", &[("detail", &detail)]));
    }
    let sig = parse_sig_output(&full, &String::from_utf8_lossy(&out.stdout));
    Ok(resolve_status(sig, has_signature, String::from_utf8_lossy(&out.stderr).trim()))
}

/// Correct git's verdict for the one case where it is misleading: an
/// ssh-signed commit with no `gpg.ssh.allowedSignersFile` configured comes
/// back as `N` ("no signature") with only an stderr complaint and exit 0
/// (verified against git 2.55). Showing a signed commit as "Unsigned" would be
/// wrong, so when the object demonstrably has a signature, `N` becomes
/// "unverified" and git's stderr becomes the tooltip's reason. Pure.
///
/// For an unverified verdict the reason is the LAST non-empty line of the
/// verifier's own report (`%GG`, already in `sig.detail`) — gpg leads with
/// "Signature made …" and ends with the actual complaint — falling back to the
/// first line of git's stderr; every other verdict carries no reason.
pub fn resolve_status(mut sig: CommitSignature, has_signature: bool, stderr: &str) -> CommitSignature {
    if sig.status == SigStatus::None && has_signature {
        sig.status = SigStatus::Unverified;
    }
    let first_line = |s: &str| s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string();
    let last_line = |s: &str| s.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("").to_string();
    sig.detail = if sig.status == SigStatus::Unverified {
        let from_report = last_line(&sig.detail);
        if from_report.is_empty() { first_line(stderr) } else { from_report }
    } else {
        String::new()
    };
    sig
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_sig_code_maps_to_the_documented_status() {
        assert_eq!(map_sig_code("N"), SigStatus::None);
        assert_eq!(map_sig_code(""), SigStatus::None);
        assert_eq!(map_sig_code("G"), SigStatus::Good);
        assert_eq!(map_sig_code("U"), SigStatus::Untrusted);
        assert_eq!(map_sig_code("X"), SigStatus::Expired);
        assert_eq!(map_sig_code("Y"), SigStatus::Expired);
        assert_eq!(map_sig_code("B"), SigStatus::Bad);
        assert_eq!(map_sig_code("R"), SigStatus::Bad);
        // "Cannot be checked" is NOT "bad" — a missing key/gpg says nothing
        // about whether the signature is valid.
        assert_eq!(map_sig_code("E"), SigStatus::Unverified);
        assert_eq!(map_sig_code("?"), SigStatus::Unverified);
    }

    #[test]
    fn parse_splits_nul_separated_fields() {
        let s = parse_sig_output("abc", "G\0Jane Doe <jane@example.com>\0ABCDEF0123456789\0FINGERPRINT\n");
        assert_eq!(s.status, SigStatus::Good);
        assert_eq!(s.code, "G");
        assert_eq!(s.signer, "Jane Doe <jane@example.com>");
        assert_eq!(s.key, "ABCDEF0123456789");
        assert_eq!(s.fingerprint, "FINGERPRINT");
        assert_eq!(s.sha, "abc");
    }

    #[test]
    fn parse_tolerates_an_unsigned_commits_empty_fields() {
        let s = parse_sig_output("abc", "N\0\0\0\n");
        assert_eq!(s.status, SigStatus::None);
        assert!(s.signer.is_empty() && s.key.is_empty() && s.fingerprint.is_empty());
        // ...and even a truncated line doesn't panic.
        assert_eq!(parse_sig_output("abc", "E").status, SigStatus::Unverified);
    }

    #[test]
    fn an_e_verdict_takes_its_reason_from_the_gg_report_not_stderr() {
        let s = parse_sig_output("abc", "E\0\0ABCD\0\0gpg: Signature made Mon\ngpg: Can't check signature: No public key\n");
        let s = resolve_status(s, true, "");
        assert_eq!(s.status, SigStatus::Unverified);
        assert_eq!(s.detail, "gpg: Can't check signature: No public key");
        // A good verdict never carries the raw report into the tooltip.
        let s = resolve_status(parse_sig_output("abc", "G\0x\0k\0f\0gpg: Good signature"), true, "");
        assert!(s.detail.is_empty());
    }

    #[test]
    fn a_signed_commit_git_calls_unsigned_becomes_unverified_with_the_reason() {
        let err = "error: gpg.ssh.allowedSignersFile needs to be configured and exist for ssh signature verification";
        let s = resolve_status(parse_sig_output("abc", "N\0\0\0"), true, err);
        assert_eq!(s.status, SigStatus::Unverified);
        assert_eq!(s.detail, err);
        // A genuinely unsigned commit stays "none", stderr or not.
        let s = resolve_status(parse_sig_output("abc", "N\0\0\0"), false, "");
        assert_eq!(s.status, SigStatus::None);
        assert!(s.detail.is_empty());
        // A real verdict is never overridden.
        let s = resolve_status(parse_sig_output("abc", "G\0x\0k\0f"), true, "noise");
        assert_eq!(s.status, SigStatus::Good);
        assert!(s.detail.is_empty());
    }
}
