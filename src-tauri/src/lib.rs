pub mod askpass; // SSH askpass helper: this same exe, re-launched, answers ssh's host-key-confirmation prompt via a native dialog — see its own module doc
pub mod blame; // read-only line-annotation (git blame) view
pub mod blocking; // run a repo-touching command's body off the main thread — see its own doc comment
pub mod code_search; // Search Code: git-grep-based full-text search of the current checkout (or a chosen historical commit)
pub mod commands;
pub mod conflict;
pub mod dashboard; // backlog #11: minimal per-repo status read for the multi-repo dashboard
pub mod event_util; // safe cross-thread event emit (marshal to main thread) — avoids the off-thread emit()/get_webview deadlock
pub mod file_history; // read-only per-file commit history, following renames (git log --follow)
pub mod filter_repo; // M5c: filter-repo wizard (backup / preview / run / restore)
pub mod fsck; // backlog #13: fsck-based dangling-object recovery (list dangling commits; recovery reuses git_write::create_branch)
pub mod git_pick;
pub mod git_read;
pub mod git_remote; // fetch / pull (ff-only) / push / force_push / push_tag
pub mod git_remote_manage; // Remote CONFIG CRUD: add/rename/set-url/remove/list (fetch/pull/push/push_tag stay in git_remote.rs — see both modules' own doc comments for why they're split)
pub mod git_tag; // Tags: create / delete (push_tag lives in git_remote.rs — see its doc comment)
pub mod git_write;
pub mod workdir; // working-tree status + stage/unstage/discard/commit + stash
pub mod git_bisect; // M3: git bisect (start / mark good|bad|skip / status / reset)
pub mod git_config; // Settings' Git Config panel: generic per-key local/global git config read/write (identity.rs generalized beyond user.name/user.email)
pub mod git_merge; // M6 (stage 1): merge (drag-onto-HEAD) + continue / abort
pub mod git_rebase; // M6 (stage 2): linear rebase onto a target + continue / skip / abort
pub mod git_revert; // M6 (stage 3): revert a single commit onto HEAD + continue / abort
pub mod identity; // Setup wizard: repo-local git identity (user.name/user.email) check + fix
pub mod layout;
pub mod maintenance; // optional background `git maintenance run --auto`, triggered by the frontend's idle timer (opt-in, off by default)
pub mod menu; // native app menu (File/Edit/View/Window/Help)
pub mod model;
pub mod patch; // format-patch export + git am --3way apply (with am's own continue/skip/abort)
pub mod pickaxe; // pickaxe / diff-content search: git log -S/-G across (a subset of) history
pub mod plumbing; // M5b: read-only object-database inspector (commit/tree/blob/tag by rev)
pub mod procutil; // suppresses the console window Windows flashes open per subprocess spawn
pub mod reflog; // M4: reflog rescue (read HEAD reflog + restore to a historical entry)
pub mod repo_files; // backlog #14 (final item): .gitignore/.mailmap in-app editors — allow-listed repo-root file read/write
pub mod repo_registry; // backlog #11: app-level tracked-repos JSON persistence
pub mod repo_summary; // Repository Summary: git-log-derived churn/contributor/activity/problem-area diagnostics
pub mod rerere; // M5a: git-rerere status/toggle panel
pub mod safety; // provided by the Safety-Manager component (exposes snapshot(&Repository))
pub mod submodule; // M1 status (read-only) + M2 init/update + M3 add/sync + M4 deinit/remove
pub mod terminal; // "Open Terminal": a real PTY-backed shell embedded in GitCat's own UI
pub mod plugin_exec; // PER-40: plugin command executor + placeholder grammar (declarative, external-process plugins)
pub mod plugin_lua; // PER-56: embedded Luau plugin scripting runtime (sandboxed, curated host API)
pub mod plugin_registry; // PER-39: app-level plugin registry (plugins.json under app_config_dir) + install/enable/remove CRUD
pub mod tool_settings; // backlog #12: external diff/merge tool settings + delegate entirely to `git difftool`/`git mergetool`
pub mod trust; // auto-trust WSL/UNC-path repos libgit2 refuses as "dubious ownership"
pub mod watch; // live refresh: watch the open repo's git-dir for externally-made changes
pub mod windows; // multi-window: spawn a fresh, fully independent GitCat process, optionally pointed directly at a repo
pub mod cli_shim; // "Install 'gitcat' command in PATH": writes a VS Code `code`-style launcher to /usr/local/bin (macOS)
pub mod updater; // channel-aware "check for updates" (stable vs nightly endpoint + downgrade-allowing comparator)
pub mod wsl; // routes git_remote.rs's/submodule.rs's network commands through wsl.exe on a WSL-path repo, so credentials resolve inside the distro

