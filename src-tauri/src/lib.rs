pub mod commands;
pub mod conflict;
pub mod filter_repo; // M5c: filter-repo wizard (backup / preview / run / restore)
pub mod git_pick;
pub mod git_read;
pub mod git_write;
pub mod git_bisect; // M3: git bisect (start / mark good|bad|skip / status / reset)
pub mod git_merge; // M6 (stage 1): merge (drag-onto-HEAD) + continue / abort
pub mod git_rebase; // M6 (stage 2): linear rebase onto a target + continue / skip / abort
pub mod layout;
pub mod model;
pub mod plumbing; // M5b: read-only object-database inspector (commit/tree/blob/tag by rev)
pub mod reflog; // M4: reflog rescue (read HEAD reflog + restore to a historical entry)
pub mod rerere; // M5a: git-rerere status/toggle panel
pub mod safety; // provided by the Safety-Manager component (exposes snapshot(&Repository))

use tauri_specta::{collect_commands, Builder};

/// The tauri-specta builder — the SINGLE source of truth for the command set,
/// shared by the running app (`run`) and the bindings-export test below, so the
/// generated `src/ipc/bindings.ts` can never drift from the Rust commands.
fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![
        commands::load_graph,
        commands::commit_detail,
        // Safety Manager (snapshot / list / global undo)
        safety::create_snapshot,
        safety::list_snapshots,
        safety::undo_last,
        // Branch ops
        git_write::list_refs,
        git_write::create_branch,
        git_write::checkout,
        git_write::delete_branch,
        git_write::rename_branch,
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
        // Rebase (M6 stage 2): linear rebase onto a target + continue / skip / abort
        git_rebase::rebase_start,
        git_rebase::rebase_continue,
        git_rebase::rebase_skip,
        git_rebase::rebase_abort,
        // Bisect (M3): start / mark good|bad|skip / status / reset
        git_bisect::bisect_start,
        git_bisect::bisect_mark,
        git_bisect::bisect_status,
        git_bisect::bisect_reset,
        // Reflog rescue (M4): read HEAD reflog + restore to a historical entry
        reflog::reflog,
        reflog::reflog_restore,
        // Rerere panel (M5a): status (config + rr-cache + live conflict paths) / toggle
        rerere::rerere_status,
        rerere::rerere_set_enabled,
        // Plumbing playground (M5b): inspect any rev's raw object (read-only)
        plumbing::plumbing_inspect,
        // Filter-repo wizard (M5c): backup+preview / run / restore / list backups
        filter_repo::filter_repo_preview,
        filter_repo::filter_repo_run,
        filter_repo::filter_repo_restore,
        filter_repo::filter_repo_list_backups,
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
        // invoke_handler is the tauri-specta equivalent of generate_handler! —
        // command runtime behavior (Ok resolves / Err rejects) is unchanged.
        .invoke_handler(builder.invoke_handler())
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
