//! Snapshot retention pruning — `safety::prune_backups` (the "off/count/age/
//! hybrid" policy behind the Settings > Snapshots cleanup). The policy decides
//! which backup refs get DELETED, so it's worth pinning down precisely.
//!
//! Real `snapshot()` always stamps the ref with `now`, so to exercise the age
//! dimension these tests write backup refs by hand in the exact
//! `refs/gitgui/backup/<secs>-<nanos>-<seq>` shape `snapshots()` parses `ts`
//! from. Each test runs in its own fresh temp repo.

mod common;

use std::time::{SystemTime, UNIX_EPOCH};

use common::TempRepo;
use gitcat_lib::safety::{prune_backups, snapshots};

const DAY: i64 = 86_400;

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

/// Write a backup ref stamped at `secs` (the `ts` snapshots() will parse back
/// out of the name) with a unique `seq`, pointing at `sha`.
fn backup(repo: &TempRepo, secs: i64, seq: u32, sha: &str) {
    repo.must(&["update-ref", &format!("refs/gitgui/backup/{secs}-0-{seq}"), sha]);
}

/// Remaining snapshots' timestamps, newest-first (snapshots() sorts desc).
fn remaining_ts(repo: &TempRepo) -> Vec<i64> {
    snapshots(&repo.open()).unwrap().into_iter().map(|s| s.ts).collect()
}

#[test]
fn off_is_a_noop() {
    let repo = TempRepo::init("prune_off");
    let c = repo.commit("f.txt", "0\n", "c0");
    for i in 0..4 {
        backup(&repo, 1000 + i as i64, i, &c);
    }
    assert_eq!(prune_backups(&repo.open(), "off", 1, 1).unwrap(), 0);
    assert_eq!(remaining_ts(&repo).len(), 4);
}

#[test]
fn count_keeps_the_newest_n() {
    let repo = TempRepo::init("prune_count");
    let c = repo.commit("f.txt", "0\n", "c0");
    for i in 0..5 {
        backup(&repo, 1000 + i as i64, i, &c); // ts 1000..=1004
    }
    // Keep the newest 2 (1004, 1003); delete 1002/1001/1000.
    assert_eq!(prune_backups(&repo.open(), "count", 2, 0).unwrap(), 3);
    assert_eq!(remaining_ts(&repo), vec![1004, 1003]);
}

#[test]
fn count_floor_always_spares_the_single_newest_even_at_zero() {
    let repo = TempRepo::init("prune_count0");
    let c = repo.commit("f.txt", "0\n", "c0");
    for i in 0..3 {
        backup(&repo, 1000 + i as i64, i, &c);
    }
    // count=0 asks to keep nothing, but the safety floor spares the newest.
    assert_eq!(prune_backups(&repo.open(), "count", 0, 0).unwrap(), 2);
    assert_eq!(remaining_ts(&repo), vec![1002]);
}

#[test]
fn age_keeps_recent_deletes_old() {
    let repo = TempRepo::init("prune_age");
    let c = repo.commit("f.txt", "0\n", "c0");
    let now = now_secs();
    backup(&repo, now - DAY, 0, &c); // recent
    backup(&repo, now - 2 * DAY, 1, &c); // recent
    backup(&repo, now - 30 * DAY, 2, &c); // old
    backup(&repo, now - 60 * DAY, 3, &c); // old
    // days=7: keep the two recent, delete the two old.
    assert_eq!(prune_backups(&repo.open(), "age", 0, 7).unwrap(), 2);
    assert_eq!(remaining_ts(&repo), vec![now - DAY, now - 2 * DAY]);
}

#[test]
fn age_floor_spares_the_newest_when_everything_is_old() {
    let repo = TempRepo::init("prune_age_allold");
    let c = repo.commit("f.txt", "0\n", "c0");
    let now = now_secs();
    backup(&repo, now - 30 * DAY, 0, &c);
    backup(&repo, now - 60 * DAY, 1, &c);
    // Both older than 7d, but the newest (now-30d) is floor-protected.
    assert_eq!(prune_backups(&repo.open(), "age", 0, 7).unwrap(), 1);
    assert_eq!(remaining_ts(&repo), vec![now - 30 * DAY]);
}

#[test]
fn hybrid_keeps_a_recent_snapshot_beyond_the_count() {
    let repo = TempRepo::init("prune_hybrid_age");
    let c = repo.commit("f.txt", "0\n", "c0");
    let now = now_secs();
    backup(&repo, now - DAY, 0, &c); // rank0 (floor)
    backup(&repo, now - 2 * DAY, 1, &c); // rank1, within count(2)
    backup(&repo, now - 3 * DAY, 2, &c); // rank2, beyond count but recent -> kept by AGE
    backup(&repo, now - 30 * DAY, 3, &c); // rank3, fails both -> delete
    backup(&repo, now - 40 * DAY, 4, &c); // rank4, fails both -> delete
    assert_eq!(prune_backups(&repo.open(), "hybrid", 2, 7).unwrap(), 2);
    assert_eq!(remaining_ts(&repo), vec![now - DAY, now - 2 * DAY, now - 3 * DAY]);
}

#[test]
fn hybrid_keeps_an_old_snapshot_within_the_count() {
    let repo = TempRepo::init("prune_hybrid_count");
    let c = repo.commit("f.txt", "0\n", "c0");
    let now = now_secs();
    backup(&repo, now - 30 * DAY, 0, &c); // rank0 (floor)
    backup(&repo, now - 40 * DAY, 1, &c); // rank1, old but within count(2) -> kept by COUNT
    backup(&repo, now - 50 * DAY, 2, &c); // rank2, fails both -> delete
    backup(&repo, now - 60 * DAY, 3, &c); // rank3, fails both -> delete
    assert_eq!(prune_backups(&repo.open(), "hybrid", 2, 7).unwrap(), 2);
    assert_eq!(remaining_ts(&repo), vec![now - 30 * DAY, now - 40 * DAY]);
}
