//! What on-disk format a repository uses, read straight from its config file.
//!
//! libgit2 (1.9) refuses to open a repository whose `extensions.*` it doesn't
//! know, and says so in its own terms: "unknown object format 'sha256'",
//! "unsupported extension name extensions.refstorage". This module reads the
//! repository's `config` itself — no git2, no git process — so it works on a
//! repo libgit2 can't open, on a `\\wsl.localhost\` path, and before the
//! dubious-ownership trust step. Two consumers:
//!
//!   * opening a repo: when libgit2 fails, [`detect`] says why in words a user
//!     can act on (`commands::load_graph`);
//!   * the 2.0 op log: [`RepoFormat::oplog_writable`] is the gate that keeps
//!     it from writing into a repository whose object or ref format it can't
//!     read back (design §2.7 — an unreadable view must never be mistaken for
//!     "every ref was deleted").
//!
//! Extensions are only in effect from `core.repositoryformatversion = 1`, as
//! in git itself; a version-0 repo's stray `extensions.*` keys are ignored.

use std::path::{Path, PathBuf};
use std::sync::Once;

/// Extensions GitCat opens repositories with, beyond the ones libgit2 knows
/// itself. `partialclone`: git before 2.27 recorded a partial clone's promisor
/// remote here (newer git uses `remote.<name>.promisor`), and GitCat fetches
/// missing blobs from it (`promisor.rs`). Never `refstorage`: libgit2 checks
/// the name, not the value, so registering it would also open reftable repos
/// and read their refs as empty.
const EXTRA_LIBGIT2_EXTENSIONS: &[&str] = &["partialclone"];

/// Every extension name (lowercase) GitCat can open a repository with: what
/// libgit2 1.9 supports built in plus [`EXTRA_LIBGIT2_EXTENSIONS`]. A test
/// checks this against `git2::opts::get_extensions()`, so a libgit2 upgrade
/// that changes the list fails loudly instead of drifting.
const OPENABLE_EXTENSIONS: &[&str] =
    &["noop", "objectformat", "preciousobjects", "relativeworktrees", "worktreeconfig", "partialclone"];

static REGISTER: Once = Once::new();

/// Register [`EXTRA_LIBGIT2_EXTENSIONS`] with libgit2. Idempotent; called at
/// startup before any thread opens a repository, and again (a no-op by then)
/// from `trust::open_repo`, so tests and any other entry point get it too.
pub fn register_libgit2_extensions() {
    REGISTER.call_once(|| {
        // SAFETY: libgit2 keeps this list in a process-global. `Once` makes
        // this the only write, and the startup call runs it before any other
        // thread exists to read it.
        if let Err(e) = unsafe { git2::opts::set_extensions(EXTRA_LIBGIT2_EXTENSIONS) } {
            log::warn!("could not register libgit2 extensions {EXTRA_LIBGIT2_EXTENSIONS:?}: {}", e.message());
        }
    });
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoFormat {
    /// `core.repositoryformatversion` (0 when absent).
    pub version: u32,
    /// `extensions.objectFormat`, lowercase; `"sha1"` when absent or version 0.
    pub object_format: String,
    /// `extensions.refStorage`, lowercase; `"files"` when absent or version 0.
    pub ref_storage: String,
    /// Every other `extensions.*` name (lowercase) in effect that GitCat can't
    /// open a repository with.
    pub unknown_extensions: Vec<String>,
}

/// Why GitCat can't work with a repository, most specific first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unsupported {
    /// `core.repositoryformatversion` above 1.
    Version(u32),
    /// SHA-256 object names (`extensions.objectFormat = sha256`).
    Sha256,
    /// The reftable ref backend (`extensions.refStorage = reftable`).
    Reftable,
    /// Any other object format or ref backend, or extensions GitCat doesn't know.
    Extensions(Vec<String>),
}

impl RepoFormat {
    /// What, if anything, keeps GitCat (libgit2) from opening this repository.
    pub fn unsupported(&self) -> Option<Unsupported> {
        if self.version > 1 {
            return Some(Unsupported::Version(self.version));
        }
        if self.object_format == "sha256" {
            return Some(Unsupported::Sha256);
        }
        if self.ref_storage == "reftable" {
            return Some(Unsupported::Reftable);
        }
        let mut odd = self.unknown_extensions.clone();
        if self.object_format != "sha1" {
            odd.push(format!("objectformat={}", self.object_format));
        }
        if self.ref_storage != "files" {
            odd.push(format!("refstorage={}", self.ref_storage));
        }
        (!odd.is_empty()).then_some(Unsupported::Extensions(odd))
    }

    /// The 2.0 op-log gate: a SHA-1, files-backend repository with nothing
    /// GitCat can't read. Anything else gets the legacy safety log only.
    pub fn oplog_writable(&self) -> bool {
        self.unsupported().is_none()
    }
}

