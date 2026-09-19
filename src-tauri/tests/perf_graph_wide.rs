//! The swimlane allocator under WIDTH — the half of it `perf_graph.rs` cannot
//! reach.
//!
//! `perf_graph.rs` seeds 5000 strictly linear commits (its own doc at `:53-65`
//! confirms every one lands on `refs/heads/main` in sequence), so
//! `LayoutBuilder` only ever runs at lane count 1. At lane count 1 it does
//! almost nothing: allocate lane 0 once, then walk a single-element `lanes`
//! vector 5000 times. Its actual job — allocating lanes for concurrent
//! branches, recycling them when branches converge, and emitting one gap
//! segment per live lane per row — had no coverage at all.
//!
//! How much that hides, measured on this machine (debug build, the profile CI
//! runs `cargo test` under):
//!
//! | fixture | commits | lane_count | `layout()` |
//! | --- | --- | --- | --- |
//! | linear (what `perf_graph.rs` builds) | 5100 | 1 | **1.9 ms** |
//! | this file's fan | 5100 | 400 | **182 ms** |
//!
//! Same commit count, **94× the layout work**. A regression living in the
//! per-lane loops of `LayoutBuilder::push` is invisible to a fixture that
//! never has a second lane.
//!
//! **What is timed.** The perf test times `layout()` ALONE, against commits
//! read beforehand, outside the clock. Measured on this fixture, the split is
//! 182 ms of layout against 75 ms of revwalk — so timing the whole of
//! `stream_graph_core` would not have HIDDEN a layout regression (a 10× one
//! still shows as ~7× of the total). What it would have done is put 30% of
//! filesystem and object-DB work on a clock that has to survive a shared CI
//! runner, and that variance is what forces a ceiling loose enough to be
//! useless — `perf_graph.rs` needs 10-15 s for exactly that reason. Off the
//! clock, 3 s is affordable. The second reason is attribution: when this test
//! fails it is the allocator, not git2 or a slow disk. `layout()` is
//! documented as a thin behaviour-preserving loop over `LayoutBuilder::push`
//! (see `layout.rs`'s own module doc), so timing it times the allocator and
//! nothing else.
//!
//! **What carries the weight.** Wall clock is here, but it is the weakest
//! assertion in the file and is deliberately loose — a CI runner's speed is
//! not ours to predict. The assertions that actually hold the line are the
//! deterministic ones, which cost nothing and cannot flake:
//!
//! * `lane_count == BRANCH_COUNT` — proves the fixture is still wide. This is
//!   the guard against THIS file quietly decaying into `perf_graph.rs`'s
//!   problem: if a change to the seeder or to ref selection collapsed the fan,
//!   every timing assertion here would still pass, happily measuring lane 1.
//! * `lane_count` stays at 2 across 600 branch-and-merge cycles — proves lanes
//!   are RECYCLED. Six hundred branches come and go and the allocator never
//!   needs a third slot. If `alloc`'s free-slot scan stopped reusing `None`
//!   entries, this reads 601 instead of 2, on any machine, at any speed.
//! * A wide stretch still batches hundreds of rows at a time — see that test.
//!
//! **fast-import marks.** Both seeders use `mark`/`from`, which
//! `perf_graph.rs` deliberately does not, and its doc at `:53-65` records why
//! that mattered: mark ids start at **1**, because `:0` is an internal
//! null/unset sentinel and `from :0` fails with "fatal: mark :0 not declared".
//! The linear seeder sidestepped marks entirely; these topologies cannot —
//! a fan needs every branch to `from` the same trunk tip, and a merge needs
//! `merge :<tip>` — so the counters below start at 1.

mod common;

use std::collections::HashSet;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use common::TempRepo;
use gitcat_lib::commands::stream_graph_core;
use gitcat_lib::git_read::{read_repo, RawCommit};
use gitcat_lib::layout::{layout, Layout};
use gitcat_lib::model::GraphBatch;

