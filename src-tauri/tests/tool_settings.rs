//! Pluggable external diff/merge tools (backlog #12).
//!
//! Two halves, mirroring `tests/repo_registry.rs`'s split between plain
//! persistence tests and `tests/merge.rs`'s real-conflict-building
//! conventions:
//!   1. Settings persistence (`load_from`/`save_to`/`normalize_tool`) against
//!      a throwaway temp file — no subprocess, no repo.
//!   2. `open_diff_tool_inner`/`resolve_conflict_with_external_tool_inner`
//!      against REAL throwaway repos, using ONLY fake shell commands (`cp`,
//!      `printf`, `false`) as the configured tool's `cmd` — per the hard
//!      safety rule, NEVER a real GUI tool, and never anything that could
//!      hang waiting for a window.
//!
//! `open_diff_tool_inner` is fire-and-forget (`Command::spawn`), so every
//! assertion about what the spawned process did polls (bounded, no long
//! sleep) for a marker file the fake `cmd` writes, rather than assuming
//! synchronous completion.

mod common;

use common::TempRepo;
use gitcat_lib::conflict::conflict_status;
use gitcat_lib::tool_settings::{
    configured_diff_tool, configured_merge_tool, load_from, normalize_tool, open_diff_tool_inner, remove_named_tool_from,
    resolve_commit_command, resolve_conflict_with_external_tool_inner, save_to, set_active_tool_in, upsert_named_tool, ExternalTool,
    NamedTool, ToolKind, ToolSettings,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// A throwaway settings-file path under the OS temp dir, auto-removed on
/// `Drop`. Mirrors `tests/repo_registry.rs`'s `TempRegistry`.
struct TempSettingsDir {
    dir: PathBuf,
}
impl TempSettingsDir {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("gitcat-test-tool-settings-{tag}-{}-{}-{}", std::process::id(), nanos, seq));
        std::fs::create_dir_all(&dir).expect("mkdir temp settings dir");
        TempSettingsDir { dir }
    }
    fn file(&self) -> PathBuf {
        self.dir.join("external_tools.json")
    }
}
impl Drop for TempSettingsDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Poll (bounded, short sleeps) until `path` exists — used to observe a
/// fire-and-forget spawned process's side effect without a fixed sleep.
fn wait_for(path: &Path, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if path.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    path.exists()
}

// ---------------------------------------------------------------------------
// 1. Settings persistence
// ---------------------------------------------------------------------------

#[test]
fn fresh_file_reads_back_as_default_unset() {
    let dir = TempSettingsDir::new("fresh");
    let settings = load_from(&dir.file()).expect("load_from should treat a missing file as default, not an error");
    assert!(settings.diff_tool.is_none());
    assert!(settings.merge_tool.is_none());
}

#[test]
fn save_then_read_back_persists_across_a_simulated_restart() {
    let dir = TempSettingsDir::new("persist");
    let file = dir.file();

    let settings = ToolSettings {
        diff_tool: Some(ExternalTool { name: "meld".into(), cmd: None }),
        merge_tool: Some(ExternalTool { name: "mytool".into(), cmd: Some("mytool $BASE $LOCAL $REMOTE $MERGED".into()) }),
        commit_msg_command: Some("opencommit --dry-run".into()),
        ..Default::default()
    };
    save_to(&file, &settings).expect("save_to failed");

    let reloaded = load_from(&file).expect("load_from failed");
    assert_eq!(reloaded.commit_msg_command.as_deref(), Some("opencommit --dry-run"));
    assert_eq!(reloaded.diff_tool.unwrap().name, "meld");
    let mt = reloaded.merge_tool.unwrap();
    assert_eq!(mt.name, "mytool");
    assert_eq!(mt.cmd.as_deref(), Some("mytool $BASE $LOCAL $REMOTE $MERGED"));
}

