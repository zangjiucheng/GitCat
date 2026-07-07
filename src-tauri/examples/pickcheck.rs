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
            println!("conflict_status -> {}", j(&conflict_status(p).unwrap()));
            return;
        }
        Some("abort") => {
            println!("cherry_pick     -> {}", j(&cherry_pick(p.clone(), sha, Some(true))));
            println!("abort           -> {}", j(&cherry_pick_abort(p)));
            return;
        }
        _ => {}
    }
    // full conflict -> resolve(theirs) -> continue flow
    println!("cherry_pick     -> {}", j(&cherry_pick(p.clone(), sha, Some(true))));
    let st = conflict_status(p.clone()).unwrap();
    println!("conflict_status -> {}", j(&st));
    if let Some(f) = st.files.first() {
        println!(
            "resolve theirs  -> {}",
            j(&resolve_conflict_file(p.clone(), f.path.clone(), "theirs".into()))
        );
    }
    println!("continue        -> {}", j(&cherry_pick_continue(p)));
}
