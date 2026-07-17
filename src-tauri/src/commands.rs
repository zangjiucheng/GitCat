//! Tauri commands exposed to the frontend.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use git2::{Delta, DiffFindOptions, DiffOptions, Patch};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, Wry};

use crate::git_read::{read_repo, walk_repo};
use crate::layout::{layout, LayoutBuilder, NCOL};
use crate::model::{
    CommitDetail, CommitMeta, DiffHunkRow, DiffLineRow, FileChange, GraphBatch, GraphData, Person,
};

/// Static app metadata for the custom About panel — the same `PackageInfo`
/// fields `menu.rs`'s native-About builder reads, just reshaped as a plain
/// serializable struct instead of Tauri's menu-only `AboutMetadata` type.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub description: String,
    pub authors: Vec<String>,
    pub copyright: String,
    pub website: String,
}

/// JS: `commands.getAppInfo()`. No repo/path needed — this is pure static
/// build-time metadata (Cargo.toml's `[package]` table), never `Err`.
#[tauri::command]
#[specta::specta]
pub fn get_app_info(app: tauri::AppHandle<tauri::Wry>) -> AppInfo {
    let pkg = app.package_info();
    AppInfo {
        name: pkg.name.clone(),
        version: pkg.version.to_string(),
        description: pkg.description.to_string(),
        authors: pkg.authors.split(':').map(|s| s.trim().to_string()).collect(),
        copyright: "\u{a9} Jiucheng Zang".to_string(),
        website: "https://github.com/zangjiucheng/GitCat".to_string(),
    }
}

/// Caps so a monster commit (vendored dir, generated lockfile) can't stall the
/// UI or blow up the payload. Beyond these we flag truncation and stop.
const MAX_FILES: usize = 40;
const MAX_LINES_PER_FILE: usize = 2000;