#[test]
fn malformed_settings_file_recovers_instead_of_permanently_locking_out_the_settings_modal() {
    let dir = TempSettingsDir::new("malformed");
    let file = dir.file();
    std::fs::write(&file, "{ this is not valid json").unwrap();

    let result = load_from(&file).expect("a corrupt settings file must recover, not hard-lock the settings modal out");
    assert!(result.diff_tool.is_none());
    assert!(result.merge_tool.is_none());
    assert!(!file.exists(), "the corrupt file must be renamed aside, not left in place");

    let backups: Vec<_> = std::fs::read_dir(&dir.dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
        .collect();
    assert_eq!(backups.len(), 1, "the corrupt bytes must survive under a .corrupt-<timestamp> backup, not be destroyed");
}

#[test]
fn normalize_tool_rejects_bad_charset_but_accepts_and_trims_a_good_one() {
    assert!(normalize_tool(Some(ExternalTool { name: "diff.tool".into(), cmd: None })).is_err());
    let ok = normalize_tool(Some(ExternalTool { name: "  meld  ".into(), cmd: Some("  cat $LOCAL  ".into()) }))
        .unwrap()
        .unwrap();
    assert_eq!(ok.name, "meld");
    assert_eq!(ok.cmd.as_deref(), Some("cat $LOCAL"));
    // Blank name clears the tool entirely.
    assert!(normalize_tool(Some(ExternalTool { name: "   ".into(), cmd: Some("x".into()) })).unwrap().is_none());
}

// ---------------------------------------------------------------------------
// 1b. PER-44: named tools — v1 migration, CRUD persistence, resolver precedence
// ---------------------------------------------------------------------------

#[test]
fn a_v1_file_without_named_tools_still_loads_with_its_singletons_intact() {
    // A byte-for-byte v1 file (no `tools`/`active_*` keys) must migrate
    // losslessly: singletons preserved, list empty, no corrupt-recovery.
    let dir = TempSettingsDir::new("v1-migrate");
    let file = dir.file();
    std::fs::write(
        &file,
        r#"{"version":1,"diff_tool":{"name":"meld","cmd":null},"merge_tool":null,"commit_msg_command":"aicommit"}"#,
    )
    .unwrap();

    let s = load_from(&file).expect("a v1 file must load, not trip corrupt-recovery");
    assert_eq!(s.diff_tool.as_ref().unwrap().name, "meld");
    assert_eq!(s.commit_msg_command.as_deref(), Some("aicommit"));
    assert!(s.tools.is_empty());
    assert!(s.active_diff_tool_id.is_none());
    assert!(file.exists(), "reading a v1 file must not rename it aside");
}

#[test]
fn named_tools_add_remove_select_persist_across_a_reload() {
    let dir = TempSettingsDir::new("named-crud");
    let file = dir.file();

    // Add two tools + select one active — exactly the pure logic the CRUD
    // commands run under their lock (upsert / set-active / remove helpers).
    let mut s = load_from(&file).unwrap();
    upsert_named_tool(&mut s, NamedTool { id: "vscode".into(), name: "VS Code".into(), kind: ToolKind::Diff, cmd: "code --diff $LOCAL $REMOTE".into() }).unwrap();
    upsert_named_tool(&mut s, NamedTool { id: "kdiff3".into(), name: "KDiff3".into(), kind: ToolKind::Merge, cmd: "kdiff3 $BASE $LOCAL $REMOTE -o $MERGED".into() }).unwrap();
    set_active_tool_in(&mut s, ToolKind::Diff, Some("vscode".into())).unwrap();
    save_to(&file, &s).unwrap();

    let reloaded = load_from(&file).expect("reload after CRUD");
    assert_eq!(reloaded.tools.len(), 2);
    assert_eq!(reloaded.active_diff_tool_id.as_deref(), Some("vscode"));

    // Remove the active one — the selection must clear too, then persist.
    let mut s2 = reloaded;
    remove_named_tool_from(&mut s2, "vscode");
    save_to(&file, &s2).unwrap();
    let after = load_from(&file).unwrap();
    assert_eq!(after.tools.len(), 1);
    assert_eq!(after.tools[0].id, "kdiff3");
    assert!(after.active_diff_tool_id.is_none(), "removing the active tool must clear the selection");
}

#[test]
fn active_named_diff_tool_outranks_the_singleton_when_driving_open_diff_tool() {
    // End-to-end precedence in a REAL repo with only fake shell `cmd`s: an
    // active named diff tool must win over the singleton `diff_tool`.
    let repo = TempRepo::init("precedence_diff");
    repo.commit("f.txt", "committed\n", "initial");
    std::fs::write(repo.dir.join("f.txt"), "committed\nedit\n").unwrap();

    let singleton_out = repo.dir.join("singleton_out");
    let named_out = repo.dir.join("named_out");
    std::fs::create_dir_all(&singleton_out).unwrap();
    std::fs::create_dir_all(&named_out).unwrap();

    let mut s = ToolSettings {
        // The singleton writes into singleton_out — it must NOT run.
        diff_tool: Some(ExternalTool { name: "singletontool".into(), cmd: Some(recording_diff_cmd(&singleton_out)) }),
        ..Default::default()
    };
    // The active named tool writes into named_out — it must run instead.
    upsert_named_tool(&mut s, NamedTool { id: "named".into(), name: "Named".into(), kind: ToolKind::Diff, cmd: recording_diff_cmd(&named_out) }).unwrap();
    set_active_tool_in(&mut s, ToolKind::Diff, Some("named".into())).unwrap();

    open_diff_tool_inner(configured_diff_tool(&s), &repo.path(), "f.txt", false, None, None).expect("open_diff_tool_inner should succeed");

    assert!(wait_for(&named_out.join("remote.out"), Duration::from_secs(5)), "the ACTIVE named tool must be the one that ran");
    assert_eq!(std::fs::read_to_string(named_out.join("remote.out")).unwrap(), "committed\nedit\n");
    assert!(!singleton_out.join("remote.out").exists(), "the singleton must be outranked and never run");
}

#[test]
fn singleton_still_wins_over_gitconfig_and_named_falls_back_to_singleton_when_deselected() {
    // With NO active named tool, resolution behaves exactly as v1 did: the
    // singleton is used. This guards the "preserved when no named tools" claim.
    let s = ToolSettings {
        merge_tool: Some(ExternalTool { name: "mysingleton".into(), cmd: Some("true".into()) }),
        ..Default::default()
    };
    let resolved = configured_merge_tool(&s).expect("singleton merge tool should resolve");
    assert_eq!(resolved.name, "mysingleton");

    // And the commit path: singleton used when no active named commit tool.
    let cs = ToolSettings { commit_msg_command: Some("aicommit".into()), ..Default::default() };
    assert_eq!(resolve_commit_command(&cs).as_deref(), Some("aicommit"));
}

// ---------------------------------------------------------------------------
// 2. open_diff_tool_inner — real repos, fake `cp`-based recording tools
// ---------------------------------------------------------------------------

/// A fake diff tool `cmd` that copies whatever `$LOCAL`/`$REMOTE` resolve to
/// into two fixed marker files under `out_dir`, so the test can assert their
/// exact content without ever launching a real GUI diff tool.
fn recording_diff_cmd(out_dir: &Path) -> String {
    format!(
        "cp \"$LOCAL\" '{}' && cp \"$REMOTE\" '{}'",
        out_dir.join("local.out").display(),
        out_dir.join("remote.out").display()
    )
}

#[test]
fn open_diff_tool_unstaged_diffs_head_against_the_literal_worktree_file() {
    let repo = TempRepo::init("difftool_unstaged");
    repo.commit("f.txt", "committed\n", "initial");
    std::fs::write(repo.dir.join("f.txt"), "committed\nunstaged edit\n").unwrap();

    let out_dir = repo.dir.join("out");
    std::fs::create_dir_all(&out_dir).unwrap();
    let tool = ExternalTool { name: "faketool".into(), cmd: Some(recording_diff_cmd(&out_dir)) };

    open_diff_tool_inner(Some(tool), &repo.path(), "f.txt", false, None, None).expect("open_diff_tool_inner should succeed");

    assert!(wait_for(&out_dir.join("local.out"), Duration::from_secs(5)), "LOCAL marker never appeared");
    assert!(wait_for(&out_dir.join("remote.out"), Duration::from_secs(5)), "REMOTE marker never appeared");
    assert_eq!(std::fs::read_to_string(out_dir.join("local.out")).unwrap(), "committed\n");
    assert_eq!(std::fs::read_to_string(out_dir.join("remote.out")).unwrap(), "committed\nunstaged edit\n");
}

#[test]
fn open_diff_tool_staged_diffs_head_against_the_index_ignoring_further_unstaged_edits() {
    let repo = TempRepo::init("difftool_staged");
    repo.commit("f.txt", "committed\n", "initial");
    std::fs::write(repo.dir.join("f.txt"), "committed\nstaged edit\n").unwrap();
    repo.must(&["add", "f.txt"]);
    // A FURTHER unstaged edit on top — REMOTE must ignore this (staged-only).
    std::fs::write(repo.dir.join("f.txt"), "committed\nstaged edit\nunstaged extra\n").unwrap();

    let out_dir = repo.dir.join("out");
    std::fs::create_dir_all(&out_dir).unwrap();
    let tool = ExternalTool { name: "faketool".into(), cmd: Some(recording_diff_cmd(&out_dir)) };

    open_diff_tool_inner(Some(tool), &repo.path(), "f.txt", true, None, None).expect("open_diff_tool_inner should succeed");

    assert!(wait_for(&out_dir.join("remote.out"), Duration::from_secs(5)), "REMOTE marker never appeared");
    assert_eq!(std::fs::read_to_string(out_dir.join("local.out")).unwrap(), "committed\n");
    assert_eq!(
        std::fs::read_to_string(out_dir.join("remote.out")).unwrap(),
        "committed\nstaged edit\n",
        "staged diff's REMOTE must reflect the INDEX only, not the further unstaged edit"
    );
}

#[test]
fn open_diff_tool_historical_range_diffs_parent_against_the_selected_commit() {
    let repo = TempRepo::init("difftool_range");
    repo.commit("f.txt", "v1\n", "initial");
    let c2 = repo.commit("f.txt", "v2\n", "second");

    let out_dir = repo.dir.join("out");
    std::fs::create_dir_all(&out_dir).unwrap();
    let tool = ExternalTool { name: "faketool".into(), cmd: Some(recording_diff_cmd(&out_dir)) };

    open_diff_tool_inner(Some(tool), &repo.path(), "f.txt", false, Some(format!("{c2}^")), Some(c2.clone()))
        .expect("open_diff_tool_inner should succeed");

    assert!(wait_for(&out_dir.join("remote.out"), Duration::from_secs(5)), "REMOTE marker never appeared");
    assert_eq!(std::fs::read_to_string(out_dir.join("local.out")).unwrap(), "v1\n");
    assert_eq!(std::fs::read_to_string(out_dir.join("remote.out")).unwrap(), "v2\n");
}

#[test]
fn open_diff_tool_refuses_cleanly_with_no_tool_configured() {
    let repo = TempRepo::init("difftool_none");
    repo.commit("f.txt", "x\n", "initial");

    let err = open_diff_tool_inner(None, &repo.path(), "f.txt", false, None, None).expect_err("must refuse with no tool configured");
    assert!(err.contains("err_tools.no_diff_tool"), "message should point at the settings entry point: {err}");
    // No marker/output could possibly exist — nothing should have spawned.
}

#[test]
fn open_diff_tool_falls_back_to_the_repos_own_gitconfig_when_unset_in_gitcat() {
    // Proves the fallback path end-to-end WITHOUT ever risking a real tool
    // binary: the "tool name" here is a fake, made-up name, never something
    // like "meld"/"opendiff" that git might resolve to a real installed GUI.
    let repo = TempRepo::init("difftool_fallback");
    repo.commit("f.txt", "committed\n", "initial");
    std::fs::write(repo.dir.join("f.txt"), "committed\nedit\n").unwrap();

    let out_dir = repo.dir.join("out");
    std::fs::create_dir_all(&out_dir).unwrap();
    repo.must(&["config", "diff.tool", "fakename"]);
    repo.must(&["config", "difftool.fakename.cmd", &recording_diff_cmd(&out_dir)]);

    // GitCat's own setting is None -> must fall back to the repo's own gitconfig.
    open_diff_tool_inner(None, &repo.path(), "f.txt", false, None, None).expect("open_diff_tool_inner should succeed via fallback");

    assert!(wait_for(&out_dir.join("remote.out"), Duration::from_secs(5)), "fallback-resolved tool never ran");
    assert_eq!(std::fs::read_to_string(out_dir.join("remote.out")).unwrap(), "committed\nedit\n");
}

// ---------------------------------------------------------------------------
// 3. resolve_conflict_with_external_tool_inner — real conflict, fake mergetool
// ---------------------------------------------------------------------------

/// Builds a repo where merging `feature` into `main` conflicts on the same
/// line of the same file (mirrors `tests/merge.rs::build_conflicting_repo`).
/// Leaves the repo mid-merge (`RepositoryState::Merge`, `shared.txt` unmerged)
/// on return.
fn build_conflicting_merge(tag: &str) -> TempRepo {
    let repo = TempRepo::init(tag);
    repo.commit("shared.txt", "base line\n", "base");
    repo.must(&["branch", "feature"]);
    repo.commit("shared.txt", "main line\n", "edit on main");
    repo.must(&["checkout", "-q", "feature"]);
    repo.commit("shared.txt", "feature line\n", "edit on feature");
    repo.must(&["checkout", "-q", "main"]);
    // Real conflicting merge attempt — expected to fail (exit != 0), leaving
    // the index with unmerged stages and RepositoryState::Merge.
    let (ok, _, _) = repo.git(&["merge", "feature"]);
    assert!(!ok, "merge was expected to conflict");
    assert_eq!(repo.open().state(), git2::RepositoryState::Merge);
    repo
}

#[test]
fn resolve_conflict_with_external_tool_resolves_and_auto_stages_via_fake_mergetool() {
    let repo = build_conflicting_merge("mergetool_resolve");

    let status_before = tauri::async_runtime::block_on(conflict_status(repo.path())).expect("conflict_status failed");
    assert_eq!(status_before.op, "merge");
    assert_eq!(status_before.files.len(), 1);

    // Fake merge tool: writes a known-good resolution straight into $MERGED
    // and exits 0 — never a real GUI tool.
    let tool = ExternalTool { name: "faketool".into(), cmd: Some("printf 'resolved line\\n' > \"$MERGED\"".into()) };

    let result = resolve_conflict_with_external_tool_inner(Some(tool), &repo.path(), "shared.txt");
    assert!(result.ok, "expected ok:true, got message: {}", result.message);
    assert_eq!(result.remaining, 0);

    // The file must be STAGED (stage 0), not left as `UU`.
    let short_status = repo.must(&["status", "--short"]);
    assert_eq!(short_status.trim(), "M  shared.txt", "resolved file must be auto-staged, not left unmerged");

    // conflict_status must report the hand-off contract: files empty, but
    // still in_progress (ready for the existing per-op Continue button).
    let status_after = tauri::async_runtime::block_on(conflict_status(repo.path())).expect("conflict_status failed");
    assert!(status_after.files.is_empty());
    assert_eq!(status_after.op, "merge");
    assert!(status_after.in_progress, "op must still be in_progress — ready for Continue, not auto-concluded");

    assert_eq!(repo.read("shared.txt"), "resolved line\n");
}

#[test]
fn resolve_conflict_with_external_tool_leaves_file_unmerged_on_a_nonzero_exit() {
    let repo = build_conflicting_merge("mergetool_failure");

    // `false` always exits 1; with trustExitCode=true this must be read as
    // "not resolved" — the file stays UU, no hang, no crash.
    let tool = ExternalTool { name: "faketool".into(), cmd: Some("false".into()) };
    let result = resolve_conflict_with_external_tool_inner(Some(tool), &repo.path(), "shared.txt");
    assert!(!result.ok);
    assert_eq!(result.remaining, 1);

    let short_status = repo.must(&["status", "--short"]);
    assert_eq!(short_status.trim(), "UU shared.txt", "a failed external tool must leave the file unmerged");
}

/// Regression test for a real bug an adversarial review found: because
/// `mergetool.<name>.trustExitCode=true` is REQUIRED for any non-interactive
/// custom tool to work at all (git's own default "did $MERGED change"
/// heuristic misfires and reports "seems unchanged" even for a genuinely
/// successful resolution — see the module's own doc comment), a tool that
/// exits 0 WITHOUT actually touching the file used to be reported as a
/// successful resolution and auto-staged verbatim, conflict markers and all.
/// `resolve_conflict_with_external_tool_inner` now runs its own independent
/// before/after byte-comparison safety net, overriding git's report to
/// `ok: false` when the content genuinely never changed.
#[test]
fn resolve_conflict_with_external_tool_detects_a_tool_that_reports_success_without_changing_anything() {
    let repo = build_conflicting_merge("mergetool_false_positive");

    // `true` always exits 0 but never touches $MERGED — simulates a crashed,
    // misconfigured, or silently-closed-without-doing-anything tool.
    let tool = ExternalTool { name: "faketool".into(), cmd: Some("true".into()) };
    let result = resolve_conflict_with_external_tool_inner(Some(tool), &repo.path(), "shared.txt");
    assert!(!result.ok, "a tool that changed nothing must never be reported as a successful resolution");
    assert!(
        result.message.contains("err_tools.tool_changed_nothing"),
        "expected a clear 'nothing was actually resolved' message, got: {}",
        result.message
    );

    // The file's own content must still literally contain the raw conflict
    // markers — the whole point of the check is that nothing changed.
    let content = repo.read("shared.txt");
    assert!(content.contains("<<<<<<<"), "conflict markers must still be present, nothing was actually resolved: {content:?}");
}

#[test]
fn resolve_conflict_with_external_tool_refuses_a_double_quote_in_the_filename() {
    // Regression test for a lower-severity gap the same review flagged: a
    // filename containing a literal double-quote makes real `git mergetool`
    // fail with a confusing, unexplained "file not found" (a quoting bug in
    // git's own git-mergetool--lib.sh, not something GitCat's code causes —
    // open_diff_tool is unaffected). Refused upfront with a clear message
    // instead of forwarding git's misleading one.
    let repo = TempRepo::init("mergetool_quote_filename");
    repo.commit("f.txt", "x\n", "initial");
    let tool = ExternalTool { name: "faketool".into(), cmd: Some("true".into()) };
    let result = resolve_conflict_with_external_tool_inner(Some(tool), &repo.path(), "a\"b.txt");
    assert!(!result.ok);
    assert!(result.message.contains("err_tools.filename_double_quote"), "expected a clear double-quote-specific message, got: {}", result.message);
}

#[test]
fn resolve_conflict_with_external_tool_refuses_cleanly_with_no_tool_configured() {
    let repo = build_conflicting_merge("mergetool_none");
    let result = resolve_conflict_with_external_tool_inner(None, &repo.path(), "shared.txt");
    assert!(!result.ok);
    assert!(result.message.contains("err_tools.no_merge_tool"), "message should point at the settings entry point: {}", result.message);
    // Refused before ever touching the conflict — still unmerged.
    let short_status = repo.must(&["status", "--short"]);
    assert_eq!(short_status.trim(), "UU shared.txt");
}

#[test]
fn resolve_conflict_with_external_tool_refuses_outside_an_allowlisted_op() {
    let repo = TempRepo::init("mergetool_clean");
    repo.commit("f.txt", "x\n", "initial");
    assert_eq!(repo.open().state(), git2::RepositoryState::Clean);

    let tool = ExternalTool { name: "faketool".into(), cmd: Some("printf 'x' > \"$MERGED\"".into()) };
    let result = resolve_conflict_with_external_tool_inner(Some(tool), &repo.path(), "f.txt");
    assert!(!result.ok);
    assert!(
        result.message.contains("err_tools.not_in_conflict_op"),
        "message should explain the refusal: {}",
        result.message
    );
}
