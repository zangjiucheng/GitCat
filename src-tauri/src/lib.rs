pub mod blame; // read-only line-annotation (git blame) view
pub mod commands;
pub mod conflict;
pub mod file_history; // read-only per-file commit history, following renames (git log --follow)
pub mod filter_repo; // M5c: filter-repo wizard (backup / preview / run / restore)
pub mod git_pick;
pub mod git_read;
pub mod git_remote; // fetch / pull (ff-only) / push / force_push / push_tag
pub mod git_remote_manage; // Remote CONFIG CRUD: add/rename/set-url/remove/list (fetch/pull/push/push_tag stay in git_remote.rs — see both modules' own doc comments for why they're split)
pub mod git_tag; // Tags: create / delete (push_tag lives in git_remote.rs — see its doc comment)
pub mod git_write;
pub mod workdir; // working-tree status + stage/unstage/discard/commit + stash
pub mod git_bisect; // M3: git bisect (start / mark good|bad|skip / status / reset)
pub mod git_merge; // M6 (stage 1): merge (drag-onto-HEAD) + continue / abort
pub mod git_rebase; // M6 (stage 2): linear rebase onto a target + continue / skip / abort
pub mod git_revert; // M6 (stage 3): revert a single commit onto HEAD + continue / abort
pub mod identity; // Setup wizard: repo-local git identity (user.name/user.email) check + fix
pub mod layout;
pub mod menu; // native app menu (File/Edit/View/Window/Help)
pub mod model;
pub mod patch; // format-patch export + git am --3way apply (with am's own continue/skip/abort)
pub mod pickaxe; // pickaxe / diff-content search: git log -S/-G across (a subset of) history
pub mod plumbing; // M5b: read-only object-database inspector (commit/tree/blob/tag by rev)
pub mod reflog; // M4: reflog rescue (read HEAD reflog + restore to a historical entry)
pub mod rerere; // M5a: git-rerere status/toggle panel
pub mod safety; // provided by the Safety-Manager component (exposes snapshot(&Repository))
pub mod submodule; // M1 status (read-only) + M2 init/update + M3 add/sync + M4 deinit/remove + M5 foreach
pub mod trust; // auto-trust WSL/UNC-path repos libgit2 refuses as "dubious ownership"
pub mod watch; // live refresh: watch the open repo's git-dir for externally-made changes

use tauri_specta::{collect_commands, Builder};

/// The tauri-specta builder — the SINGLE source of truth for the command set,
/// shared by the running app (`run`) and the bindings-export test below, so the
/// generated `src/ipc/bindings.ts` can never drift from the Rust commands.
fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![
        commands::load_graph,
        commands::commit_detail,
        commands::get_app_info,
        // Safety Manager (snapshot / list / global undo)
        safety::create_snapshot,
        safety::list_snapshots,
        safety::undo_last,
        // Branch ops
        git_write::list_refs,
        git_write::create_branch,
        git_write::checkout,
        git_write::checkout_discard,
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
        git_remote::current_upstream,
        git_remote::push,
        // The one sanctioned "push never forces" exception — see
        // git_remote.rs's module doc + force_push's own doc comment. The two
        // Tools-menu/⌘K entries "Force Push (Safe)" / "Force Push (Override
        // Remote)" call this with lease:true/false respectively; the topbar
        // Push button/doPush() never does.
        git_remote::force_push,
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
        // Cherry-pick (M2b): drag-onto-HEAD + continue / abort
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
        // Filter-repo wizard (M5c): backup+preview / run / restore / list backups
        filter_repo::filter_repo_preview,
        filter_repo::filter_repo_run,
        filter_repo::filter_repo_restore,
        filter_repo::filter_repo_list_backups,
        // Setup wizard: repo-local git identity check + fix (never touches global config)
        identity::get_git_identity,
        identity::set_git_identity,
        // Live refresh: watch/unwatch the open repo's git-dir for external changes
        watch::watch_repo,
        watch::unwatch_repo,
        // Submodules (M1 of 4): read-only status view
        submodule::submodule_status,
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
        // Submodules (M5, final): foreach — run a shell command in every
        // initialized submodule's own working directory, with live progress
        // and cancellation
        submodule::submodule_foreach_start,
        submodule::submodule_foreach_cancel,
    ])
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

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(watch::WatchState::default())
        .manage(git_bisect::BisectRunState::default())
        .manage(submodule::SubmoduleForeachState::default())
        // invoke_handler is the tauri-specta equivalent of generate_handler! —
        // command runtime behavior (Ok resolves / Err rejects) is unchanged.
        .invoke_handler(builder.invoke_handler())
        .menu(|app| menu::build(app))
        .on_menu_event(menu::handle_event)
        .setup(move |app| {
            builder.mount_events(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