/// Commits on the shared trunk every branch forks from. Small on purpose:
/// this fixture's cost is branch COUNT, not history length (see the module
/// doc) — the trunk only has to exist so the fan has something to converge
/// into and the walk ends at lane 1 rather than mid-fan.
const TRUNK_COMMITS: usize = 300;
/// Concurrent branches — this is the number that matters. Every one of them
/// is live at once during the walk, so this IS the lane count.
/// 400 is not arbitrary: it is wide enough that `MAX_GAP_SEGMENTS_PER_BATCH`
/// actually binds (see the batching test) and that layout dominates the walk,
/// while keeping the whole file's runtime around a second.
const BRANCH_COUNT: usize = 400;
const COMMITS_PER_BRANCH: usize = 12;
const WIDE_COMMITS: usize = TRUNK_COMMITS + BRANCH_COUNT * COMMITS_PER_BRANCH;

/// Branch-and-merge cycles in the recycling fixture. Sequential, never
/// overlapping — the whole point is that 600 branches existing over time need
/// only 2 lanes at any instant.
const MERGE_CYCLES: usize = 600;
const COMMITS_PER_TOPIC: usize = 3;
const MERGE_COMMITS: usize = 1 + MERGE_CYCLES * (COMMITS_PER_TOPIC + 1);

const WHO: &str = "GitCat Test <test@gitcat.example>";

/// One `commit` command in fast-import's stream format.
///
/// `data <exact-byte-count>\n<raw bytes>` rather than the newer `data <<DELIM`
/// heredoc form, for the same reason `perf_graph.rs` gives: an exact byte
/// count is unambiguous on every git version that has fast-import at all,
/// with no delimiter-quoting rules to depend on.
///
/// `from` is only needed for the FIRST commit on a ref — after that
/// fast-import uses that ref's own current tip as the implicit parent. `merge`
/// adds a second parent, which is what makes a merge commit a merge commit and
/// is the only way to get one into the stream.
#[allow(clippy::too_many_arguments)]
fn emit_commit(
    out: &mut Vec<u8>,
    refname: &str,
    mark: Option<u32>,
    ts: usize,
    msg: &str,
    file: &str,
    from: Option<u32>,
    merge: Option<u32>,
) {
    out.extend_from_slice(format!("commit {refname}\n").as_bytes());
    if let Some(m) = mark {
        out.extend_from_slice(format!("mark :{m}\n").as_bytes());
    }
    out.extend_from_slice(format!("author {WHO} {ts} +0000\ncommitter {WHO} {ts} +0000\n").as_bytes());
    let msg = format!("{msg}\n");
    out.extend_from_slice(format!("data {}\n", msg.len()).as_bytes());
    out.extend_from_slice(msg.as_bytes());
    if let Some(f) = from {
        out.extend_from_slice(format!("from :{f}\n").as_bytes());
    }
    if let Some(m) = merge {
        out.extend_from_slice(format!("merge :{m}\n").as_bytes());
    }
    let blob = format!("{ts}\n");
    out.extend_from_slice(format!("M 100644 inline {file}\n").as_bytes());
    out.extend_from_slice(format!("data {}\n", blob.len()).as_bytes());
    out.extend_from_slice(blob.as_bytes());
    out.push(b'\n');
}

/// Feed a prepared stream to `git fast-import` and check the working tree out.
///
/// The `write_all` error is ignored on purpose (same as `perf_graph.rs`): a
/// broken pipe here means the child already died reading a BAD stream, so
/// surfacing git's own stderr from `wait_with_output` is the useful
/// diagnostic, not a generic I/O error hiding it. The `reset --hard` is
/// needed because fast-import writes objects and refs only — it never touches
/// the working tree or index, so the checkout is still empty until this.
fn fast_import(repo: &TempRepo, stream: &[u8]) {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo.path())
        .arg("fast-import")
        .arg("--quiet")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn git fast-import");
    let _ = child.stdin.take().unwrap().write_all(stream);
    let output = child.wait_with_output().expect("failed to wait on git fast-import");
    assert!(output.status.success(), "git fast-import failed: {}", String::from_utf8_lossy(&output.stderr));
    repo.must(&["reset", "--hard"]);
}

