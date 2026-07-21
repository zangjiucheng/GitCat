//! Pluggable external diff/merge tools (backlog #12) — an app-level JSON
//! settings file (mirrors `repo_registry.rs`'s persistence shape EXACTLY:
//! same `app_config_dir()` location, same plain non-`AppHandle` `load_from`/
//! `save_to` pair for integration-test friendliness, same corrupt-file
//! rename-aside recovery, same atomic tmp+rename write, same process-wide
//! poison-recovered `Mutex`) PLUS two invocation commands that delegate
//! ENTIRELY to `git difftool`/`git mergetool`.
//!
//! ## Why there is no blob-extraction/temp-file code here at all
//!
//! Real `git difftool`/`git mergetool` already do 100% of the file
//! materialization/invocation/cleanup work internally. Empirically confirmed
//! (git 2.50.1, throwaway repos, fake shell-script "tools" — never a real GUI
//! tool):
//!   * `git difftool -y -t <name> -- <file>` (no range/flag) → LOCAL = a temp
//!     blob of the index/HEAD content, REMOTE = the literal worktree path —
//!     the correct unstaged-diff semantics.
//!   * Same, with `--cached` inserted before `--`, → LOCAL = a temp blob of
//!     HEAD, REMOTE = a temp blob of the INDEX content — the correct
//!     staged-diff semantics (confirmed by layering a FURTHER unstaged edit
//!     on top and verifying REMOTE ignored it).
//!   * `git difftool -y -t <name> <fromRev>..<toRev> -- <file>` → both sides
//!     are temp blobs of each rev's tree. For a single selected commit `c`,
//!     `fromRev = c+"^"`, `toRev = c` reproduces exactly the diff Detail.svelte
//!     already shows for every file status (A/M/D/R/T/C) — a diff IS already
//!     a two-revision comparison, so no deleted-file special case is needed.
//!   * `-y`/`--no-prompt` fully suppresses the "Launch 'X' [Y/n]?" prompt. A
//!     one-off custom tool works WITHOUT touching the user's real gitconfig
//!     via `-c difftool.<name>.cmd=<cmd>` (confirmed non-persisting).
//!   * `git mergetool -y --tool=<name> -- <file>` similarly suppresses the
//!     launch prompt; the SEPARATE "Was the merge successful?" prompt is
//!     suppressed too, ONLY once `mergetool.<name>.trustExitCode=true` is
//!     ALSO set — confirmed this combination auto-STAGES the resolved file
//!     (index goes from unmerged stages 1/2/3 straight to a resolved stage 0,
//!     no manual `git add` needed) and, on a nonzero exit from the tool,
//!     correctly leaves the file `UU` with no hang either way.
//!     `mergetool.keepBackup=false` (a GLOBAL, not per-tool, key) is set
//!     alongside it — confirmed it suppresses the stray `<file>.orig` backup
//!     git otherwise leaves behind, so a resolved conflict never leaves an
//!     extra untracked file for Workdir to show.
//!   * `trustExitCode=true` is REQUIRED, not just convenient: re-verified
//!     that WITHOUT it, git's own default "did $MERGED actually change"
//!     heuristic reports "seems unchanged" and fails EVEN for a tool that
//!     genuinely wrote a correct, complete resolution — removing the
//!     override would break ordinary successful resolutions, not just the
//!     failure case below. But blindly trusting exit code cuts both ways:
//!     an adversarial review reproduced a tool that exits 0 WITHOUT ever
//!     touching the file (crashed, misconfigured, closed without doing
//!     anything) getting reported as a successful resolution and auto-
//!     staged verbatim, conflict markers and all. Since git's own signal
//!     can't be trusted here either way, `resolve_conflict_with_external_
//!     tool_inner` runs its OWN independent safety net: it compares the
//!     file's raw bytes immediately before and after invoking the tool, and
//!     overrides a reported "success" to `ok: false` if the content is
//!     byte-for-byte unchanged — see that function's own comment.
//!   * `git config --get diff.tool`/`merge.tool` exits 1 with empty stdout
//!     when unset — a clean "nothing configured" signal, matching the
//!     `identity.rs`/`rerere.rs` `run_git`-style read convention.
//!
//! So `conflict.rs`'s existing `ConflictFile` (capped, lossy, UI-display-only
//! text) is irrelevant here — this module never manually extracts BASE/LOCAL/
//! REMOTE blob content, exactly like `git am`/`git rebase`/`git merge` are
//! already delegated to wholesale elsewhere in this codebase rather than
//! reimplemented via git2.
//!
//! ## Read/invoke split
//!
//! [`open_diff_tool`] is FIRE-AND-FORGET (`Command::spawn`, never `.output()`/
//! `.wait()`): viewing a diff mutates nothing, the user opens a separate tool
//! window and keeps using GitCat concurrently, so there is nothing to wait
//! for or report back. [`resolve_conflict_with_external_tool`] BLOCKS
//! (`Command::output`) — GitCat needs the outcome (did the file get
//! resolved/staged?) to update the conflict UI, exactly mirroring
//! `conflict::resolve_conflict_file`'s own contract (same `ResolveResult`
//! shape, reused directly rather than duplicated). It is a peer of that
//! function's "Take ours"/"Take theirs" actions for a SINGLE conflicted file
//! — not a new op or conflict-handling path: once `git mergetool` auto-stages
//! the file, the existing per-op Continue button (already gated on
//! `conflict_status`'s `remaining` count) finishes the op with zero new
//! dispatch logic once every file reaches 0.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Wry};