/// Read the format of the repository at `path` (a working tree, or a bare
/// repository's own directory). `None` when `path` isn't a repository GitCat
/// can find a config for.
pub fn detect(path: &str) -> Option<RepoFormat> {
    let common = common_dir(Path::new(path))?;
    let text = std::fs::read_to_string(common.join("config")).ok()?;
    Some(parse(&text))
}

/// The repository's common git dir: `<path>/.git` (a directory, or a
/// `gitdir:` file as in a linked worktree or submodule), or `path` itself for a
/// bare repository; then followed through `commondir`, which is where a linked
/// worktree's shared `config` lives.
fn common_dir(path: &Path) -> Option<PathBuf> {
    let dotgit = path.join(".git");
    let git_dir = if dotgit.is_dir() {
        dotgit
    } else if dotgit.is_file() {
        let text = std::fs::read_to_string(&dotgit).ok()?;
        let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
        path.join(target)
    } else if path.join("HEAD").is_file() && path.join("config").is_file() {
        path.to_path_buf()
    } else {
        return None;
    };
    match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(rel) => Some(git_dir.join(rel.trim())),
        Err(_) => Some(git_dir),
    }
}

/// The `[core]` and `[extensions]` keys of a git config file. Section and key
/// names are case-insensitive; a bare key (`noop`) is `true`; `#`/`;` start a
/// comment outside quotes. Subsections (`[core "x"]`) are not these sections.
fn parse(text: &str) -> RepoFormat {
    let mut section = String::new();
    let mut version = 0u32;
    let mut object_format: Option<String> = None;
    let mut ref_storage: Option<String> = None;
    let mut others: Vec<String> = Vec::new();
    for raw in text.lines() {
        let line = strip_comment(raw).trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix('[') {
            let name = rest.split(']').next().unwrap_or("").trim();
            section = if name.contains(['"', ' ', '\t']) { String::new() } else { name.to_ascii_lowercase() };
            continue;
        }
        let (key, value) = match line.split_once('=') {
            Some((k, v)) => (k.trim().to_ascii_lowercase(), v.trim().trim_matches('"').to_string()),
            None => (line.to_ascii_lowercase(), "true".to_string()),
        };
        match (section.as_str(), key.as_str()) {
            ("core", "repositoryformatversion") => version = value.parse().unwrap_or(u32::MAX),
            ("extensions", "objectformat") => object_format = Some(value.to_ascii_lowercase()),
            ("extensions", "refstorage") => ref_storage = Some(value.to_ascii_lowercase()),
            ("extensions", name) => {
                if !OPENABLE_EXTENSIONS.contains(&name) && !others.iter().any(|o| o == name) {
                    others.push(name.to_string());
                }
            }
            _ => {}
        }
    }
    if version == 0 {
        // git ignores extensions in a version-0 repository.
        return RepoFormat { version, object_format: "sha1".into(), ref_storage: "files".into(), unknown_extensions: Vec::new() };
    }
    // An explicit refStorage=files names the default backend, but libgit2
    // rejects the key whatever its value (see EXTRA_LIBGIT2_EXTENSIONS for why
    // it isn't registered), so it can't be opened either.
    if ref_storage.as_deref() == Some("files") {
        others.push("refstorage".to_string());
    }
    RepoFormat {
        version,
        object_format: object_format.unwrap_or_else(|| "sha1".into()),
        ref_storage: ref_storage.unwrap_or_else(|| "files".into()),
        unknown_extensions: others,
    }
}

