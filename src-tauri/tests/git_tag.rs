//! Tag lifecycle (model after tests/branch_ops.rs): create_tag / delete_tag /
//! push_tag. Asserts the one safety-critical guarantee this module exists
//! for: deleting a tag pins its ORIGINAL target under a dedicated recovery
//! ref (`refs/gitgui/deleted-tag/*`) that a) actually resolves back to what
//! the tag pointed at and b) is enough, by itself, to fully recreate the tag
//! — even for an annotated tag, whose message/tagger would otherwise be lost.

mod common;

use common::TempRepo;
use gitcat_lib::git_remote::push_tag;
use gitcat_lib::git_tag::{create_tag, delete_tag};

#[test]
fn create_lightweight_tag_defaults_to_head() {
    let repo = TempRepo::init("tag_create_lightweight");
    let c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();

    let res = tauri::async_runtime::block_on(create_tag(path.clone(), "v1".into(), None, None));
    assert!(res.ok, "create_tag failed: {}", res.message);
    assert!(res.backup_ref.is_none(), "creating a tag is purely additive — it must not snapshot");
    assert!(res.message.to_lowercase().contains("lightweight"));

    assert_eq!(repo.rev("refs/tags/v1"), Some(c0), "lightweight tag should point at HEAD");
    // A lightweight tag's ref points DIRECTLY at the commit (no separate tag object).
    assert_eq!(repo.must(&["cat-file", "-t", "refs/tags/v1"]), "commit");
}

#[test]
fn create_annotated_tag_stores_the_message() {
    let repo = TempRepo::init("tag_create_annotated");
    let c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();

    let res = tauri::async_runtime::block_on(create_tag(path.clone(), "v1".into(), None, Some("Release notes here".into())));
    assert!(res.ok, "create_tag failed: {}", res.message);
    assert!(res.message.to_lowercase().contains("annotated"));

    // An annotated tag's ref points at a real tag OBJECT, not the commit directly.
    assert_eq!(repo.must(&["cat-file", "-t", "refs/tags/v1"]), "tag");
    // ...which peels to the target commit.
    assert_eq!(repo.rev("refs/tags/v1^{}"), Some(c0));
    // ...and carries the message we asked for.
    let body = repo.must(&["cat-file", "-p", "refs/tags/v1"]);
    assert!(body.contains("Release notes here"), "tag object body missing message: {body}");
}

#[test]
fn create_tag_can_target_a_non_head_commit() {
    let repo = TempRepo::init("tag_create_target");
    let c0 = repo.commit("f.txt", "0\n", "c0");
    let _c1 = repo.commit("f.txt", "1\n", "c1");
    let path = repo.path();

    let res = tauri::async_runtime::block_on(create_tag(path.clone(), "at-c0".into(), Some(c0.clone()), None));
    assert!(res.ok, "create_tag failed: {}", res.message);
    assert_eq!(repo.rev("refs/tags/at-c0"), Some(c0), "tag should target c0, not the current HEAD (c1)");
}

#[test]
fn create_tag_rejects_a_duplicate_name() {
    let repo = TempRepo::init("tag_create_dup");
    let _c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();

    assert!(tauri::async_runtime::block_on(create_tag(path.clone(), "v1".into(), None, None)).ok);
    let dup = tauri::async_runtime::block_on(create_tag(path.clone(), "v1".into(), None, None));
    assert!(!dup.ok, "creating the same tag twice must be refused");
}

#[test]
fn delete_tag_pins_a_recovery_ref_that_resolves_to_the_original_lightweight_target() {
    let repo = TempRepo::init("tag_delete_lightweight");
    let c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();

    let created = tauri::async_runtime::block_on(create_tag(path.clone(), "todelete".into(), None, None));
    assert!(created.ok, "create_tag failed: {}", created.message);

    let deleted = tauri::async_runtime::block_on(delete_tag(path.clone(), "todelete".into()));
    assert!(deleted.ok, "delete_tag failed: {}", deleted.message);
    assert!(repo.rev("refs/tags/todelete").is_none(), "the tag ref itself should be gone");

    // The success message must be honest: NOT the generic global Undo.
    let lower = deleted.message.to_lowercase();
    assert!(lower.contains("not restorable") || lower.contains("not"), "message should say this isn't Undo-able: {}", deleted.message);
    assert!(!lower.contains("undo restores") && !lower.contains("undo will restore"), "message must not imply plain Undo restores it");
    assert!(deleted.message.contains("refs/gitgui/deleted-tag/"), "message should name the actual recovery ref: {}", deleted.message);

    // The pinned ref must exist, live under the dedicated non-undo namespace,
    // and resolve back to the tag's ORIGINAL target (c0).
    let pin_ref = deleted.backup_ref.clone().expect("delete_tag should report the pinned recovery ref");
    assert!(pin_ref.starts_with("refs/gitgui/deleted-tag/"), "unexpected pin ref namespace: {pin_ref}");
    assert_eq!(repo.rev(&pin_ref), Some(c0), "pinned ref must resolve to the tag's original target");
}