use crate::conflict;
use crate::procutil::NoConsoleWindowExt;
use crate::safety::{self, GitOut};

const FILE_NAME: &str = "external_tools.json";
const SCHEMA_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// One configured external tool (diff OR merge — same shape for both).
#[derive(Serialize, Deserialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalTool {
    /// A git-recognized built-in tool name (e.g. `"meld"`, `"opendiff"`,
    /// `"vscode"`, `"kdiff3"`, `"bc"`, `"p4merge"`, `"tortoisemerge"`, …) OR an
    /// arbitrary name of the user's own choosing when `cmd` is `Some`.
    /// Validated at save time (see [`normalize_tool`]) to
    /// `[A-Za-z0-9_-]+` — this is embedded verbatim into a
    /// `-c difftool.<name>.cmd=…`/`-c mergetool.<name>.cmd=…` CONFIG-KEY
    /// subsection at invocation time, and git's dotted `-c` shorthand has no
    /// way to escape a literal `.` inside a subsection name — restricting the
    /// charset at the one place the user types it removes that ambiguity
    /// entirely, rather than re-validating (and risking getting it subtly
    /// wrong) at every invocation call site.
    pub name: String,
    /// `None` => rely ENTIRELY on git's own knowledge of `name` (either a
    /// built-in git ships, or something the user already set in their own
    /// gitconfig under `difftool.<name>.cmd`/`mergetool.<name>.cmd`) — no
    /// `-c …cmd=` override is passed at all. `Some(cmd)` => a one-off
    /// `-c difftool.<name>.cmd=<cmd>`/`-c mergetool.<name>.cmd=<cmd>`
    /// override for a tool git doesn't already know, using git's own
    /// `$LOCAL`/`$REMOTE`/`$BASE`/`$MERGED` placeholders — user-authored
    /// shell text with the SAME trust boundary as e.g. `submodule.rs`'s
    /// foreach command (the user is typing a command for their OWN
    /// machine); no sanitization beyond the charset check on `name` above.
    pub cmd: Option<String>,
}

/// App-level (NOT per-repo) tool preferences — a personal cross-repo setting
/// exactly like a real git client's tool prefs, persisted as one small JSON
/// file under `app_config_dir()`.
#[derive(Serialize, Deserialize, Clone, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolSettings {
    pub diff_tool: Option<ExternalTool>,
    pub merge_tool: Option<ExternalTool>,
}

#[derive(Serialize, Deserialize)]
struct SettingsFile {
    version: u32,
    diff_tool: Option<ExternalTool>,
    merge_tool: Option<ExternalTool>,
}

// ---------------------------------------------------------------------------
// Persistence (mirrors repo_registry.rs's shape line-for-line)
// ---------------------------------------------------------------------------

fn settings_path(app: &AppHandle<Wry>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Could not resolve app config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create app config dir: {e}"))?;
    Ok(dir.join(FILE_NAME))
}