fn strip_comment(line: &str) -> &str {
    let mut quoted = false;
    for (i, c) in line.char_indices() {
        match c {
            '"' => quoted = !quoted,
            '#' | ';' if !quoted => return &line[..i],
            _ => {}
        }
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn fmt(text: &str) -> RepoFormat {
        parse(text)
    }

    #[test]
    fn a_plain_repo_is_sha1_files_and_supported() {
        let f = fmt("[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
        assert_eq!(f, RepoFormat { version: 0, object_format: "sha1".into(), ref_storage: "files".into(), unknown_extensions: vec![] });
        assert!(f.oplog_writable());
    }

    #[test]
    fn sha256_and_reftable_are_named_and_sha256_wins_when_both() {
        let v1 = "[core]\n\trepositoryformatversion = 1\n";
        assert_eq!(fmt(&format!("{v1}[extensions]\n\tobjectFormat = sha256\n")).unsupported(), Some(Unsupported::Sha256));
        assert_eq!(fmt(&format!("{v1}[extensions]\n\trefStorage = reftable\n")).unsupported(), Some(Unsupported::Reftable));
        let both = fmt(&format!("{v1}[Extensions]\n\tRefStorage = Reftable\n\tObjectFormat = SHA256\n"));
        assert_eq!(both.unsupported(), Some(Unsupported::Sha256));
        assert!(!both.oplog_writable());
    }

    #[test]
    fn known_extensions_are_fine_and_unknown_ones_are_listed_once() {
        let f = fmt("[core]\nrepositoryformatversion=1\n[extensions]\nnoop\nworktreeConfig = true\npartialclone = origin\n\
                     preciousObjects = true\nmadeUp = 1\ncompatObjectFormat = sha256\n[extensions]\nmadeup = 2\n");
        assert_eq!(f.unsupported(), Some(Unsupported::Extensions(vec!["madeup".into(), "compatobjectformat".into()])));
    }

    #[test]
    fn version_zero_ignores_extensions_like_git_does() {
        let f = fmt("[core]\nrepositoryformatversion = 0\n[extensions]\nobjectFormat = sha256\nmadeUp\n");
        assert_eq!(f.unsupported(), None);
    }

    #[test]
    fn a_newer_format_version_is_unsupported() {
        assert_eq!(fmt("[core]\nrepositoryformatversion = 2\n").unsupported(), Some(Unsupported::Version(2)));
    }

    #[test]
    fn explicit_ref_storage_files_is_unopenable_by_libgit2() {
        let f = fmt("[core]\nrepositoryformatversion = 1\n[extensions]\nrefStorage = files\n");
        assert_eq!(f.ref_storage, "files");
        assert_eq!(f.unsupported(), Some(Unsupported::Extensions(vec!["refstorage".into()])));
    }

    #[test]
    fn comments_subsections_and_quotes_are_handled() {
        let f = fmt("[core] # c\n\trepositoryformatversion = 1 ; v1\n[extensions \"x\"]\n\tobjectFormat = sha256\n\
                     [extensions]\n\tobjectFormat = \"sha1\" # quoted\n");
        assert_eq!(f.object_format, "sha1");
        assert_eq!(f.unsupported(), None);
    }

    /// OPENABLE_EXTENSIONS must be exactly what libgit2 opens repos with
    /// (built-ins plus our registered extras), or `unsupported()` would lie.
    #[test]
    fn openable_extensions_match_libgit2() {
        register_libgit2_extensions();
        // SAFETY: a read of the process-global list; registration has run.
        let mut got: Vec<String> = unsafe { git2::opts::get_extensions() }.unwrap().iter().flatten().map(|s| s.to_ascii_lowercase()).collect();
        got.sort();
        let mut want: Vec<String> = OPENABLE_EXTENSIONS.iter().map(|s| s.to_string()).collect();
        want.sort();
        assert_eq!(got, want);
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gitcat-repofmt-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn git(args: &[&str]) -> bool {
        Command::new("git").args(args).output().map(|o| o.status.success()).unwrap_or(false)
    }

    #[test]
    fn detect_reads_real_repos_including_worktrees_and_bare() {
        let base = tmp("real");
        let main = base.join("main");
        let m = main.to_str().unwrap();
        assert!(git(&["init", "-q", m]));
        assert!(git(&["-C", m, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c"]));
        assert_eq!(detect(m).unwrap().unsupported(), None);

        // A linked worktree's `.git` is a file; its config is in the common dir.
        let wt = base.join("wt");
        assert!(git(&["-C", m, "worktree", "add", "-q", wt.to_str().unwrap()]));
        assert!(git(&["-C", m, "config", "core.repositoryformatversion", "1"]));
        assert!(git(&["-C", m, "config", "extensions.madeUp", "x"]));
        assert_eq!(detect(wt.to_str().unwrap()).unwrap().unknown_extensions, vec!["madeup".to_string()]);

        let bare = base.join("bare.git");
        assert!(git(&["init", "-q", "--bare", bare.to_str().unwrap()]));
        assert_eq!(detect(bare.to_str().unwrap()).unwrap().unsupported(), None);

        assert_eq!(detect(base.to_str().unwrap()), None, "a plain directory is not a repository");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn detect_names_a_real_sha256_and_reftable_repo() {
        let base = tmp("formats");
        let sha = base.join("sha256");
        if git(&["init", "-q", "--object-format=sha256", sha.to_str().unwrap()]) {
            assert_eq!(detect(sha.to_str().unwrap()).unwrap().unsupported(), Some(Unsupported::Sha256));
        }
        let rt = base.join("reftable");
        // --ref-format needs git 2.45; older git just skips this half.
        if git(&["init", "-q", "--ref-format=reftable", rt.to_str().unwrap()]) {
            assert_eq!(detect(rt.to_str().unwrap()).unwrap().unsupported(), Some(Unsupported::Reftable));
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_pre_2_27_partial_clone_opens_once_registered() {
        let base = tmp("partialclone");
        let p = base.to_str().unwrap();
        assert!(git(&["init", "-q", p]));
        assert!(git(&["-C", p, "config", "core.repositoryformatversion", "1"]));
        assert!(git(&["-C", p, "config", "extensions.partialClone", "origin"]));
        assert_eq!(detect(p).unwrap().unsupported(), None);
        assert!(crate::trust::open_repo(p).is_ok(), "trust::open_repo registers partialclone before opening");
        let _ = std::fs::remove_dir_all(&base);
    }
}