#[test]
fn delete_tag_pins_the_raw_tag_object_for_an_annotated_tag_not_just_its_commit() {
    let repo = TempRepo::init("tag_delete_annotated");
    let _c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();

    let created = tauri::async_runtime::block_on(create_tag(path.clone(), "atag".into(), None, Some("keep me".into())));
    assert!(created.ok, "create_tag failed: {}", created.message);

    // The tag ref's DIRECT (unpeeled) target is the annotated tag OBJECT, not the commit.
    let tag_object_sha = repo.must(&["rev-parse", "refs/tags/atag"]);
    assert_eq!(repo.must(&["cat-file", "-t", &tag_object_sha]), "tag");

    let deleted = tauri::async_runtime::block_on(delete_tag(path.clone(), "atag".into()));
    assert!(deleted.ok, "delete_tag failed: {}", deleted.message);
    let pin_ref = deleted.backup_ref.clone().expect("delete_tag should report the pinned recovery ref");

    // The pin must point at the TAG OBJECT itself (message/tagger preserved),
    // not the peeled commit — otherwise the annotated tag's own metadata
    // would be unreachable and eventually gc'd even though "a commit" is
    // still around.
    assert_eq!(repo.rev(&pin_ref), Some(tag_object_sha), "pin must preserve the raw tag object, not just its commit");
    assert_eq!(repo.must(&["cat-file", "-t", &pin_ref]), "tag");
}

#[test]
fn delete_then_manually_recover_via_the_pinned_ref_works_end_to_end() {
    let repo = TempRepo::init("tag_delete_recover");
    let c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();

    assert!(tauri::async_runtime::block_on(create_tag(path.clone(), "v1".into(), None, None)).ok);
    let deleted = tauri::async_runtime::block_on(delete_tag(path.clone(), "v1".into()));
    assert!(deleted.ok, "delete_tag failed: {}", deleted.message);
    assert!(repo.rev("refs/tags/v1").is_none());
    let pin_ref = deleted.backup_ref.expect("delete_tag should report the pinned recovery ref");

    // Manual recovery exactly as the message instructs: `git tag <name> <pin_ref>`.
    repo.must(&["tag", "v1", &pin_ref]);
    assert_eq!(repo.rev("refs/tags/v1"), Some(c0), "manual recovery via the pinned ref should fully restore the tag");
}

#[test]
fn push_tag_to_a_bare_remote_makes_it_appear_there() {
    let origin = TempRepo::init_bare("tag_push-origin");
    let local = TempRepo::init("tag_push-local");
    let c0 = local.commit("f.txt", "0\n", "c0");
    local.must(&["remote", "add", "origin", &origin.path()]);
    local.must(&["push", "-q", "-u", "origin", "main"]);
    let path = local.path();

    assert!(tauri::async_runtime::block_on(create_tag(path.clone(), "v1".into(), None, None)).ok);
    assert!(origin.rev("refs/tags/v1").is_none(), "tag shouldn't exist on the remote yet");

    let res = tauri::async_runtime::block_on(push_tag(path.clone(), None, "v1".into()));
    assert!(res.ok, "push_tag failed: {}", res.message);
    assert!(res.backup_ref.is_none(), "pushing a tag never touches local state, so it must not snapshot");
    assert_eq!(origin.rev("refs/tags/v1"), Some(c0), "tag should now exist on the remote, pointing at c0");
}

#[test]
fn push_tag_defaults_to_origin_and_never_forces_a_rejected_move() {
    let origin = TempRepo::init_bare("tag_push_reject-origin");
    let local = TempRepo::init("tag_push_reject-local");
    let _c0 = local.commit("f.txt", "0\n", "c0");
    local.must(&["remote", "add", "origin", &origin.path()]);
    local.must(&["push", "-q", "-u", "origin", "main"]);
    let path = local.path();

    assert!(tauri::async_runtime::block_on(create_tag(path.clone(), "v1".into(), None, None)).ok);
    assert!(tauri::async_runtime::block_on(push_tag(path.clone(), None, "v1".into())).ok);
    let remote_sha_before = origin.rev("refs/tags/v1");

    // Move the LOCAL tag to a new commit without going through GitCat, then
    // try to push again — the remote already has "v1" at a different commit,
    // so a plain push must be rejected, never forced.
    let _c1 = local.commit("g.txt", "1\n", "c1");
    local.must(&["tag", "-f", "v1"]);

    let res = tauri::async_runtime::block_on(push_tag(path.clone(), None, "v1".into()));
    assert!(!res.ok, "a moved-tag push must be rejected, not forced");
    assert_eq!(origin.rev("refs/tags/v1"), remote_sha_before, "a rejected push must never overwrite the remote's tag");
}