/// How many commits accumulate before one `"graph-batch"` event fires — small
/// enough that the first batch (the newest, most-relevant commits) arrives
/// almost instantly regardless of total repo size, large enough not to spam
/// hundreds of thousands of tiny IPC events on a genuinely huge repo.
const BATCH_SIZE: usize = 1000;
/// Secondary flush trigger, alongside `BATCH_SIZE`'s row-count one: a row's
/// OWN gap-segment count scales with how many lanes are simultaneously
/// active where it falls in history, not with row count at all — a repo with
/// genuinely wide/complex branching (many long-lived branches left
/// unfiltered — e.g. auto-visibility mode deliberately never restricts
/// `visible_remote`, see `sidebar.svelte.ts`'s `recomputeAutoVisibility`) can
/// produce far more than `BATCH_SIZE` gap segments within a single 1000-row
/// window. Capping the PAYLOAD size this way, independent of row count, keeps
/// a single "graph-batch" event from growing pathologically large during a
/// wide stretch of history.
///
/// ADVERSARIALLY-FOUND FIX: this used to be 20,000 — chosen back when the
/// frontend appended each batch's gap arrays with `arr.push(...payload)`
/// (a JS argument-count-limited spread, since fixed to a plain loop, see
/// `legacy/main.ts`'s `appendAll`). With that limit gone, 20,000 was needless
/// and actively harmful: a real widely-branched repo (hundreds of
/// simultaneously open lanes, e.g. every unfiltered remote branch) hit this
/// cap almost every commit, flushing batches of ~15-20 ROWS instead of
/// `BATCH_SIZE`'s intended 1000 — tens of thousands of extra "graph-batch"
/// IPC round-trips (each with its own fixed JS-side event-dispatch/redraw
/// overhead) for the exact same total data, which is what made a genuinely
/// large, widely-branched repo feel like it never finished loading. Raised
/// 10x — still keeps any one payload to a few MB, comfortably local-IPC-sized
/// — so a wide stretch of history batches at roughly ~150-200 rows instead of
/// ~15-20.
const MAX_GAP_SEGMENTS_PER_BATCH: usize = 200_000;
/// Floor on the gap between two consecutive "graph-batch" emissions for the
/// SAME load, enforced in [`stream_graph`] (not [`stream_graph_core`] itself
/// — see that function's own doc comment on why the split keeps this out of
/// the fast, deterministic unit tests). On a fast machine walking a real,
/// widely-branched repo, `stream_graph_core` can fill a full batch (either
/// `BATCH_SIZE` rows or `MAX_GAP_SEGMENTS_PER_BATCH` gap segments) in well
/// under a millisecond — nothing stops it from emitting dozens of events per
/// frame. Each individual event is cheap on the frontend, but many of them
/// arriving back-to-back can occupy the WebView's main thread long enough
/// that the separate requestAnimationFrame loop never gets a turn until the
/// whole burst drains, which is what made the canvas look frozen/blank while
/// the walk raced ahead of what the UI could actually show (see
/// `legacy/main.ts`'s own `onGraphBatch` doc comment for the frontend half of
/// this fix — a throttled explicit `draw()` call). Sleeping the REMAINDER of
/// this interval (not an unconditional fixed sleep) after every intermediate
/// batch caps the background walk's own emission rate — and therefore both
/// its IPC/serialization overhead and the main thread's event-processing
/// load — to roughly what one frame can absorb, without slowing down a walk
/// that's naturally producing batches slower than this anyway (the common
/// case for most real repos, where a batch takes longer than one frame to
/// accumulate in the first place). Never applied to the final (`done`) batch,
/// since delaying "loading is complete" serves no purpose.
const MIN_BATCH_INTERVAL: Duration = Duration::from_millis(8);
/// Caps how many commits stay resident in the frontend's live buffer, unlike
/// the old `DEFAULT_LIMIT` (50,000) this replaces, which silently truncated
/// EVERY real repo's history at that point regardless of size — streaming
/// means the cost of a large history is paid incrementally/lazily instead of
/// all at once up front, so there's no reason to cap depth for ordinary repos
/// the way that old default did.
///
/// This one's a genuine memory backstop, not a UX default: `legacy/main.ts`'s
/// `BACKEND` keeps every streamed row (and, for a widely-branched repo, WAY
/// more gap segments than rows — see `MAX_GAP_SEGMENTS_PER_BATCH`'s own doc
/// comment) resident in the WebView's memory for the lifetime of the repo
/// being open, with no eviction — an unbounded walk against a truly enormous
/// or pathologically wide repo (a many-million-commit synthetic stress case,
/// or real history with an extreme concurrently-open-lane stretch) could
/// otherwise grow that buffer into the hundreds of MB to low GB range. Half a
/// million commits comfortably covers real-world history depth (for
/// reference, a full CPython checkout across every maintenance branch is
/// ~150,000 commits) while keeping worst-case memory bounded. Unlike a
/// genuine walk error, hitting this is surfaced to the user as `truncated`
/// (see `GraphBatch`'s own doc comment) rather than silently looking like a
/// complete, ordinary finish.
const MAX_LIVE_COMMITS: usize = 500_000;

/// Guards a streaming `load_graph` load against a since-superseded call —
/// switching repos, closing one, or a manual refresh all call `load_graph`
/// again with a NEW caller-supplied `request_id` (see `load_graph`'s own doc
/// comment for why the caller, not this state, owns id generation), and each
/// call's `accept()` overwrites `generation` so any still-running background
/// walk for an OLDER id notices at its next per-commit check (see
/// `stream_graph`) and stops on its own — no explicit cancel round-trip
/// needed, unlike `git_bisect::BisectRunState`'s own cancel flag (this
/// codebase's closest precedent for a long-running background op guarded by
/// atomics with progress delivered via `app.emit(...)`). One load in flight
/// at a time per app, mirroring `watch::WatchState`'s "one thing active at a
/// time" scope.
#[derive(Default)]
pub struct GraphLoadState {
    generation: AtomicU64,
}

impl GraphLoadState {
    fn accept(&self, request_id: u64) {
        self.generation.store(request_id, Ordering::SeqCst);
    }
    fn is_current(&self, gen: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == gen
    }
}

