//! M2b write-safety harness (THROWAWAY repos only).
//! `cargo run --example pickcheck -- <repo> <sha> [abort|status]`

use gitcat_lib::conflict::{conflict_status, resolve_conflict_file};
use gitcat_lib::git_pick::{cherry_pick, cherry_pick_abort, cherry_pick_continue};

fn j<T: serde::Serialize>(t: &T) -> String {
    serde_json::to_string(t).unwrap()
}

fn main() {
    let p = std::env::args().nth(1).expect("usage: pickcheck <repo> <sha> [abort|status]");
    let sha = std::env::args().nth(2).unwrap_or_default();
    match std::env::args().nth(3).as_deref() {
        Some("status") => {
            println!("conflict_status -> {}", j(&tauri::async_runtime::block_on(conflict_status(p)).unwrap()));
            return;
        }
        Some("abort") => {
            println!("cherry_pick     -> {}", j(&tauri::async_runtime::block_on(cherry_pick(p.clone(), sha, Some(true)))));
            println!("abort           -> {}", j(&tauri::async_runtime::block_on(cherry_pick_abort(p))));
            return;
        }
        _ => {}
    }
    // full conflict -> resolve(theirs) -> continue flow
    println!("cherry_pick     -> {}", j(&tauri::async_runtime::block_on(cherry_pick(p.clone(), sha, Some(true)))));
    let st = tauri::async_runtime::block_on(conflict_status(p.clone())).unwrap();
    println!("conflict_status -> {}", j(&st));
    if let Some(f) = st.files.first() {
        println!(
            "resolve theirs  -> {}",
            j(&tauri::async_runtime::block_on(resolve_conflict_file(p.clone(), f.path.clone(), "theirs".into())))
        );
    }
    println!("continue        -> {}", j(&tauri::async_runtime::block_on(cherry_pick_continue(p))));
}