/// A trunk, then [`BRANCH_COUNT`] branches fanning off its tip, all live at
/// once:
///
/// ```text
///      wide0   wide1   wide2  ...  wide399      (400 tips, never merged)
///        |       |       |            |
///        +-------+-------+---- ... ---+
///                        |
///                     trunk tip
///                        |
///                      trunk (300 commits)
/// ```
///
/// The timestamp interleave is about the WALK, not the stream. `walk_repo`
/// sorts `TOPOLOGICAL | TIME`: newest-first among whatever is available.
/// Branch `b`'s commit `m` gets timestamp `m * BRANCH_COUNT + b`, so every
/// branch's newest commit is adjacent in time to every other branch's newest
/// commit. The walk therefore takes one row from each of the 400 branches,
/// then the next row from each, and so on — all 400 lanes are open within the
/// first 400 rows and stay open for the whole 4800-row fan.
///
/// What that buys, and what it does not, both checked by de-interleaving the
/// timestamps and re-running rather than reasoned about: it does NOT move
/// `lane_count`, which is 400 either way. Every branch's lane targets the same
/// trunk tip and is only recycled when that tip is walked, which is last, so
/// the high-water is 400 however the branches are ordered. What it changes is
/// how much of the walk has all 400 live AT ONCE. Consecutive timestamps drain
/// one branch at a time, so the live count ramps 1 → 400 and averages ~200:
/// half the per-row work (104 ms against 185 ms here) and a batch-size ramp
/// instead of the flat 500 rows the batching test reads. The interleaved shape
/// is both the harsher measurement and the honest model of the repo
/// `commands.rs`'s `MAX_GAP_SEGMENTS_PER_BATCH` comment describes — hundreds
/// of lanes open simultaneously, not in sequence.
///
/// Stream order is separate and only has to be per-ref sequential, since each
/// `commit refs/heads/wideN` picks up that ref's own tip implicitly. Only the
/// trunk tip needs a mark (`:1`), because only the first commit of each branch
/// needs an explicit `from`.
fn seed_wide_fan(repo: &TempRepo) {
    let mut stream = Vec::<u8>::new();
    let base = 1_700_000_000usize;

    const TRUNK_TIP: u32 = 1;
    for i in 0..TRUNK_COMMITS {
        let mark = if i == TRUNK_COMMITS - 1 { Some(TRUNK_TIP) } else { None };
        emit_commit(&mut stream, "refs/heads/main", mark, base + i, &format!("trunk {i}"), &format!("t{}.txt", i % 20), None, None);
    }

    let fan_base = base + TRUNK_COMMITS;
    for m in 0..COMMITS_PER_BRANCH {
        for b in 0..BRANCH_COUNT {
            let from = if m == 0 { Some(TRUNK_TIP) } else { None };
            emit_commit(
                &mut stream,
                &format!("refs/heads/wide{b}"),
                None,
                fan_base + m * BRANCH_COUNT + b,
                &format!("wide{b} commit {m}"),
                &format!("b{b}.txt"),
                from,
                None,
            );
        }
    }

    fast_import(repo, &stream);
}

/// [`MERGE_CYCLES`] topic branches, each forked from main and merged straight
/// back before the next one starts:
///
/// ```text
///   main --+--> topic0 (3) --+--> merge --+--> topic1 (3) --+--> merge --> ...
/// ```
///
/// Sequential on purpose: 600 branches exist in the finished repo (all 600
/// refs are still there, unmerged-branch cleanup is not simulated) but no two
/// are ever live at the same instant, so a correct allocator needs exactly 2
/// lanes — main's, and whichever topic is currently open — no matter how large
/// `MERGE_CYCLES` gets. That invariant is what the recycling test asserts.
fn seed_branch_and_merge(repo: &TempRepo) {
    let mut stream = Vec::<u8>::new();
    // Marks start at 1 — `:0` is fast-import's null sentinel, see the module doc.
    let mut mark = 1u32;
    let mut ts = 1_700_000_000usize;

    emit_commit(&mut stream, "refs/heads/main", Some(mark), ts, "root", "trunk.txt", None, None);
    let mut main_tip = mark;
    mark += 1;
    ts += 1;

    for c in 0..MERGE_CYCLES {
        let topic = format!("refs/heads/topic{c}");
        let mut topic_tip = 0u32;
        for k in 0..COMMITS_PER_TOPIC {
            let from = if k == 0 { Some(main_tip) } else { None };
            emit_commit(&mut stream, &topic, Some(mark), ts, &format!("topic{c} commit {k}"), &format!("topic{c}.txt"), from, None);
            topic_tip = mark;
            mark += 1;
            ts += 1;
        }
        emit_commit(&mut stream, "refs/heads/main", Some(mark), ts, &format!("merge topic{c}"), "trunk.txt", Some(main_tip), Some(topic_tip));
        main_tip = mark;
        mark += 1;
        ts += 1;
    }

    fast_import(repo, &stream);
}

