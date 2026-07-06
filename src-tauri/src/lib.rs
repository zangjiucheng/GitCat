pub mod commands;
pub mod git_read;
pub mod layout;
pub mod model;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::load_graph,
            commands::commit_detail
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