/// Read the settings file at `path`. Missing file => `ToolSettings::default()`
/// (both `None` — first run), never an error.
///
/// A malformed/corrupt file does NOT hard-lock the user out of the settings
/// modal forever: it's renamed aside to
/// `external_tools.json.corrupt-<unix-seconds>` (best-effort — if even that
/// fails, e.g. a read-only directory, we still proceed rather than
/// compounding one failure into a second one) and the default is returned,
/// exactly like a first run. Nothing is silently DESTROYED — the corrupt
/// bytes survive on disk under the backup name for forensics/manual
/// recovery — but the app is never permanently locked out by it. Identical
/// recovery story to `repo_registry::load_from`.
///
/// `pub` for the same integration-testability reason as
/// `repo_registry::load_from`: the integration suite
/// (`tests/tool_settings.rs`) can drive the real persistence logic directly
/// against a throwaway temp file without needing a real `AppHandle`.
pub fn load_from(path: &Path) -> Result<ToolSettings, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ToolSettings::default()),
        Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
    };
    match serde_json::from_str::<SettingsFile>(&text) {
        Ok(file) => Ok(ToolSettings { diff_tool: file.diff_tool, merge_tool: file.merge_tool }),
        Err(_) => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let backup = path.with_file_name(format!(
                "{}.corrupt-{now}",
                path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| FILE_NAME.to_string())
            ));
            let _ = std::fs::rename(path, &backup); // best-effort; proceed regardless
            Ok(ToolSettings::default())
        }
    }
}

/// Process-wide lock serializing every settings read-modify-write sequence —
/// identical rationale/shape to `repo_registry::registry_lock`: without it,
/// two concurrent writers each doing an unlocked load -> mutate -> save could
/// let "last write wins" silently drop the loser's change. A poisoned lock (a
/// prior panic mid-critical-section) is recovered from rather than
/// propagated.
fn settings_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

/// `pub` for the same integration-testability reason as [`load_from`]. Writes
/// via a same-directory temp file + atomic rename (never a direct in-place
/// `fs::write`) so a crash/power-loss mid-write can never leave a
/// half-written, corrupt `external_tools.json` behind.
pub fn save_to(path: &Path, settings: &ToolSettings) -> Result<(), String> {
    let file = SettingsFile {
        version: SCHEMA_VERSION,
        diff_tool: settings.diff_tool.clone(),
        merge_tool: settings.merge_tool.clone(),
    };
    let json = serde_json::to_string_pretty(&file).map_err(|e| format!("Could not serialize: {e}"))?;
    let mut tmp_name = path.as_os_str().to_os_string();
    tmp_name.push(".tmp");
    let tmp_path = PathBuf::from(tmp_name);
    std::fs::write(&tmp_path, &json).map_err(|e| format!("Could not write {}: {e}", tmp_path.display()))?;
    std::fs::rename(&tmp_path, path).map_err(|e| format!("Could not finalize {}: {e}", path.display()))
}

/// Trim + validate one tool's `name`/`cmd`. Blank name => `None` (clears the
/// tool back to "unset", which falls through to the user's own real
/// gitconfig — see [`resolve_diff_tool`]/[`resolve_merge_tool`]). Blank cmd
/// => `None` (falls back to git's own knowledge of `name`). This is the ONE
/// place `name`'s charset is enforced — see [`ExternalTool::name`]'s doc.
pub fn normalize_tool(t: Option<ExternalTool>) -> Result<Option<ExternalTool>, String> {
    let Some(t) = t else { return Ok(None) };
    let name = t.name.trim().to_string();
    if name.is_empty() {
        return Ok(None);
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("Tool name {name:?} may only contain letters, digits, '-' and '_'."));
    }
    let cmd = t.cmd.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
    Ok(Some(ExternalTool { name, cmd }))
}

// ---------------------------------------------------------------------------
// Fallback-to-gitconfig resolution
// ---------------------------------------------------------------------------

/// GitCat's own setting wins if set; else fall back to the user's own
/// already-configured `diff.tool` (empirically confirmed: `git config --get
/// diff.tool` exits 1/empty stdout when unset — a clean "nothing configured"
/// signal). `cmd` is always `None` in the fallback case: GitCat never invents
/// an override for a tool it didn't itself resolve.
fn resolve_diff_tool(path: &str, configured: Option<ExternalTool>) -> Option<ExternalTool> {
    if configured.is_some() {
        return configured;
    }
    resolve_from_gitconfig(path, "diff.tool")
}

/// Same fallback for `merge.tool`.
fn resolve_merge_tool(path: &str, configured: Option<ExternalTool>) -> Option<ExternalTool> {
    if configured.is_some() {
        return configured;
    }
    resolve_from_gitconfig(path, "merge.tool")
}

fn resolve_from_gitconfig(path: &str, key: &str) -> Option<ExternalTool> {
    let out = safety::run_git(path, &["config", "--get", key]).ok()?;
    if !out.ok {
        return None;
    }
    let name = out.stdout.trim();
    (!name.is_empty()).then(|| ExternalTool { name: name.to_string(), cmd: None })
}

// ---------------------------------------------------------------------------
// Pure argv builders (unit-testable, no subprocess, no repo needed)
// ---------------------------------------------------------------------------