#[test]
fn push_tag_refuses_to_push_a_same_named_branch_when_no_such_tag_exists() {
    // Regression test: GitCat lets a branch and a tag share a name
    // (create_branch/create_tag never check the other namespace). push_tag
    // used to invoke `git push <remote> <name>` with a BARE source refspec —
    // git resolves a bare source by scanning ref namespaces itself, which is
    // NOT guaranteed to mean `refs/tags/<name>`. Empirically, with a branch
    // "X" but no tag "X", that bare push silently pushed/created a *branch*
    // `refs/heads/X` on the remote while push_tag still reported
    // `ok: true, message: "Pushed tag X to origin."` — success for having
    // pushed the wrong ref type entirely. The fix qualifies the source (and
    // destination) as `refs/tags/<name>`, so this must now fail cleanly
    // instead of silently pushing the branch.
    let origin = TempRepo::init_bare("tag_push_branch_collision-origin");
    let local = TempRepo::init("tag_push_branch_collision-local");
    let _c0 = local.commit("f.txt", "0\n", "c0");
    local.must(&["remote", "add", "origin", &origin.path()]);
    local.must(&["push", "-q", "-u", "origin", "main"]);
    let path = local.path();

    // A branch named "X" exists; NO tag named "X" exists locally.
    local.must(&["branch", "X"]);
    assert!(local.rev("refs/tags/X").is_none(), "precondition: no local tag named X");
    assert!(local.rev("refs/heads/X").is_some(), "precondition: a local branch named X exists");

    let res = tauri::async_runtime::block_on(push_tag(path.clone(), None, "X".into()));
    assert!(
        !res.ok,
        "push_tag must fail cleanly when no tag named X exists locally, not silently push the branch \
         (got ok:true, message: {:?})",
        res.message
    );
    assert!(res.backup_ref.is_none());

    // The remote's refs/heads/X must NEVER be created/modified by this call —
    // this is the crux of the regression: pushing a tag must never create a
    // branch on the remote, no matter what bare-name resolution git might do.
    assert!(
        origin.rev("refs/heads/X").is_none(),
        "push_tag must never create/modify a same-named branch on the remote"
    );
    assert!(origin.rev("refs/tags/X").is_none(), "no tag exists locally, so none should appear on the remote either");
}

#[test]
fn push_tag_pushes_the_tag_not_the_same_named_branch_when_both_exist() {
    // Companion to the regression test above: when a branch AND a tag share
    // a name but point at DIFFERENT commits, push_tag must push the tag's
    // target — never conflate the two because of an unqualified refspec.
    let origin = TempRepo::init_bare("tag_push_branch_tag_same_name-origin");
    let local = TempRepo::init("tag_push_branch_tag_same_name-local");
    let c0 = local.commit("f.txt", "0\n", "c0");
    let c1 = local.commit("f.txt", "1\n", "c1");
    assert_ne!(c0, c1);
    local.must(&["remote", "add", "origin", &origin.path()]);
    local.must(&["push", "-q", "-u", "origin", "main"]);
    let path = local.path();

    // Branch "Y" sits at c1 (HEAD); tag "Y" is deliberately created at the
    // OLDER commit c0, so the two same-named refs disagree.
    local.must(&["branch", "Y"]);
    assert!(tauri::async_runtime::block_on(create_tag(path.clone(), "Y".into(), Some(c0.clone()), None)).ok);
    assert_eq!(local.rev("refs/heads/Y"), Some(c1.clone()));
    assert_eq!(local.rev("refs/tags/Y"), Some(c0.clone()));

    let res = tauri::async_runtime::block_on(push_tag(path.clone(), None, "Y".into()));
    assert!(res.ok, "push_tag failed: {}", res.message);

    assert_eq!(origin.rev("refs/tags/Y"), Some(c0), "the pushed tag must resolve to the TAG's target, not the branch's");
    assert!(origin.rev("refs/heads/Y").is_none(), "push_tag must never create a branch on the remote");
}

#[test]
fn tag_name_validation_rejects_an_illegal_name_across_all_three_commands() {
    let repo = TempRepo::init("tag_name_validation");
    let _c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();

    // "-flag" looks like an option; ".." is never a legal ref component.
    for bad in ["-flag", "a..b"] {
        let created = tauri::async_runtime::block_on(create_tag(path.clone(), bad.into(), None, None));
        assert!(!created.ok, "create_tag should refuse {bad:?}");
        assert!(created.backup_ref.is_none());

        let deleted = tauri::async_runtime::block_on(delete_tag(path.clone(), bad.into()));
        assert!(!deleted.ok, "delete_tag should refuse {bad:?}");
        assert!(deleted.backup_ref.is_none());

        let pushed = tauri::async_runtime::block_on(push_tag(path.clone(), None, bad.into()));
        assert!(!pushed.ok, "push_tag should refuse {bad:?}");
        assert!(pushed.backup_ref.is_none());
    }

    // Never actually ran git with the illegal name.
    assert!(repo.rev("refs/tags/-flag").is_none());
}