/// Read every commit out of a seeded repo, OUTSIDE any timed region — see the
/// module doc on why the revwalk must not be on the clock.
fn read_commits(repo: &TempRepo) -> Vec<RawCommit> {
    read_repo(&repo.path(), 500_000, None, None).expect("read_repo should succeed").commits
}

#[test]
fn layout_stays_fast_when_hundreds_of_lanes_are_live() {
    let repo = TempRepo::init("perf-wide");
    seed_wide_fan(&repo);
    let commits = read_commits(&repo);
    assert_eq!(commits.len(), WIDE_COMMITS, "the fan seeder produced a different history than it claims");

    let t0 = Instant::now();
    let laid: Layout = layout(&commits);
    let elapsed = t0.elapsed();

    // The assertion that keeps this file honest. Everything else here is
    // measuring width; this is what proves there IS width. `perf_graph.rs`
    // passes all three of its timing checks while exercising lane count 1 —
    // that is exactly the hole this file exists to close, and it would open
    // right back up if the fan ever silently collapsed.
    assert_eq!(
        laid.lane_count, BRANCH_COUNT,
        "expected exactly {BRANCH_COUNT} lanes: fewer means the fixture stopped being wide and this whole file \
         is measuring nothing (see the module doc), more means the allocator is failing to pack {BRANCH_COUNT} \
         concurrent lines into {BRANCH_COUNT} lanes"
    );

    // Measured at 182ms on the author's machine for this exact fixture, debug
    // profile (the one `cargo test` builds), against 1.9ms for the same 5100
    // commits laid out linearly. 3s is ~16x that, which on a CI runner running
    // 2-3x slower still leaves 6x of room — loose enough not to flake, tight
    // enough that the 10x-and-up regressions this class actually produces do
    // not fit under it. It is deliberately a much smaller multiple than
    // `perf_graph.rs`'s 10-15s ceilings, which is affordable only because this
    // clock covers layout alone and not a revwalk's I/O.
    assert!(
        elapsed < Duration::from_secs(3),
        "layout took {elapsed:?} for {WIDE_COMMITS} commits at {BRANCH_COUNT} lanes — possible performance regression"
    );
    eprintln!("[perf] graph_layout_wide: {elapsed:?} for {WIDE_COMMITS} commits at {} lanes", laid.lane_count);
}

#[test]
fn lanes_are_recycled_across_hundreds_of_branch_and_merge_cycles() {
    let repo = TempRepo::init("perf-recycle");
    seed_branch_and_merge(&repo);
    let commits = read_commits(&repo);
    assert_eq!(commits.len(), MERGE_COMMITS, "the branch-and-merge seeder produced a different history than it claims");

    let t0 = Instant::now();
    let laid = layout(&commits);
    let elapsed = t0.elapsed();

    // No clock, no machine, no flake: {MERGE_CYCLES} branches were created and
    // merged, and the allocator needed 2 slots. `LayoutBuilder`'s `lanes`
    // vector only ever GROWS (a converged lane becomes `None` in place, the
    // vector never shrinks), so `lane_count` is precisely "how many slots were
    // ever needed at once". If `alloc`'s free-slot scan stopped reusing `None`
    // entries — the one bug that makes lane recycling silently stop working —
    // this reads 601, not 2, and it reads it identically everywhere.
    assert_eq!(
        laid.lane_count, 2,
        "{MERGE_CYCLES} sequential branch-and-merge cycles need exactly 2 lanes (main's, plus whichever topic is \
         open); {} means converged lanes are no longer being recycled",
        laid.lane_count
    );
    eprintln!("[perf] graph_layout_recycled: {elapsed:?} for {MERGE_COMMITS} commits across {MERGE_CYCLES} branch-and-merge cycles");
}