/// Build the `git difftool` argv, EXCLUDING the leading `-C <repo>` (the
/// caller adds that — see [`open_diff_tool_inner`] — since it differs between
/// the fire-and-forget `Command::spawn` path used here and
/// `safety::run_git`'s own `-C` handling used by the blocking merge-tool
/// path).
fn build_difftool_argv(file: &str, staged: bool, from_rev: &Option<String>, to_rev: &Option<String>, tool: &ExternalTool) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(cmd) = &tool.cmd {
        args.push("-c".to_string());
        args.push(format!("difftool.{}.cmd={cmd}", tool.name));
    }
    args.push("difftool".into());
    args.push("-y".into());
    args.push("-t".into());
    args.push(tool.name.clone());
    match (from_rev, to_rev) {
        (Some(from), Some(to)) => args.push(format!("{from}..{to}")),
        _ if staged => args.push("--cached".into()),
        _ => {}
    }
    args.push("--".into());
    args.push(file.to_string());
    args
}

/// Build the `git mergetool` argv, EXCLUDING the leading `-C <repo>` (passed
/// via `safety::run_git`'s own `repo` param at the call site).
/// `mergetool.<name>.trustExitCode=true` and the global `mergetool.
/// keepBackup=false` are ALWAYS present — see the module doc's empirical
/// notes on why both are required to fully suppress prompts and avoid a
/// stray `<file>.orig`.
fn build_mergetool_argv(file: &str, tool: &ExternalTool) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(cmd) = &tool.cmd {
        args.push("-c".to_string());
        args.push(format!("mergetool.{}.cmd={cmd}", tool.name));
    }
    args.push("-c".into());
    args.push(format!("mergetool.{}.trustExitCode=true", tool.name));
    args.push("-c".into());
    args.push("mergetool.keepBackup=false".into());
    args.push("mergetool".into());
    args.push("-y".into());
    args.push(format!("--tool={}", tool.name));
    args.push("--".into());
    args.push(file.to_string());
    args
}

// ---------------------------------------------------------------------------
// Small duplicated helpers (per this codebase's own stated convention —
// workdir.rs's module doc: "duplicating small per-module helpers/constants
// rather than reaching across module boundaries")
// ---------------------------------------------------------------------------

/// Reject an arg that could be read as a flag or carries a NUL/newline. Same
/// 3 checks as `conflict.rs`'s own `validate_path`, renamed since this also
/// guards `from_rev`/`to_rev`, not just a file path.
fn validate_arg(s: &str) -> Result<(), String> {
    if s.is_empty() {
        return Err("No value given.".into());
    }
    if s.starts_with('-') {
        return Err(format!("Refusing a value that looks like a flag: {s:?}"));
    }
    if s.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err("Value has an illegal NUL/newline character.".into());
    }
    Ok(())
}

/// Count files still unmerged — identical one-liner to `conflict.rs`'s own
/// `remaining_conflicts`.
fn remaining_conflicts(path: &str) -> usize {
    match safety::run_git(path, &["diff", "--name-only", "--diff-filter=U"]) {
        Ok(o) if o.ok => o.stdout.lines().filter(|l| !l.trim().is_empty()).count(),
        _ => 0,
    }
}

/// Best human message from a failed git run (prefer stderr) — identical copy
/// to every other module's own (`identity.rs`, `rerere.rs`, `conflict.rs`).
fn err_msg(o: &GitOut) -> String {
    if !o.stderr.is_empty() {
        o.stderr.clone()
    } else if !o.stdout.is_empty() {
        o.stdout.clone()
    } else {
        format!("git exited with status {}", o.code)
    }
}

const HINT: &str = "Set one via Tools \u{25b8} External Tools\u{2026}.";

// ---------------------------------------------------------------------------
// Commands: settings CRUD
// ---------------------------------------------------------------------------

/// JS: `commands.getToolSettings()`.
#[tauri::command]
#[specta::specta]
pub fn get_tool_settings(app: AppHandle<Wry>) -> Result<ToolSettings, String> {
    load_from(&settings_path(&app)?)
}

/// Whole-form overwrite (the settings modal always submits both slots at
/// once) — no read-modify-write needed, unlike `repo_registry`'s list
/// mutations, but still lock-guarded for the same cheap-insurance reason.
/// JS: `commands.setToolSettings(diffTool, mergeTool)`.
#[tauri::command]
#[specta::specta]
pub fn set_tool_settings(app: AppHandle<Wry>, diff_tool: Option<ExternalTool>, merge_tool: Option<ExternalTool>) -> Result<ToolSettings, String> {
    let _guard = settings_lock().lock().unwrap_or_else(|e| e.into_inner());
    let path = settings_path(&app)?;
    let settings = ToolSettings { diff_tool: normalize_tool(diff_tool)?, merge_tool: normalize_tool(merge_tool)? };
    save_to(&path, &settings)?;
    Ok(settings)
}