/// Start a STREAMING graph load and return almost immediately — the actual
/// data arrives entirely via `"graph-batch"` events (see [`stream_graph`]),
/// not this command's own return value. Replaces the old "one big blocking
/// call, capped at 50,000 commits" design: a huge repo used to make the user
/// wait out the entire (capped) walk before anything painted; now the newest
/// commits stream in almost instantly and the rest continues in the
/// background, with no cap on total history depth short of the memory-bounded
/// backstop (see [`MAX_LIVE_COMMITS`]'s own doc comment).
///
/// `request_id` is CALLER-supplied (a simple monotonic counter on the
/// frontend — see `legacy/main.ts`'s `startGraphStream`), not generated here,
/// specifically so the caller can record "this is the generation I'm now
/// expecting" SYNCHRONOUSLY, before ever awaiting this command's own return.
/// ADVERSARIALLY-FOUND BUG this fixes: with a server-generated id (the
/// original design), the frontend only learned its own generation once this
/// command's IPC round-trip finished — but the spawned background walk below
/// starts running (on a separate OS thread) immediately after
/// `state.accept()`, and can emit its first `"graph-batch"` event before that
/// round-trip completes. The frontend's stale-batch filter would then reject
/// that very first (and possibly several more) batches as belonging to a
/// generation it hadn't recorded yet — the exact reason "Loading repository…"
/// could keep showing well past when real data had actually started arriving.
///
/// Still fails fast and synchronously for the common "bad path" case (same
/// as the old blocking command did) by opening the repo once, off-thread,
/// before ever spawning the background walk — a repo that opens fine here
/// but somehow fails mid-walk (rare) is instead surfaced via a final
/// `GraphBatch.error`, since by that point this command has already returned.
#[tauri::command]
#[specta::specta]
pub async fn load_graph(app: AppHandle<Wry>, state: State<'_, GraphLoadState>, path: String, request_id: u64) -> Result<(), String> {
    // Accepted SYNCHRONOUSLY, before the probe below even starts — any batch
    // the spawned walk emits from this point on will already match.
    state.accept(request_id);
    let probe_path = path.clone();
    crate::blocking::run_blocking(move || crate::trust::open_repo(&probe_path).map(|_| ()))
        .await
        .map_err(|e| format!("cannot open repository: {}", e.message()))?;

    let app2 = app.clone();
    // NOT awaited: spawn_blocking's returned JoinHandle, simply dropped here,
    // keeps the task running to completion detached — the same
    // `run_blocking` primitive `blocking.rs` already wraps for every other
    // repo-touching command, just not awaited this one time. This is what
    // lets `load_graph` return here almost immediately while the real walk
    // continues in the background, purely via emitted events.
    tauri::async_runtime::spawn_blocking(move || stream_graph(&app2, request_id, &path));
    Ok(())
}

/// The walk+layout+emit loop itself, run off-thread (see [`load_graph`]'s own
/// doc comment) — looks up [`GraphLoadState`]/branch-visibility itself via
/// `app.state()`/`repo_registry::visible_branches_for` rather than receiving
/// them as parameters, since this runs detached from the command that
/// spawned it.
///
/// Interleaves [`crate::git_read::walk_repo`]'s revwalk with a
/// [`LayoutBuilder`], buffering up to [`BATCH_SIZE`] rows before emitting a
/// `"graph-batch"` event — WITH A ONE-ROW LAG: a row's own trailing gap is
/// only known once the NEXT commit is processed (`LayoutBuilder::push`'s own
/// doc comment), so each row is held in `pending` until the following
/// `push()` call reveals its gap, then moved into the batch. The very last
/// row's trailing gap is empty (nothing below the last row — matches
/// `layout()`'s own indexing) and is flushed once the walk itself ends.
///
/// Thin `AppHandle`-aware shell around [`stream_graph_core`] — looks up
/// [`GraphLoadState`]/branch-visibility itself (rather than receiving them as
/// parameters, since this runs detached from the command that spawned it)
/// and wires `should_cancel`/`on_batch` to the real state/`app.emit`. Split
/// this way so the actual walk/batch/cancellation logic is directly
/// unit-testable without a real `AppHandle` — mirrors `watch.rs`'s
/// `start_watching`/`watch_repo` split and `git_bisect.rs`'s
/// `run_bisect`/`bisect_run_start` split (see `tests/graph.rs`).
fn stream_graph(app: &AppHandle<Wry>, gen: u64, path: &str) {
    let state = app.state::<GraphLoadState>();
    if !state.is_current(gen) {
        return; // superseded before this task even got scheduled — skip the vb lookup/walk-setup entirely
    }
    // A branch-visibility-filter lookup failure degrades to "no filter" (walk
    // everything) rather than aborting the whole load — the filter is a
    // convenience, not a correctness requirement, and `path` has ALREADY been
    // confirmed to open fine by `load_graph`'s own synchronous probe.
    let vb = crate::repo_registry::visible_branches_for(app, path).unwrap_or_default();

    // See MIN_BATCH_INTERVAL's own doc comment — throttles the walk's own
    // emission rate so it can never flood the frontend's main thread faster
    // than roughly one batch per frame, regardless of how fast this machine
    // can walk+layout a wide/dense stretch of history.
    let mut last_emit = Instant::now();
    stream_graph_core(
        path,
        vb.local.as_deref(),
        vb.remote.as_deref(),
        gen,
        BATCH_SIZE,
        MAX_LIVE_COMMITS,
        || !state.is_current(gen),
        |batch| {
            let done = batch.done;
            let _ = app.emit("graph-batch", batch);
            if !done {
                let elapsed = last_emit.elapsed();
                if elapsed < MIN_BATCH_INTERVAL {
                    std::thread::sleep(MIN_BATCH_INTERVAL - elapsed);
                }
            }
            last_emit = Instant::now();
        },
    );
}

