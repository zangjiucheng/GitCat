//! Dev harness: `cargo run --release --example graphcheck -- <repo> [limit]`
//! Prints the GraphData JSON to stdout and timing/shape stats to stderr, so the
//! read -> layout pipeline can be validated (and benchmarked) without the GUI.
//!
//! `graphcheck <repo> stream [batch_size]` exercises the STREAMING path
//! (`commands::stream_graph_core`, what `load_graph` actually runs now)
//! instead — the real thing to benchmark for "does a huge repo actually
//! paint its first rows fast", since that's a property `build_graph`'s own
//! one-shot timing can't show at all (it only ever reports the total).

use gitcat_lib::commands::{build_graph, commit_detail, stream_graph_core};

fn main() {
    let path = std::env::args().nth(1).expect("usage: graphcheck <repo> [limit | detail <sha> | stream [batch_size]]");

    // `graphcheck <repo> detail <sha>` -> dump the commit_detail JSON for one commit.
    if std::env::args().nth(2).as_deref() == Some("detail") {
        let sha = std::env::args().nth(3).expect("usage: graphcheck <repo> detail <sha>");
        let d = tauri::async_runtime::block_on(commit_detail(path.clone(), sha)).expect("commit_detail failed");
        eprintln!("files: {}  +{}/-{}  truncated={}", d.files_changed, d.additions, d.deletions, d.truncated);
        println!("{}", serde_json::to_string(&d).expect("serialize"));
        return;
    }

    if std::env::args().nth(2).as_deref() == Some("stream") {
        let batch_size: usize = std::env::args().nth(3).and_then(|s| s.parse().ok()).unwrap_or(1000);
        let t0 = std::time::Instant::now();
        let mut first_batch_ms = None;
        let mut batches = 0usize;
        let mut total_rows = 0usize;
        let mut final_lane_count = 0usize;
        let mut final_error = None;
        let mut final_truncated = false;
        stream_graph_core(&path, None, None, 1, batch_size, usize::MAX, || false, |b| {
            if first_batch_ms.is_none() {
                first_batch_ms = Some(t0.elapsed().as_secs_f64() * 1000.0);
            }
            batches += 1;
            total_rows += b.rows.len();
            final_lane_count = b.lane_count;
            if b.error.is_some() {
                final_error = b.error.clone();
            }
            final_truncated = b.truncated;
        });
        let total_ms = t0.elapsed().as_secs_f64() * 1000.0;
        eprintln!("batch_size:       {batch_size}");
        eprintln!("batches emitted:  {batches}");
        eprintln!("total commits:    {total_rows}");
        eprintln!("max lane width:   {final_lane_count}");
        eprintln!("time to FIRST batch: {:.1} ms  <-- this is what the user actually waits to see something", first_batch_ms.unwrap_or(f64::NAN));
        eprintln!("time to LAST batch:  {total_ms:.1} ms  (total walk+layout time)");
        if let Some(e) = final_error {
            eprintln!("walk error: {e}");
        }
        if final_truncated {
            eprintln!("truncated: hit max_commits (usize::MAX here, so this shouldn't happen)");
        }
        return;
    }

    let limit = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(50_000);

    let g = build_graph(&path, limit, None, None).expect("build_graph failed");

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