// ---------------------------------------------------------------------------
// Command: open_diff_tool (FIRE-AND-FORGET spawn — read-only, see module doc)
// ---------------------------------------------------------------------------

/// JS: `commands.openDiffTool(path, file, staged, fromRev, toRev)`.
///
/// `staged` and a rev range are mutually exclusive; if a range is given, both
/// `fromRev`/`toRev` must be given (or neither). Refuses cleanly (spawns
/// nothing) when no tool is configured (and none of the user's own gitconfig
/// either), pointing at the settings entry point.
///
/// FIRE-AND-FORGET: spawns and returns immediately — nothing about git state
/// changes from viewing a diff, so there is nothing to wait for or report
/// back.
///
/// **Accepted limitation**: because this is mandated fire-and-forget, if the
/// resolved tool `name` is one git doesn't actually know (a typo, or a
/// built-in name the installed git version doesn't ship) with no `cmd`
/// override, the spawned process fails fast (`git difftool` exits 128 with a
/// clear stderr) but this command never inspects that exit code — the user
/// gets no in-app error, only whatever a dev-mode terminal shows. Mitigated
/// by the settings modal's own hint text, not solved here.
///
/// BUG FIX: was a plain (non-async) `fn` — `open_diff_tool_inner` opens the
/// repository with git2 (`crate::trust::open_repo`) before it ever spawns the
/// external tool, and on a WSL/UNC path that open can itself stall for real
/// seconds (the same class of stall `dashboard_repo_status`/`workdir_status`
/// were fixed for). Even though the spawn itself is fire-and-forget, that
/// leading git2 open still ran inline on Tauri's main thread, freezing the
/// whole app window for its duration. `async fn` + `run_blocking` moves the
/// whole body onto Tauri's blocking-task thread pool.
#[tauri::command]
#[specta::specta]
pub async fn open_diff_tool(
    app: AppHandle<Wry>,
    path: String,
    file: String,
    staged: bool,
    from_rev: Option<String>,
    to_rev: Option<String>,
) -> Result<(), String> {
    crate::blocking::run_blocking(move || {
        let settings = load_from(&settings_path(&app)?)?;
        open_diff_tool_inner(settings.diff_tool, &path, &file, staged, from_rev, to_rev)
    })
    .await
}

