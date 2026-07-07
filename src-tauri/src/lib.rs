pub mod commands;
pub mod git_read;
pub mod git_write;
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
            git_write::rename_branch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