/// Checks `should_cancel()` before processing every commit: once it flips
/// true (a newer `load_graph` call superseded this one), the walk just stops
/// and this function returns WITHOUT ever calling `on_batch` with
/// `done: true` — any batch already delivered is separately filtered out
/// client-side by its `generation` not matching whatever the frontend is
/// currently expecting, so a stale walk winding down never corrupts a newer
/// one's in-progress graph.
pub fn stream_graph_core(
    path: &str,
    visible_local: Option<&[String]>,
    visible_remote: Option<&[String]>,
    generation: u64,
    batch_size: usize,
    max_commits: usize,
    mut should_cancel: impl FnMut() -> bool,
    mut on_batch: impl FnMut(GraphBatch),
) {
    let t0 = Instant::now();
    let mut builder = LayoutBuilder::new();
    let mut total = 0usize;
    // Set once the walk stops because it hit MAX_LIVE_COMMITS specifically —
    // as opposed to a genuine natural finish or a should_cancel() supersede —
    // so the final batch can tell the frontend "there's more, this was capped"
    // rather than looking like an ordinary complete load.
    let mut hit_ceiling = false;

    let mut b_rows: Vec<CommitMeta> = Vec::with_capacity(batch_size);
    let mut b_lane: Vec<i16> = Vec::with_capacity(batch_size);
    let mut b_color: Vec<u8> = Vec::with_capacity(batch_size);
    let mut b_merge: Vec<u8> = Vec::with_capacity(batch_size);
    let mut b_gap_counts: Vec<i32> = Vec::with_capacity(batch_size);
    let mut b_gap_top: Vec<i16> = Vec::new();
    let mut b_gap_bot: Vec<i16> = Vec::new();
    let mut b_gap_color: Vec<u8> = Vec::new();
    // The most recently pushed row's own (meta, lane, color, merge) — held
    // back exactly one step, see this function's own doc comment.
    let mut pending: Option<(CommitMeta, i16, u8, u8)> = None;

    macro_rules! flush {
        ($done:expr, $error:expr, $truncated:expr) => {
            if !b_rows.is_empty() || $done {
                on_batch(GraphBatch {
                    generation,
                    rows: std::mem::take(&mut b_rows),
                    lane: std::mem::take(&mut b_lane),
                    color: std::mem::take(&mut b_color),
                    merge: std::mem::take(&mut b_merge),
                    gap_counts: std::mem::take(&mut b_gap_counts),
                    gap_top: std::mem::take(&mut b_gap_top),
                    gap_bot: std::mem::take(&mut b_gap_bot),
                    gap_color: std::mem::take(&mut b_gap_color),
                    ncol: NCOL,
                    lane_count: builder.lane_count(),
                    total_so_far: total,
                    done: $done,
                    truncated: $truncated,
                    elapsed_ms: t0.elapsed().as_secs_f64() * 1000.0,
                    error: $error,
                });
            }
        };
    }

    let result = walk_repo(path, visible_local, visible_remote, |raw, refs| {
        if should_cancel() {
            return false;
        }
        if total >= max_commits {
            hit_ceiling = true;
            return false;
        }

        let sha = raw.id.to_string();
        let short_sha = sha[..7.min(sha.len())].to_string();
        let row_refs = refs.get(&sha).cloned().unwrap_or_default();
        let out = builder.push(&raw);

        // `out.gap_segments` belongs to the PREVIOUS row (whatever is
        // currently in `pending`) — see this function's own doc comment.
        if let Some((pm, pl, pc, pmg)) = pending.take() {
            b_rows.push(pm);
            b_lane.push(pl);
            b_color.push(pc);
            b_merge.push(pmg);
            b_gap_counts.push(out.gap_segments.len() as i32);
            for &(t, bt, col) in &out.gap_segments {
                b_gap_top.push(t);
                b_gap_bot.push(bt);
                b_gap_color.push(col);
            }
            total += 1;
        }

        pending = Some((
            CommitMeta {
                sha: short_sha,
                subject: raw.subject.clone(),
                an: Person { n: raw.author.0.clone(), e: raw.author.1.clone(), t: raw.author.2 },
                cm: Person { n: raw.committer.0.clone(), e: raw.committer.1.clone(), t: raw.committer.2 },
                refs: row_refs,
                merge: out.merge == 1,
            },
            out.lane,
            out.color,
            out.merge,
        ));

        if b_rows.len() >= batch_size || b_gap_top.len() >= MAX_GAP_SEGMENTS_PER_BATCH {
            flush!(false, None, false);
        }

        true
    });

    // A superseded generation stops silently here — never emits a final
    // batch, matching this function's own doc comment.
    if should_cancel() {
        return;
    }

    // The last row's own trailing gap is empty (nothing below it) — matches
    // `layout()`'s own indexing exactly.
    if let Some((pm, pl, pc, pmg)) = pending.take() {
        b_rows.push(pm);
        b_lane.push(pl);
        b_color.push(pc);
        b_merge.push(pmg);
        b_gap_counts.push(0);
        total += 1;
    }

    let error = result.err().map(|e| e.message().to_string());
    flush!(true, error, hit_ceiling);
}

