//! Swimlane DAG layout: assign each commit a lane and emit the per-gap edge
//! segments the canvas renderer draws. Single forward pass over commits in
//! child-before-parent order; lanes are recycled via a free-slot scan.
//!
//! Output matches the prototype's CSR model: for each `gap r` (band between
//! row r and row r+1) a list of segments {top lane @row r, bottom lane @row r+1,
//! colour}. Straight when top == bottom, an S-curve otherwise (merge / converge).

use git2::Oid;

use crate::git_read::RawCommit;

pub const NCOL: u8 = 7;

struct Lane {
    target: Oid, // the parent commit this descending line is heading toward
    color: u8,
}

pub struct Layout {
    pub lane: Vec<i16>,
    pub color: Vec<u8>,
    pub merge: Vec<u8>,
    pub gap_start: Vec<i32>,
    pub gap_top: Vec<i16>,
    pub gap_bot: Vec<i16>,
    pub gap_color: Vec<u8>,
    pub lane_count: usize,
}

/// Find the lowest free lane index (reuse recycles branch lanes so the graph
/// stays compact); grow if none free. Initialises the new lane's `top_of`.
fn alloc(lanes: &mut Vec<Option<Lane>>, top_of: &mut Vec<i16>) -> usize {
    for l in 0..lanes.len() {
        if lanes[l].is_none() {
            top_of[l] = l as i16;
            return l;
        }
    }
    lanes.push(None);
    top_of.push((lanes.len() - 1) as i16);
    lanes.len() - 1
}

pub fn layout(commits: &[RawCommit]) -> Layout {
    let n = commits.len();
    let mut lanes: Vec<Option<Lane>> = Vec::new();
    let mut top_of: Vec<i16> = Vec::new(); // per active lane: its x at the top of the next gap
    let mut color_ctr: u32 = 0;

    let mut lane_out = vec![0i16; n];
    let mut color_out = vec![0u8; n];
    let mut merge_out = vec![0u8; n];
    let mut gaps: Vec<Vec<(i16, i16, u8)>> = vec![Vec::new(); n];
    let mut lane_count = 0usize;

    for r in 0..n {
        let c = &commits[r];

        // 1) which active lanes are heading toward this commit?
        let mut incoming: Vec<usize> = Vec::new();
        for l in 0..lanes.len() {
            if let Some(ln) = &lanes[l] {
                if ln.target == c.id {
                    incoming.push(l);
                }
            }
        }
        let cl: usize;
        let color_c: u8;
        if incoming.is_empty() {
            cl = alloc(&mut lanes, &mut top_of); // branch tip
            color_c = (color_ctr % NCOL as u32) as u8;
            color_ctr += 1;
        } else {
            cl = *incoming.iter().min().unwrap();
            color_c = lanes[cl].as_ref().unwrap().color;
        }

        // 2) emit gap r-1 (row r-1 -> row r), with the incoming lanes converging into cl.
        if r > 0 {
            let gap = &mut gaps[r - 1];
            for l in 0..lanes.len() {
                if let Some(ln) = &lanes[l] {
                    let bot = if incoming.contains(&l) { cl as i16 } else { l as i16 };
                    gap.push((top_of[l], bot, ln.color));
                }
            }
        }

        // 3) transition lanes for this commit's outgoing edges (state descending below row r).
        for &l in &incoming {
            if l != cl {
                lanes[l] = None; // converged into cl; recycle
            }
        }
        if c.parents.is_empty() {
            lanes[cl] = None; // root: lane tips out
        } else {
            lanes[cl] = Some(Lane { target: c.parents[0], color: color_c }); // first parent continues
        }
        // default: every still-active line goes straight down in the next gap
        for l in 0..lanes.len() {
            if lanes[l].is_some() {
                top_of[l] = l as i16;
            }
        }
        // extra parents (merge): each diverges into a fresh lane, originating from cl
        if c.parents.len() > 1 {
            for pk in c.parents.iter().skip(1) {
                let fl = alloc(&mut lanes, &mut top_of);
                let col = (color_ctr % NCOL as u32) as u8;
                color_ctr += 1;
                lanes[fl] = Some(Lane { target: *pk, color: col });
                top_of[fl] = cl as i16; // its first segment curves out from cl
            }
        }

        lane_out[r] = cl as i16;
        color_out[r] = color_c;
        merge_out[r] = if c.parents.len() > 1 { 1 } else { 0 };
        lane_count = lane_count.max(lanes.len());
    }

    // flatten gaps -> CSR
    let total: usize = gaps.iter().map(|g| g.len()).sum();
    let mut gap_start = vec![0i32; n + 1];
    let mut gap_top = Vec::with_capacity(total);
    let mut gap_bot = Vec::with_capacity(total);
    let mut gap_color = Vec::with_capacity(total);
    let mut idx = 0i32;
    for r in 0..n {
        gap_start[r] = idx;
        for &(t, b, c) in &gaps[r] {
            gap_top.push(t);
            gap_bot.push(b);
            gap_color.push(c);
            idx += 1;
        }
    }
    gap_start[n] = idx;

    Layout {
        lane: lane_out,
        color: color_out,
        merge: merge_out,
        gap_start,
        gap_top,
        gap_bot,
        gap_color,
        lane_count,
    }
}
