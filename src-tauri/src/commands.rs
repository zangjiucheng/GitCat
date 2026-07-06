//! Tauri commands exposed to the frontend.

use std::time::Instant;

use crate::git_read::read_repo;
use crate::layout::{layout, NCOL};
use crate::model::{CommitMeta, GraphData, Person};

/// Default cap so a giant repo can't hang the UI on first load (M0 target: 10k < 1s).
const DEFAULT_LIMIT: usize = 50_000;

/// Tauri command wrapper — see [`build_graph`].
#[tauri::command]
pub fn load_graph(path: String, limit: Option<usize>) -> Result<GraphData, String> {
    build_graph(&path, limit.unwrap_or(DEFAULT_LIMIT))
}

/// Open `path`, walk its commits, lay out the swimlane graph, and return the
/// full payload the canvas renders. `limit` caps how many commits are loaded.
pub fn build_graph(path: &str, limit: usize) -> Result<GraphData, String> {

    let t0 = Instant::now();
    let mut read = read_repo(path, limit).map_err(|e| e.message().to_string())?;
    let read_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let t1 = Instant::now();
    let lay = layout(&read.commits);
    let layout_ms = t1.elapsed().as_secs_f64() * 1000.0;

    // Build per-row metadata, moving ref chips out of the map as we go.
    let rows: Vec<CommitMeta> = read
        .commits
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let sha = c.id.to_string();
            CommitMeta {
                sha: sha[..7.min(sha.len())].to_string(),
                subject: c.subject.clone(),
                an: Person { n: c.author.0.clone(), e: c.author.1.clone(), t: c.author.2 },
                cm: Person { n: c.committer.0.clone(), e: c.committer.1.clone(), t: c.committer.2 },
                refs: read.refs.remove(&sha).unwrap_or_default(),
                merge: lay.merge[i] == 1,
            }
        })
        .collect();

    Ok(GraphData {
        n: read.commits.len(),
        lane: lay.lane,
        color: lay.color,
        merge: lay.merge,
        gap_start: lay.gap_start,
        gap_top: lay.gap_top,
        gap_bot: lay.gap_bot,
        gap_color: lay.gap_color,
        rows,
        ncol: NCOL,
        lane_count: lay.lane_count,
        layout_ms,
        read_ms,
    })
}