/// Plain, `AppHandle`-free inner (same split as `watch.rs`/`git_bisect.rs`/
/// `repo_registry.rs`) so the integration suite can call this directly with a
/// FAKE tool `cmd` (a short shell script), never a real GUI tool.
pub fn open_diff_tool_inner(
    configured: Option<ExternalTool>,
    path: &str,
    file: &str,
    staged: bool,
    from_rev: Option<String>,
    to_rev: Option<String>,
) -> Result<(), String> {
    validate_arg(file)?;
    if let Some(r) = &from_rev {
        validate_arg(r)?;
    }
    if let Some(r) = &to_rev {
        validate_arg(r)?;
    }
    if from_rev.is_some() != to_rev.is_some() {
        return Err("fromRev and toRev must both be given, or both omitted.".into());
    }
    if staged && from_rev.is_some() {
        return Err("A specific revision range and `staged` are mutually exclusive.".into());
    }
    if let Err(e) = crate::trust::open_repo(path) {
        return Err(format!("Cannot open repository: {}", e.message()));
    }
    let tool = resolve_diff_tool(path, configured)
        .ok_or_else(|| format!("No external diff tool configured. {HINT}"))?;
    let args = build_difftool_argv(file, staged, &from_rev, &to_rev, &tool);
    std::process::Command::new("git")
        .no_console_window()
        .arg("-C")
        .arg(path)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Could not launch git difftool: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Command: resolve_conflict_with_external_tool (BLOCKING — needs the outcome)
// ---------------------------------------------------------------------------

/// JS: `commands.resolveConflictWithExternalTool(path, file)`. BLOCKS on the
/// mergetool subprocess (needs the outcome). Returns `conflict::ResolveResult`
/// directly (reused, not duplicated — same `{ok, remaining, message}` shape
/// and same non-`Result` "never rejects" contract as `resolve_conflict_file`).
///
/// BUG FIX: was a plain (non-async) `fn`, and of every command fixed in this
/// pass this is the worst instance of the bug: `resolve_conflict_with_
/// external_tool_inner` runs `git mergetool` via `safety::run_git`'s
/// `Command::output`, which blocks until that subprocess exits — and that
/// subprocess is an interactive GUI diff/merge tool the USER is actively
/// editing in, with no timeout, so the wait is unbounded and entirely at the
/// user's own pace (seconds to however long they take to finish resolving).
/// As a plain sync command this froze the entire app window — not just the
/// conflict panel — for that whole open-ended duration. `async fn` +
/// `run_blocking` moves the wait onto Tauri's blocking-task thread pool so
/// the rest of the app stays responsive while the external tool is open.
#[tauri::command]
#[specta::specta]
pub async fn resolve_conflict_with_external_tool(app: AppHandle<Wry>, path: String, file: String) -> conflict::ResolveResult {
    crate::blocking::run_blocking(move || {
        let settings_path = match settings_path(&app) {
            Ok(p) => p,
            Err(e) => return conflict::ResolveResult { ok: false, remaining: 0, message: e },
        };
        let settings = match load_from(&settings_path) {
            Ok(s) => s,
            Err(e) => return conflict::ResolveResult { ok: false, remaining: 0, message: e },
        };
        resolve_conflict_with_external_tool_inner(settings.merge_tool, &path, &file)
    })
    .await
}

/// Plain, `AppHandle`-free inner — same rationale as [`open_diff_tool_inner`].
pub fn resolve_conflict_with_external_tool_inner(configured: Option<ExternalTool>, path: &str, file: &str) -> conflict::ResolveResult {
    if let Err(e) = validate_arg(file) {
        return conflict::ResolveResult { ok: false, remaining: 0, message: e };
    }
    // A double-quote in the filename makes real `git mergetool` fail with a
    // confusing, unexplained "file not found" (an adversarial review
    // isolated this to a quoting bug in git's own `git-mergetool--lib.sh`,
    // reproduced with plain git and no GitCat code involved at all —
    // `open_diff_tool` is unaffected, confirmed separately). Not exploitable
    // (fails closed, no corruption) but worth a clear upfront message rather
    // than forwarding git's misleading one.
    if file.contains('"') {
        return conflict::ResolveResult {
            ok: false,
            remaining: remaining_conflicts(path),
            message: format!(
                "{file:?} contains a double-quote character, which git's own mergetool integration can't handle \
                 reliably — resolve this file manually instead."
            ),
        };
    }
    let repo = match crate::trust::open_repo(path) {
        Ok(r) => r,
        Err(e) => {
            return conflict::ResolveResult {
                ok: false,
                remaining: 0,
                message: format!("Cannot open repository: {}", e.message()),
            }
        }
    };
    // SAME allowlist as `resolve_conflict_file` (`conflict::detect_op`,
    // `pub(crate)` — see conflict.rs's own doc comment): only ever act inside
    // an op GitCat itself snapshotted and can Abort/Continue from the app.
    let op = match conflict::detect_op(&repo) {
        Ok(o) => o,
        Err(e) => {
            return conflict::ResolveResult {
                ok: false,
                remaining: 0,
                message: format!("cannot inspect repository state: {}", e.message()),
            }
        }
    };
    if !matches!(op, "cherry-pick" | "merge" | "rebase" | "revert" | "stash" | "merge-squash" | "am") {
        return conflict::ResolveResult {
            ok: false,
            remaining: 0,
            message: format!(
                "Not inside a cherry-pick, merge, rebase, revert, stash, squash-merge, or patch-apply conflict \
                 (repository state: {op}). Resolve {op} conflicts with git on the command line."
            ),
        };
    }
    let tool = match resolve_merge_tool(path, configured) {
        Some(t) => t,
        None => {
            return conflict::ResolveResult {
                ok: false,
                remaining: 0,
                message: format!("No external merge tool configured. {HINT}"),
            }
        }
    };
    // Captured BEFORE invoking the tool — see the safety-net check below.
    let file_path = Path::new(path).join(file);
    let before = std::fs::read(&file_path).ok();

    let args = build_mergetool_argv(file, &tool);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = match safety::run_git(path, &arg_refs) {
        Ok(o) => o,
        Err(e) => {
            return conflict::ResolveResult {
                ok: false,
                remaining: remaining_conflicts(path),
                message: format!("Could not run git mergetool: {e}"),
            }
        }
    };
    let remaining = remaining_conflicts(path);
    if out.ok {
        // Independent safety net, NOT relying on git's own `trustExitCode`
        // machinery: `mergetool.<name>.trustExitCode=true` is REQUIRED for
        // any non-interactive custom `cmd` to work at all (empirically
        // re-confirmed: WITHOUT it, git's own mtime/backup-based "did
        // $MERGED change" heuristic reports "seems unchanged" and fails
        // EVEN for a tool that genuinely wrote a correct resolution — so
        // removing it would break the happy path, not just the failure
        // case below) — but that same blind exit-code trust means a tool
        // that exits 0 WITHOUT actually touching the file (crashed,
        // misconfigured, the user closed it without doing anything) gets
        // reported as a successful resolution and auto-staged verbatim,
        // conflict markers and all. An adversarial review reproduced this
        // exactly. Since we can't trust git's own signal here, compare the
        // file's raw bytes before/after ourselves: if content is BYTE-
        // IDENTICAL to what it was before the tool ran, the tool provably
        // changed nothing, regardless of what git/the exit code claims.
        let after = std::fs::read(&file_path).ok();
        let genuinely_unchanged = before.is_some() && before == after;
        if genuinely_unchanged {
            return conflict::ResolveResult {
                ok: false,
                remaining,
                message: format!(
                    "The external tool exited successfully but didn't actually change {file} — nothing was \
                     resolved. git may still have marked it as resolved in the index; use Abort to fully \
                     restore the original conflict rather than continuing."
                ),
            };
        }
        let message = if remaining == 0 {
            format!("Resolved {file} with the external tool. All conflicts resolved — Continue to finish.")
        } else {
            format!("Resolved {file} with the external tool. {remaining} file(s) still conflicted.")
        };
        conflict::ResolveResult { ok: true, remaining, message }
    } else {
        let stderr = err_msg(&out);
        let message = if !stderr.is_empty() {
            stderr
        } else {
            format!("The external tool did not report a successful resolution for {file}.")
        };
        conflict::ResolveResult { ok: false, remaining, message }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "gitcat-tool-settings-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ))
    }

    #[test]
    fn missing_file_loads_as_default_not_an_error() {
        let dir = temp_dir("missing");
        let path = dir.join(FILE_NAME);
        assert!(!path.exists());
        let settings = load_from(&path).expect("missing file should load default, not error");
        assert!(settings.diff_tool.is_none());
        assert!(settings.merge_tool.is_none());
    }

    #[test]
    fn corrupt_file_recovers_as_default_and_backs_up_the_original_bytes() {
        let dir = temp_dir("corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, "not json at all").unwrap();
        let result = load_from(&path).expect("corrupt file should recover, not hard-error and lock out the settings modal");
        assert!(result.diff_tool.is_none());
        assert!(result.merge_tool.is_none());
        assert!(!path.exists(), "the corrupt file must be renamed aside");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = temp_dir("roundtrip");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);

        let settings = ToolSettings {
            diff_tool: Some(ExternalTool { name: "meld".into(), cmd: None }),
            merge_tool: Some(ExternalTool { name: "mytool".into(), cmd: Some("mytool $BASE $LOCAL $REMOTE $MERGED".into()) }),
        };
        save_to(&path, &settings).expect("save_to failed");

        let loaded = load_from(&path).expect("load_from failed");
        assert_eq!(loaded.diff_tool.as_ref().unwrap().name, "meld");
        assert!(loaded.diff_tool.as_ref().unwrap().cmd.is_none());
        assert_eq!(loaded.merge_tool.as_ref().unwrap().name, "mytool");
        assert_eq!(loaded.merge_tool.as_ref().unwrap().cmd.as_deref(), Some("mytool $BASE $LOCAL $REMOTE $MERGED"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_writers_never_lose_a_write() {
        // Regression-shaped test mirroring repo_registry.rs's own: several
        // threads each save a DIFFERENT settings value under the same lock;
        // the final state must be exactly one of the writes, never a
        // corrupted half-write from an unlocked race.
        let dir = temp_dir("concurrent");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);

        const WRITERS: usize = 12;
        std::thread::scope(|scope| {
            for i in 0..WRITERS {
                let path = &path;
                scope.spawn(move || {
                    let _guard = settings_lock().lock().unwrap_or_else(|e| e.into_inner());
                    let mut settings = load_from(path).expect("load under lock should succeed");
                    settings.diff_tool = Some(ExternalTool { name: format!("tool{i}"), cmd: None });
                    save_to(path, &settings).expect("save under lock should succeed");
                });
            }
        });

        let settings = load_from(&path).expect("final load should succeed");
        let name = settings.diff_tool.expect("some writer's value must have survived").name;
        assert!(name.starts_with("tool"), "unexpected/corrupted final value: {name:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalize_tool_blank_name_clears() {
        let t = ExternalTool { name: "   ".into(), cmd: Some("whatever".into()) };
        assert!(normalize_tool(Some(t)).unwrap().is_none());
        assert!(normalize_tool(None).unwrap().is_none());
    }

    #[test]
    fn normalize_tool_invalid_charset_rejected() {
        let t = ExternalTool { name: "diff.tool".into(), cmd: None };
        let err = normalize_tool(Some(t)).unwrap_err();
        assert!(err.contains("letters, digits"), "unexpected message: {err}");
    }

    #[test]
    fn normalize_tool_blank_cmd_becomes_none() {
        let t = ExternalTool { name: "meld".into(), cmd: Some("   ".into()) };
        let normalized = normalize_tool(Some(t)).unwrap().unwrap();
        assert_eq!(normalized.name, "meld");
        assert!(normalized.cmd.is_none());
    }

    #[test]
    fn normalize_tool_trims_whitespace() {
        let t = ExternalTool { name: "  meld  ".into(), cmd: Some("  cat $LOCAL  ".into()) };
        let normalized = normalize_tool(Some(t)).unwrap().unwrap();
        assert_eq!(normalized.name, "meld");
        assert_eq!(normalized.cmd.as_deref(), Some("cat $LOCAL"));
    }

    #[test]
    fn build_difftool_argv_unstaged_no_range() {
        let tool = ExternalTool { name: "meld".into(), cmd: None };
        let args = build_difftool_argv("f.txt", false, &None, &None, &tool);
        assert_eq!(args, vec!["difftool", "-y", "-t", "meld", "--", "f.txt"]);
    }

    #[test]
    fn build_difftool_argv_staged() {
        let tool = ExternalTool { name: "meld".into(), cmd: None };
        let args = build_difftool_argv("f.txt", true, &None, &None, &tool);
        assert_eq!(args, vec!["difftool", "-y", "-t", "meld", "--cached", "--", "f.txt"]);
    }

    #[test]
    fn build_difftool_argv_ranged_ignores_staged() {
        let tool = ExternalTool { name: "meld".into(), cmd: None };
        let args = build_difftool_argv("f.txt", true, &Some("abc^".into()), &Some("abc".into()), &tool);
        assert_eq!(args, vec!["difftool", "-y", "-t", "meld", "abc^..abc", "--", "f.txt"]);
    }

    #[test]
    fn build_difftool_argv_custom_cmd_adds_override() {
        let tool = ExternalTool { name: "mytool".into(), cmd: Some("code --wait --diff $LOCAL $REMOTE".into()) };
        let args = build_difftool_argv("f.txt", false, &None, &None, &tool);
        assert_eq!(
            args,
            vec!["-c", "difftool.mytool.cmd=code --wait --diff $LOCAL $REMOTE", "difftool", "-y", "-t", "mytool", "--", "f.txt"]
        );
    }

    #[test]
    fn build_mergetool_argv_no_cmd_omits_override_but_keeps_trust_and_backup_flags() {
        let tool = ExternalTool { name: "opendiff".into(), cmd: None };
        let args = build_mergetool_argv("f.txt", &tool);
        assert_eq!(
            args,
            vec![
                "-c",
                "mergetool.opendiff.trustExitCode=true",
                "-c",
                "mergetool.keepBackup=false",
                "mergetool",
                "-y",
                "--tool=opendiff",
                "--",
                "f.txt"
            ]
        );
    }

    #[test]
    fn build_mergetool_argv_custom_cmd_present() {
        let tool = ExternalTool { name: "mytool".into(), cmd: Some("mytool $BASE $LOCAL $REMOTE $MERGED".into()) };
        let args = build_mergetool_argv("f.txt", &tool);
        assert_eq!(
            args,
            vec![
                "-c",
                "mergetool.mytool.cmd=mytool $BASE $LOCAL $REMOTE $MERGED",
                "-c",
                "mergetool.mytool.trustExitCode=true",
                "-c",
                "mergetool.keepBackup=false",
                "mergetool",
                "-y",
                "--tool=mytool",
                "--",
                "f.txt"
            ]
        );
    }

    #[test]
    fn validate_arg_rejects_empty_flaglike_and_newline() {
        assert!(validate_arg("").is_err());
        assert!(validate_arg("-x").is_err());
        assert!(validate_arg("a\nb").is_err());
        assert!(validate_arg("f.txt").is_ok());
    }
}
