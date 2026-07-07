//! Dev harness for M2a write-safety. Runs against a THROWAWAY repo only.
//! `cargo run --example m2check -- <repo> [undo|refs]`

use gitcat_lib::git_write::{checkout, create_branch, delete_branch, list_refs, rename_branch};
use gitcat_lib::safety::{create_snapshot, list_snapshots, undo_last};

fn j<T: serde::Serialize>(t: &T) -> String {
    serde_json::to_string(t).unwrap()
}

fn main() {
    let p = std::env::args().nth(1).expect("usage: m2check <repo> [undo|refs]");
    match std::env::args().nth(2).as_deref() {
        Some("undo") => {
            println!("undo_last -> {}", j(&undo_last(p.clone()).unwrap()));
            return;
        }
        Some("refs") => {
            println!("list_refs -> {}", j(&list_refs(p.clone()).unwrap()));
            return;
        }
        _ => {}
    }

    println!("1) list_refs        {}", j(&list_refs(p.clone()).unwrap()));
    println!("2) create_snapshot  {}", j(&create_snapshot(p.clone()).unwrap()));
    println!("3) list_snapshots   {}", j(&list_snapshots(p.clone()).unwrap()));
    println!("4) checkout feature {}", j(&checkout(p.clone(), "feature".into())));
    println!("5) refs (on feature){}", j(&list_refs(p.clone()).unwrap()));
    println!("6) undo_last        {}", j(&undo_last(p.clone()).unwrap()));
    println!("7) refs (RESTORED?) {}", j(&list_refs(p.clone()).unwrap()));
    println!("8) create_branch exp{}", j(&create_branch(p.clone(), "exp".into(), None, None)));
    println!("9) delete CURRENT   {}", j(&delete_branch(p.clone(), "main".into(), false)));
    println!("10) rename exp->exp2 {}", j(&rename_branch(p.clone(), "exp".into(), "exp2".into())));
    println!("11) delete exp2      {}", j(&delete_branch(p.clone(), "exp2".into(), false)));
    println!("12) snapshots (grew) {}", j(&list_snapshots(p.clone()).unwrap()));
}
