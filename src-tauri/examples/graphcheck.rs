//! Dev harness: `cargo run --release --example graphcheck -- <repo> [limit]`
//! Prints the GraphData JSON to stdout and timing/shape stats to stderr, so the
//! read -> layout pipeline can be validated (and benchmarked) without the GUI.

use gitcat_lib::commands::build_graph;

fn main() {
    let path = std::env::args().nth(1).expect("usage: graphcheck <repo> [limit]");
    let limit = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(50_000);

    let g = build_graph(&path, limit).expect("build_graph failed");

    eprintln!("commits: {}", g.n);
    eprintln!("max lane width: {}", g.lane_count);
    eprintln!("edge segments: {}", g.gap_top.len());
    eprintln!("read:   {:.1} ms", g.read_ms);
    eprintln!("layout: {:.1} ms", g.layout_ms);
    eprintln!(
        "total read+layout: {:.1} ms  ({:.1}k commits)",
        g.read_ms + g.layout_ms,
        g.n as f64 / 1000.0
    );

    println!("{}", serde_json::to_string(&g).expect("serialize"));
}