/// Open `path`, walk its commits, lay out the swimlane graph, and return the
/// full payload the canvas renders. `limit` caps how many commits are loaded.
/// `visible_local`/`visible_remote`: `None`+`None` walks every branch (today's
/// default); `Some`+`Some` restricts the walk to just the named branches (+
/// HEAD, always) — see `git_read::read_repo`'s own doc comment.
pub fn build_graph(
    path: &str,
    limit: usize,
    visible_local: Option<&[String]>,
    visible_remote: Option<&[String]>,
) -> Result<GraphData, String> {
    let t0 = Instant::now();
    let mut read = read_repo(path, limit, visible_local, visible_remote).map_err(|e| e.message().to_string())?;
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

/// Tauri command: return the full message + real changed-file tree + diff hunks
/// for a single commit. Diffs the commit tree against its FIRST parent (empty
/// tree for a root commit; first parent for a merge). Read-only.
#[tauri::command]
#[specta::specta]
pub fn commit_detail(path: String, sha: String) -> Result<CommitDetail, String> {
    commit_detail_inner(&path, &sha).map_err(|e| e.message().to_string())
}

fn commit_detail_inner(path: &str, sha: &str) -> Result<CommitDetail, git2::Error> {
    let repo = crate::trust::open_repo(path)?;
    // `sha` may be a 7-char abbreviation (the graph rows carry short shas) or a
    // full 40-char oid; find_commit_by_prefix resolves either.
    let commit = repo.find_commit_by_prefix(sha)?;
    let full_sha = commit.id().to_string();
    let subject = commit.summary().unwrap_or("").to_string();
    let body = commit.body().unwrap_or("").trim_end().to_string();
    let message = commit.message().unwrap_or("").to_string();

    // New side is this commit's tree; old side is the first parent's tree, or
    // None (the empty tree) for a root commit -> everything shows as added.
    let new_tree = commit.tree()?;
    let parent_tree = if commit.parent_count() > 0 {
        Some(commit.parent(0)?.tree()?)
    } else {
        None
    };

    let mut opts = DiffOptions::new();
    opts.context_lines(3)
        .include_typechange(true)
        .id_abbrev(7);
    let mut diff =
        repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&new_tree), Some(&mut opts))?;

    // Fold rename/copy detection in so status R/C (and old_path) are meaningful.
    let mut find = DiffFindOptions::new();
    find.renames(true).copies(true).rename_limit(1000); // bound O(files^2) scan on pathological commits
    let _ = diff.find_similar(Some(&mut find));

    let num_deltas = diff.deltas().len();
    let mut file_tree: Vec<FileChange> = Vec::new();
    let mut total_add = 0usize;
    let mut total_del = 0usize;
    let mut diff_truncated = false;

    for idx in 0..num_deltas {
        if file_tree.len() >= MAX_FILES {
            diff_truncated = true;
            break;
        }
        let delta = match diff.get_delta(idx) {
            Some(d) => d,
            None => continue,
        };
        if matches!(delta.status(), Delta::Unmodified) {
            continue;
        }

        let status = status_char(delta.status()).to_string();
        let new_path = path_of(delta.new_file().path());
        let old_path = path_of(delta.old_file().path());
        let is_rename = matches!(delta.status(), Delta::Renamed | Delta::Copied);
        // Show the new path; fall back to the old path for a delete.
        let path = new_path
            .clone()
            .filter(|p| !p.is_empty())
            .or_else(|| old_path.clone())
            .unwrap_or_default();
        let lang = guess_lang(&path);
        let old_path = if is_rename { old_path } else { None };

        // Generating the patch loads the blobs, which populates the delta's
        // binary flag. `from_diff` returns None for a binary (or unchanged)
        // file, but for some binaries it still returns a hunk-less patch, so
        // also consult the file flags.
        let patch = Patch::from_diff(&diff, idx)?;
        let is_binary =
            patch.is_none() || delta.new_file().is_binary() || delta.old_file().is_binary();
        if is_binary {
            file_tree.push(FileChange {
                path,
                old_path,
                status,
                additions: 0,
                deletions: 0,
                binary: true,
                truncated: false,
                lang,
                hunks: Vec::new(),
            });
            continue;
        }
        let patch = patch.expect("non-binary patch is Some");

        let (_context, additions, deletions) = patch.line_stats()?;
        total_add += additions;
        total_del += deletions;

        let mut hunks: Vec<DiffHunkRow> = Vec::new();
        let mut emitted = 0usize;
        let mut file_truncated = false;
        let num_hunks = patch.num_hunks();
        'hunks: for h in 0..num_hunks {
            let (hunk, _lines) = patch.hunk(h)?;
            let header = String::from_utf8_lossy(hunk.header())
                .trim_end_matches(['\n', '\r'])
                .to_string();
            let n = patch.num_lines_in_hunk(h)?;
            let mut rows: Vec<DiffLineRow> = Vec::with_capacity(n);
            for l in 0..n {
                if emitted >= MAX_LINES_PER_FILE {
                    file_truncated = true;
                    diff_truncated = true;
                    break 'hunks;
                }
                let line = patch.line_in_hunk(h, l)?;
                // Keep only real content lines; skip the "\ No newline at end of
                // file" EOFNL markers ('=','>','<') and any header pseudo-lines.
                let kind = match line.origin() {
                    '+' => "+",
                    '-' => "-",
                    ' ' => " ",
                    _ => continue,
                };
                let text = String::from_utf8_lossy(line.content())
                    .trim_end_matches(['\n', '\r'])
                    .to_string();
                rows.push(DiffLineRow {
                    kind: kind.to_string(),
                    old_no: line.old_lineno(),
                    new_no: line.new_lineno(),
                    text,
                });
                emitted += 1;
            }
            hunks.push(DiffHunkRow { header, lines: rows });
        }

        file_tree.push(FileChange {
            path,
            old_path,
            status,
            additions,
            deletions,
            binary: false,
            truncated: file_truncated,
            lang,
            hunks,
        });
    }

    let short_sha = full_sha[..7.min(full_sha.len())].to_string();
    Ok(CommitDetail {
        sha: full_sha,
        short_sha,
        subject,
        body,
        message,
        additions: total_add,
        deletions: total_del,
        files_changed: file_tree.len(),
        truncated: diff_truncated,
        file_tree,
    })
}

/// libgit2 delta status -> the one-letter code the frontend tree renders.
fn status_char(status: Delta) -> &'static str {
    match status {
        Delta::Added => "A",
        Delta::Deleted => "D",
        Delta::Renamed => "R",
        Delta::Copied => "C",
        Delta::Typechange => "T",
        _ => "M", // Modified and anything else tree-diffs produce
    }
}

/// A diff-side path (relative to repo root) as an owned String, if present.
fn path_of(p: Option<&std::path::Path>) -> Option<String> {
    p.map(|p| p.to_string_lossy().into_owned())
}

/// Extension -> a `GRAMMARS` key the frontend highlighter understands; unknown
/// extensions fall back to "generic" (the JS does `GRAMMARS[lang]||generic`).
fn guess_lang(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => "ts",
        _ => "generic",
    }
    .to_string()
}