#[test]
fn a_wide_stretch_still_batches_hundreds_of_rows_at_a_time() {
    let repo = TempRepo::init("perf-wide-batch");
    seed_wide_fan(&repo);

    let mut sizes: Vec<usize> = Vec::new();
    let mut lane_count = 0usize;
    let mut total = 0usize;
    stream_graph_core(&repo.path(), None, None, 1, 1000, 500_000, || false, |b: GraphBatch| {
        if !b.rows.is_empty() {
            sizes.push(b.rows.len());
        }
        lane_count = lane_count.max(b.lane_count);
        total = total.max(b.total_so_far);
    });

    // `GraphBatch.lane_count` is the running high-water the frontend sizes the
    // canvas from; same claim as the layout test, asserted on the type the app
    // actually receives.
    assert_eq!(lane_count, BRANCH_COUNT, "the streamed batches must report the same {BRANCH_COUNT}-lane width");
    assert_eq!(total, WIDE_COMMITS);
    assert!(sizes.len() >= 3, "expected several batches, got {sizes:?}");

    // This guards a constant, not the allocator, and it guards it against a
    // regression that already shipped once. `MAX_GAP_SEGMENTS_PER_BATCH`
    // (commands.rs) caps a batch by gap SEGMENTS, and a wide stretch emits one
    // segment per live lane per row — so the cap divided by the lane count is
    // the rows-per-batch ceiling. At 400 lanes and today's 200_000 that is 500
    // rows, which is what this fixture produces. Under the OLD 20_000 it was
    // 50, and commands.rs's own doc records what that felt like: "tens of
    // thousands of extra graph-batch IPC round-trips for the exact same total
    // data, which is what made a genuinely large, widely-branched repo feel
    // like it never finished loading". Nothing tested it, because nothing else
    // in the suite ever opens 400 lanes.
    //
    // First and last are excluded on purpose and are not slack: the first
    // batch flushes early at FIRST_BATCH_SIZE (64) so the first frame paints
    // fast, and the last is whatever the walk had left over.
    let steady = &sizes[1..sizes.len() - 1];
    let smallest = *steady.iter().min().expect("a batch between the first and the last");
    assert!(
        smallest >= 250,
        "a {BRANCH_COUNT}-lane stretch batched only {smallest} rows (all batches: {sizes:?}) — \
         MAX_GAP_SEGMENTS_PER_BATCH has been lowered back into the range that made wide repos crawl"
    );
}

#[test]
fn wide_layout_keeps_every_lane_in_bounds_and_every_gap_free_of_duplicates() {
    let repo = TempRepo::init("perf-wide-invariants");
    seed_wide_fan(&repo);
    let commits = read_commits(&repo);
    let laid = layout(&commits);
    let n = commits.len();

    // `graph.rs` asserts these same invariants, on a 5-commit repo with one
    // branch and one merge — i.e. at lane count 2, where lane reuse barely
    // happens. Re-running them at 400 lanes over ~1.8M segments is where an
    // off-by-one in `alloc`'s free-slot scan or in the merge fan-out's
    // `top_of` bookkeeping would actually have room to show up.
    for (i, &lane) in laid.lane.iter().enumerate() {
        assert!(lane >= 0 && (lane as usize) < laid.lane_count, "row {i}: lane {lane} outside 0..{}", laid.lane_count);
    }
    for (i, (&t, &b)) in laid.gap_top.iter().zip(laid.gap_bot.iter()).enumerate() {
        assert!(t >= 0 && (t as usize) < laid.lane_count, "gap segment {i}: top lane {t} out of bounds");
        assert!(b >= 0 && (b as usize) < laid.lane_count, "gap segment {i}: bottom lane {b} out of bounds");
    }

    assert_eq!(laid.gap_start.len(), n + 1);
    assert_eq!(laid.gap_start[n] as usize, laid.gap_top.len(), "the CSR index must account for every segment");

    // One HashSet reused across ~5100 gaps rather than one per gap: at this
    // width the per-gap allocation is the dominant cost of the check itself.
    let mut seen: HashSet<(i16, i16)> = HashSet::with_capacity(laid.lane_count);
    for r in 0..n {
        let (start, end) = (laid.gap_start[r] as usize, laid.gap_start[r + 1] as usize);
        assert!(end >= start, "gap_start must be non-decreasing at row {r}");
        assert!(
            end - start <= laid.lane_count,
            "gap {r} has {} segments but only {} lanes exist — a gap draws one segment per LIVE lane",
            end - start,
            laid.lane_count
        );
        seen.clear();
        for idx in start..end {
            let pair = (laid.gap_top[idx], laid.gap_bot[idx]);
            assert!(seen.insert(pair), "row {r}: segment {pair:?} duplicated within the same gap");
        }
    }
}
