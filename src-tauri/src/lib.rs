pub mod commands;
pub mod conflict;
pub mod git_pick;
pub mod git_read;
pub mod git_write;
pub mod git_bisect; // M3: git bisect (start / mark good|bad|skip / status / reset)
pub mod layout;
pub mod model;
pub mod safety; // provided by the Safety-Manager component (exposes snapshot(&Repository))

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::load_graph,
            commands::commit_detail,
            // Safety Manager (snapshot / list / global undo)
            safety::create_snapshot,
            safety::list_snapshots,
            safety::undo_last,
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
            // Bisect (M3): start / mark good|bad|skip / status / reset
            git_bisect::bisect_start,
            git_bisect::bisect_mark,
            git_bisect::bisect_status,
            git_bisect::bisect_reset
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