use tauri::Manager;
use tauri_specta::{collect_commands, Builder};

/// The tauri-specta builder — the SINGLE source of truth for the command set,
/// shared by the running app (`run`) and the bindings-export test below, so the
/// generated `src/ipc/bindings.ts` can never drift from the Rust commands.
fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![
        commands::load_graph,
        // Incremental graph refresh — the cheap snapshot + ancestor recompute
        // that let `reloadGraph` skip a full history re-walk when the commit
        // DAG is unchanged (checkout, branch/tag CRUD, staging).
        commands::graph_fast_refresh,
        commands::head_ancestor_flags,
        commands::commit_detail,
        commands::ancestors_of,
        commands::get_app_info,
        updater::check_for_update,
        // Safety Manager (snapshot / list / global undo / retention prune)
        safety::create_snapshot,
        safety::list_snapshots,
        safety::undo_last,
        safety::undo_last_stashing,
        safety::prune_snapshots,
        // Branch ops
        git_write::list_refs,
        // Backs the sidebar's "Auto" branch-visibility mode — which local
        // branches are already merged into the repo's own default branch
        // (see git_write.rs's own module doc on this command).
        git_write::branch_merge_status,
        git_write::create_branch,
        git_write::checkout,
        git_write::checkout_discard,
        git_write::reset_head_to_commit,
        git_write::delete_branch,
        git_write::rename_branch,
        // Tags: create/delete/push
        git_tag::create_tag,
        git_tag::delete_tag,
        git_remote::push_tag,
        // Workdir: working-tree status + stage/unstage/discard/commit + stash
        workdir::workdir_status,
        workdir::workdir_file_diff,
        workdir::stage_file,
        workdir::unstage_file,
        workdir::stage_all,
        workdir::unstage_all,
        workdir::discard_file,
        // Workdir: hunk/line-level staging (stage/unstage/discard a SUBSET of
        // a file's +/- lines, not the whole file)
        workdir::stage_lines,
        workdir::unstage_lines,
        workdir::discard_lines,
        workdir::commit,
        workdir::stash_list,
        workdir::stash_save,
        workdir::stash_apply,
        workdir::stash_pop,
        workdir::stash_drop,
        workdir::stash_undo_apply,
        workdir::stash_conflict_abort,
        workdir::stash_conflict_continue,
        // Remote sync: fetch / pull (ff-only) / push (push_tag is registered
        // above, in the Tags block, even though it's implemented here).
        // current_upstream is a pure read added for the Tools-menu/⌘K "Pull
        // (Merge)"/"Pull (Rebase)" actions (resolver.svelte.ts's pullMerge/
        // pullRebase) — the topbar Pull button (doPull(), unchanged) never
        // calls it.
        git_remote::fetch,
        git_remote::pull,
        // Optional background repo housekeeping (`git maintenance run --auto`),
        // fired by the frontend's idle timer when autoMaintenanceEnabled is on.
        maintenance::run_git_maintenance,
        // Streaming twins of fetch/pull: same behaviour, but force git
        // --progress and emit "sync-progress" events so the topbar/menu
        // Fetch/Pull can show a live progress modal (see doFetch/doPull).
        git_remote::fetch_stream,
        git_remote::pull_stream,
        git_remote::current_upstream,
        // Hard-reset a local branch to match its configured upstream,
        // discarding local commits/changes on it — the sidebar branch-row
        // menu's "Reset to origin/…" action, gated behind the same
        // armDanger typed-confirm as Delete branch (see sidebar.svelte.ts's
        // resetToUpstream).
        git_remote::reset_branch_to_upstream,
        git_remote::push,
        // The one sanctioned "push never forces" exception — see
        // git_remote.rs's module doc + force_push's own doc comment. The two
        // Tools-menu/⌘K entries "Force Push (Safe)" / "Force Push (Override
        // Remote)" call this with lease:true/false respectively; the topbar
        // Push button/doPush() never does.
        git_remote::force_push,
        // Push a specific local branch without checking it out first,
        // optionally under a different name on the remote — the sidebar
        // branch-row menu's "Push…" action; the topbar Push button/doPush()
        // always targets the checked-out branch via plain `push` above.
        git_remote::push_branch,
        // Remote CONFIG CRUD (add/rename/set-url/remove/list) — a distinct,
        // local-only concern from the network sync above; see
        // git_remote_manage.rs's own doc comment for why it's a separate module.
        git_remote_manage::list_remotes,
        git_remote_manage::add_remote,
        git_remote_manage::rename_remote,
        git_remote_manage::set_remote_url,
        git_remote_manage::remove_remote,
        // Conflict resolver (M2b): inspect stages + per-file ours/theirs
        conflict::conflict_status,
        conflict::resolve_conflict_file,
        // Conflict resolver: in-app hunk-level editor (whole-file ours/theirs
        // above is unchanged; these are a third, additive resolution path)
        conflict::conflict_file_hunks,
        conflict::resolve_conflict_hunks,
        // Cherry-pick (M2b): drag-onto-HEAD + continue / abort
        git_pick::merge_parents,
        git_pick::cherry_pick,
        git_pick::cherry_pick_continue,
        git_pick::cherry_pick_abort,
        // Merge (M6 stage 1): drag-onto-HEAD + continue / abort
        git_merge::merge_start,
        git_merge::merge_continue,
        git_merge::merge_abort,
        // Squash-merge (backlog #7): stage a branch/commit's diff into the
        // index without committing, plus its own conflict abort/continue (no
        // MERGE_HEAD — see git_merge.rs's module doc / conflict.rs's detect_op)
        git_merge::merge_squash,
        git_merge::merge_squash_abort,
        git_merge::merge_squash_continue,
        // Multi-branch merge: octopus (one commit, any conflict aborts
        // outright) or sequential (a queue of ordinary pairwise merges)
        git_merge::merge_start_multi,
        git_merge::merge_queue_continue,
        git_merge::merge_queue_abort,
        git_merge::merge_queue_status,
        // Rebase (M6 stage 2): linear rebase onto a target + continue / skip / abort
        git_rebase::rebase_start,
        git_rebase::rebase_continue,
        git_rebase::rebase_skip,
        git_rebase::rebase_abort,
        // Interactive rebase: plan (reorder/pick/squash/fixup/drop/edit) + run
        git_rebase::rebase_interactive_plan,
        git_rebase::rebase_interactive_start,
        // Revert (M6 stage 3): revert a single commit onto HEAD + continue / abort
        git_revert::revert_start,
        git_revert::revert_continue,
        git_revert::revert_abort,
        // Patch export/apply (backlog #9): format-patch --stdout export (one
        // commit or a whole revision range, one combined mbox file) + git am
        // --3way apply, with am's own continue/skip/abort (see conflict.rs's
        // op_name "am" label — NEVER git_rebase.rs's rebase_continue/
        // rebase_abort, which are empirically confirmed to fail against an
        // am-created conflict; see patch.rs's module doc).
        patch::export_patch,
        patch::apply_patch,
        patch::am_continue,
        patch::am_skip,
        patch::am_abort,
        // Bisect (M3): start / mark good|bad|skip / status / reset
        git_bisect::bisect_start,
        git_bisect::bisect_mark,
        git_bisect::bisect_status,
        git_bisect::bisect_reset,
        // Bisect automated mode: `git bisect run <command>` equivalent
        git_bisect::bisect_run_start,
        git_bisect::bisect_run_cancel,
        // Reflog rescue (M4): read HEAD reflog + restore to a historical entry
        reflog::reflog,
        reflog::reflog_restore,
        // Dangling-object recovery (backlog #13): commits `git fsck
        // --dangling --no-reflogs` finds with no ref/reflog pointing at them
        // anymore. No new mutation command — recovery reuses
        // git_write::create_branch as-is (see fsck.rs's own module doc for
        // why that's genuinely sufficient).
        fsck::dangling_commits,
        // Rerere panel (M5a): status (config + rr-cache + live conflict paths) / toggle
        rerere::rerere_status,
        rerere::rerere_set_enabled,
        // Plumbing playground (M5b): inspect any rev's raw object (read-only)
        plumbing::plumbing_inspect,
        // Blame: read-only line-annotation view of a file at a commit (or HEAD)
        blame::blame_file,
        // File history: read-only per-file commit list, following renames (git log --follow)
        file_history::file_history,
        // Pickaxe / diff-content search (backlog #10): every commit whose diff
        // touched a given string/pattern across (a subset of) history — git log
        // -S/-G, never just commit messages. No rename-tracking (unlike
        // file_history above); see pickaxe.rs's own module doc.
        pickaxe::pickaxe_search,
        // Search Code: full-text search of the current checkout (or a chosen
        // historical commit's tree) via `git grep` — complements Pickaxe
        // above, which searches diffs and returns commits; this searches
        // file CONTENT and returns file+line+text. See code_search.rs's own
        // module doc.
        code_search::code_search,
        // Filter-repo wizard (M5c): backup+preview / run / restore / list backups
        filter_repo::filter_repo_preview,
        filter_repo::filter_repo_run,
        filter_repo::filter_repo_restore,
        filter_repo::filter_repo_list_backups,
        // Setup wizard: repo-local git identity check + fix (never touches global config)
        identity::get_git_identity,
        identity::set_git_identity,
        git_config::get_git_config_values,
        git_config::list_git_config_entries,
        git_config::set_git_config_value,
        // Live refresh: watch/unwatch the open repo's git-dir for external changes
        watch::watch_repo,
        watch::unwatch_repo,
        // Submodules (M1 of 4): read-only status view
        submodule::submodule_status,
        // Superproject detection: the ancestor chain above a repo, so opening a
        // submodule directly still shows its parent + siblings (submodule-nav strip)
        submodule::submodule_superproject_chain,
        // Submodules (M2 of 4): init (register URL, no clone) / update (clone
        // + checkout, optionally --init/--recursive, never --force)
        submodule::submodule_init,
        submodule::submodule_update,
        // Submodules (M3 of 4): add (clone a brand-new submodule) / sync
        // (re-copy .gitmodules's url into .git/config)
        submodule::submodule_add,
        submodule::submodule_sync,
        // Submodules (M4 of 4): deinit (clear + unregister, .git/modules
        // survives) / remove (deinit + git rm, stages .gitmodules cleanup too)
        submodule::submodule_deinit,
        submodule::submodule_remove,
        // Multi-repository dashboard (backlog #11): app-level tracked-repos
        // registry (JSON under app_config_dir()) + a minimal per-repo status
        // read (current branch's own ahead/behind, dirty flag, last commit —
        // never a commit-graph walk; see dashboard.rs's module doc).
        repo_registry::list_tracked_repos,
        repo_registry::add_tracked_repo,
        repo_registry::remove_tracked_repo,
        repo_registry::track_repo_opened,
        dashboard::dashboard_repo_status,
        // Repository Summary: a git-log-derived diagnostic (churn hotspots,
        // contributor ranking/bus factor, monthly activity, problem areas)
        // shown once automatically on a repo's first-ever open in GitCat
        // (claim_repo_summary_first_open lives in repo_registry.rs, the
        // module that already owns the "has this repo been opened before"
        // state) and reachable afterward via Tools/⌘K.
        repo_registry::claim_repo_summary_first_open,
        repo_summary::repo_summary,
        // Cheap first-open size probe: skips the (expensive) auto-summary on a
        // too-busy repo so opening it stays snappy — the full summary is still
        // reachable on demand. See repo_summary.rs's AUTO_SUMMARY_MAX_COMMITS.
        repo_summary::repo_summary_auto_recommended,
        // Branch visibility filter: which local/remote branches the commit
        // graph's revwalk is seeded from, persisted per repo (see
        // repo_registry.rs's own VisibleBranches doc comment). Read
        // transparently by commands::load_graph on every load — these two
        // commands are only for the sidebar's own checkboxes to read/write
        // the current selection.
        repo_registry::get_visible_branches,
        repo_registry::set_visible_branches,
        // Pluggable external diff/merge tools (backlog #12): app-level tool
        // settings (JSON under app_config_dir(), same shape as
        // repo_registry.rs) + delegate entirely to `git difftool`/
        // `git mergetool` — see tool_settings.rs's own module doc for why no
        // blob-extraction/temp-file code is needed at all.
        tool_settings::get_tool_settings,
        tool_settings::set_tool_settings,
        tool_settings::generate_commit_message,
        tool_settings::suggest_commit_msg_command,
        tool_settings::open_diff_tool,
        tool_settings::resolve_conflict_with_external_tool,
        // PER-44: multiple named diff/merge/commit tools (list + active selection)
        tool_settings::save_named_tool,
        tool_settings::remove_named_tool,
        tool_settings::set_active_tool,
        // PER-39/40: plugin system foundation — local registry CRUD + the
        // hardened external-process command executor (placeholder grammar).
        plugin_registry::list_plugins,
        plugin_registry::set_plugin_enabled,
        plugin_registry::install_plugin_from_path,
        plugin_registry::remove_plugin,
        plugin_registry::load_plugin_skin, // PER-47: load a plugin's Tama skin (pose assets → data URIs)
        plugin_exec::run_plugin_command,
        plugin_exec::run_hooks, // PER-43: run enabled plugins' hooks for a lifecycle event
        // Repo-root file editors (backlog #14, final item): view/edit .gitignore
        // and .mailmap directly — allow-listed to exactly these two names, see
        // repo_files.rs's own module doc.
        repo_files::read_repo_file,
        repo_files::write_repo_file,
        // "Open Terminal": a real PTY-backed shell embedded in GitCat's own
        // UI (a bottom drawer) — see terminal.rs's own module doc.
        terminal::terminal_spawn,
        terminal::terminal_write,
        terminal::terminal_resize,
        terminal::terminal_kill,
        // Multi-window: the Dashboard's "Open in New Window" row action (the
        // generic "New Window" menu item is handled entirely in Rust, see
        // menu.rs's own handle_event — no command round trip for that path).
        windows::open_repo_in_new_window,
        // "Install 'gitcat' command in PATH" (macOS): writes a `code`-style
        // launcher to /usr/local/bin so `gitcat <folder>` works from a terminal.
        cli_shim::install_cli_shim,
    ])
    // `GraphBatch` is never a command's own parameter/return type — it's ONLY
    // ever emitted over the raw `"graph-batch"` event (see commands::stream_graph
    // / src/legacy/main.ts's own listener), so specta doesn't reach it from any
    // command signature. This explicit `.typ()` is what exports it to bindings.ts.
    // (It briefly rode `load_graph`'s `Channel<GraphBatch>` param; reverted
    // because ipc::Channel didn't deliver in a second app instance.)
    .typ::<model::GraphBatch>()
    // Same raw-emit convention as GraphBatch above: `SyncProgress` is only ever
    // emitted over the "sync-progress" event (fetch_stream/pull_stream), never a
    // command parameter, so it needs an explicit `.typ()` to reach bindings.ts.
    .typ::<git_remote::SyncProgress>()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = specta_builder();

    // In dev, regenerate the TS bindings on every launch so a changed command
    // signature immediately reflects in the frontend types.
    #[cfg(debug_assertions)]
    builder
        .export(specta_typescript::Typescript::default()
            .bigint(specta_typescript::BigIntExportBehavior::Number)
            .header("// @ts-nocheck\n"), "../src/ipc/bindings.ts")
        .expect("failed to export typescript bindings");

    // `app_builder` is reassigned to add a plugin in the debug_assertions block
    // below (a dev inspector) AND in the release `not(debug_assertions)` block
    // (the crash-log plugin), so `mut` is used in every build; the #[allow] is
    // a harmless belt-and-braces. #[allow] rather than restructuring: the
    // alternative (two full separate builder chains) would duplicate every
    // `.plugin()`/`.manage()` call below across both branches for one line.
    #[allow(unused_mut)]
    let mut app_builder = tauri::Builder::default();

    // Record Rust panics to the log. Before this, a panic in a RELEASE build
    // aborted with no trace at all (release kept no logs — see the release
    // logging block further below), so a crash left nothing to diagnose. This
    // won't catch an OS-level kill (a jetsam/out-of-memory termination happens
    // externally, with no chance to run) — but it turns a silent Rust-side
    // panic into a logged one. Chains to the previous hook so the default
    // backtrace/abort still happens; log::error! is picked up by
    // tauri-plugin-log once installed (a panic before that only hits the
    // default hook, which is rare — pre-window startup).
    {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let loc = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_else(|| "unknown".into());
            let msg = info
                .payload()
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
                .unwrap_or("<non-string panic payload>");
            log::error!("PANIC at {loc}: {msg}");
            prev(info);
        }));
    }
    // Dev-only profiling/inspection, never shipped in a release build. Pick
    // EXACTLY ONE of the two, never both: both tauri-plugin-devtools and
    // console-subscriber (tokio-console) try to install the process-global
    // tracing dispatcher, and only one can ever win — confirmed via a real
    // crash ("a global default trace dispatcher has already been set") when
    // both ran; tauri-plugin-devtools's own init()/try_init() doc comment
    // says outright it "will panic ... if another library has already
    // initialized a global tracing subscriber". Both also open an
    // unauthenticated local diagnostic port and add real per-task tracing
    // overhead, hence #[cfg(debug_assertions)] gating either from ever
    // running in a release build at all.
    //
    //   - default (neither env var set): NEITHER runs — an ordinary `pnpm
    //     tauri dev` stays a plain, lightweight dev build with no extra
    //     console spam, diagnostic port, or tracing overhead. Both tools are
    //     genuinely opt-in, not "on unless you know to turn them off".
    //   - GITCAT_DEVTOOLS=1: tauri-plugin-devtools (CrabNebula) — a GUI
    //     inspector, viewed via the separate CrabNebula DevTools desktop app.
    //   - GITCAT_TOKIO_CONSOLE=1: console-subscriber (tokio-console) — a raw
    //     async-task inspector for everything routed through
    //     tauri::async_runtime (confirmed backed by a real
    //     tokio::runtime::Runtime, so this sees genuine task data, including
    //     every run_blocking/spawn_blocking call), viewed via the separate
    //     `tokio-console` CLI (`cargo install tokio-console`), connecting to
    //     the default 127.0.0.1:6669 gRPC endpoint. Requires building with
    //     `RUSTFLAGS="--cfg tokio_unstable"` (see .cargo/config.toml) or this
    //     subscriber sees no task events at all.
    //   - both set: GITCAT_TOKIO_CONSOLE wins — they can't run together at
    //     all (both try to install the process-global tracing dispatcher;
    //     confirmed via a real startup panic when both ran), so one has to
    //     take priority rather than leaving that case undefined.
    #[cfg(debug_assertions)]
    {
        if std::env::var_os("GITCAT_TOKIO_CONSOLE").is_some() {
            console_subscriber::init();
        } else if std::env::var_os("GITCAT_DEVTOOLS").is_some() {
            app_builder = app_builder.plugin(tauri_plugin_devtools::init());
        } else {
            // Default `pnpm tauri dev`: log the app's key lifecycle events
            // (graph loads, reload fast/full decisions, watcher triggers — see
            // src/devlog.ts's dlog + the `log::` calls in watch.rs) to the dev
            // terminal (Stdout) AND the app's log dir. Registered ONLY here, in
            // the else branch, because tauri-plugin-log installs the process-
            // global `log` logger and the two inspectors above install a global
            // tracing dispatcher (which also captures `log`) — only one can win,
            // same "pick exactly one" constraint documented above. Never shipped:
            // the whole block is `#[cfg(debug_assertions)]`.
            app_builder = app_builder.plugin(
                tauri_plugin_log::Builder::new()
                    .level(log::LevelFilter::Info)
                    .targets([
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                            file_name: Some("gitcat".into()),
                        }),
                    ])
                    .build(),
            );
        }
    }

    // Release crash black box. None of the dev inspectors above exist in a
    // release build (they're all debug/env-gated), so there's nothing here to
    // fight tauri-plugin-log's process-global logger — install it so a shipped
    // build finally keeps a log. LogDir only (a bundled app has no terminal),
    // size-capped via the default KeepOne rotation so a long-running session
    // can't grow it without bound (~2 MB, most-recent only), at Info for the
    // app's own lifecycle events. The webview stack logs at INFO extremely
    // chattily — `wry` (one line per ipc:// custom-protocol request), the
    // `tracing` spans it emits, and `tauri`'s own per-emit line — which drowns
    // the real signal and would churn the 2 MB cap in seconds, so each of those
    // targets is held to Warn. Writes to ~/Library/Logs/com.jiucheng.gitcat/.
    #[cfg(all(not(debug_assertions), not(feature = "nightly")))]
    {
        app_builder = app_builder.plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("tauri", log::LevelFilter::Warn)
                .level_for("wry", log::LevelFilter::Warn)
                .level_for("tracing", log::LevelFilter::Warn)
                .level_for("tao", log::LevelFilter::Warn)
                .level_for("hyper", log::LevelFilter::Warn)
                .level_for("reqwest", log::LevelFilter::Warn)
                .max_file_size(2_000_000)
                .targets([tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                    file_name: Some("gitcat".into()),
                })])
                .build(),
        );
    }

    // NIGHTLY build (`--features nightly`, the daily channel): maximum-verbosity
    // logging for diagnosing hard bugs. Everything at Trace, including the webview
    // stack (wry / tracing / tao / tauri are NOT muted here, unlike the stable
    // block above) — EXCEPT hyper/reqwest, held to Debug because at Trace they
    // dump raw TLS/HTTP bytes (megabytes per network call: noise, not signal). A
    // 10 MB cap with a few rotated files kept (KeepSome) so several past sessions
    // stay diagnosable. Writes to a SEPARATE `gitcat-nightly.log` (not the stable
    // build's `gitcat.log`) so the two channels' logs never interleave — a user
    // can have both installed / switch between them, and a nightly's Trace spam
    // must not drown the stable log (nor vice versa). Same
    // ~/Library/Logs/com.jiucheng.gitcat/ directory.
    #[cfg(all(not(debug_assertions), feature = "nightly"))]
    {
        app_builder = app_builder.plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Trace)
                .level_for("hyper", log::LevelFilter::Debug)
                .level_for("reqwest", log::LevelFilter::Debug)
                .max_file_size(10_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                .targets([tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                    file_name: Some("gitcat-nightly".into()),
                })])
                .build(),
        );
    }

    app_builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Updater: checks the GitHub Release matching this build's `latest.json`
        // (see tauri.conf.json's `plugins.updater` config) and, on newer version
        // found, downloads + verifies (against `pubkey` there) + installs it.
        // Every release build's artifacts are minisign-signed by CI (see
        // .github/workflows/release.yml) — an update whose signature doesn't
        // verify against `pubkey` is refused, never installed. `process`
        // supplies `relaunch()`, used to restart into the just-installed build
        // once install finishes (see src/islands/updater's controller).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(watch::WatchState::default())
        .manage(git_bisect::BisectRunState::default())
        .manage(terminal::TerminalRegistry::default())
        .manage(commands::GraphLoadState::default())
        // invoke_handler is the tauri-specta equivalent of generate_handler! —
        // command runtime behavior (Ok resolves / Err rejects) is unchanged.
        .invoke_handler(builder.invoke_handler())
        .menu(|app| menu::build(app))
        .on_menu_event(menu::handle_event)
        .setup(move |app| {
            builder.mount_events(app);
            // Multi-window (see windows.rs's own module doc): this process's
            // one and only window is created HERE, not via a
            // tauri.conf.json-declared window — `app.windows` is
            // deliberately empty in that config, since the window's own URL
            // needs to vary per-process (this process's own `?repo=`
            // argument) in a way static JSON config can't express.
            windows::create_initial_window(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // `ExitRequested` (not `Exit`): fires once, before the process
            // actually goes away, guaranteeing every open built-in-terminal
            // shell (see terminal.rs's own module doc) gets killed rather
            // than orphaned as a background process once GitCat quits.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                app_handle.state::<terminal::TerminalRegistry>().kill_all();
            }
        });
}

/// `cargo test export_bindings` regenerates `src/ipc/bindings.ts` from the Rust
/// command signatures WITHOUT launching the app (headless / CI friendly). The
/// generated file is committed; this test keeps it honest.
#[cfg(test)]
mod bindings_export {
    #[test]
    fn export_bindings() {
        super::specta_builder()
            .export(
                specta_typescript::Typescript::default()
            .bigint(specta_typescript::BigIntExportBehavior::Number)
            .header("// @ts-nocheck\n"),
                "../src/ipc/bindings.ts",
            )
            .expect("failed to export typescript bindings");
    }
}
