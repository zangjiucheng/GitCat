// Native application menu — the "系统 menu" (system menu).
//
// Two kinds of items:
//  - predefined (Cut/Copy/Paste/Select All, Minimize, Close Window, Quit, and
//    on macOS Services/Hide/Hide Others/Show All): handled entirely by the
//    OS/webview, no event ever reaches Rust. These aren't just decorative —
//    without an Edit menu wiring Cut/Copy/Paste/Select All, those shortcuts
//    don't work at all in a Tauri webview's text inputs.
//  - custom (Open/Close Repository…, New Branch…, Fetch/Pull/Push, Toggle
//    Theme, Command Palette, Bisect/Reflog/Rerere/Plumbing, About, the two
//    Help links): fire a MenuEvent caught in handle_event() below. The two
//    Help links (GitHub / Report an Issue) are handled entirely in Rust via
//    the opener plugin; the rest need the frontend (they're Svelte
//    controller / legacy chrome calls), so they're forwarded as a
//    "menu-action" JS event — see the listener in src/main.ts.
//
// About is deliberately a CUSTOM item, not the native `.about()` menu-builder
// panel: the OS-rendered About dialog can't be animated or restyled at all,
// so it's replaced with an in-app modal (see src/islands/about) that reads
// the same package metadata via the `get_app_info` command instead.
//
// Deliberately NOT included: Undo/Redo. The app already binds ⌘Z to its own
// global Safety-Manager undo (see globalUndo() in legacy/main.ts) — adding a
// native Edit>Undo item risks the OS menu accelerator intercepting ⌘Z before
// (or instead of) the existing JS keydown listener, which would be a strictly
// worse outcome than just not having the item.
use tauri::{
    menu::{Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder},
    AppHandle, Emitter, Wry,
};
use tauri_plugin_opener::OpenerExt;

const REPO_URL: &str = "https://github.com/zangjiucheng/GitCat";
const ISSUES_URL: &str = "https://github.com/zangjiucheng/GitCat/issues/new";

pub fn build(app: &AppHandle<Wry>) -> tauri::Result<Menu<Wry>> {
    let about_item = MenuItemBuilder::with_id("about", "About GitCat").build(app)?;

    #[cfg(target_os = "macos")]
    let app_menu = SubmenuBuilder::new(app, &app.package_info().name)
        .item(&about_item)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = {
        let open_repo = MenuItemBuilder::with_id("open-repo", "Open Repository\u{2026}")
            .accelerator("CmdOrCtrl+O")
            .build(app)?;
        // No accelerator: unlike Open (⌘O, a near-universal convention),
        // there's no equally obvious binding for "go back to no repo open" —
        // and it's mouse/menu-discoverable already, same reasoning as
        // Repository's Fetch/Pull/Push and View's Toggle Theme below.
        let close_repo = MenuItemBuilder::with_id("close-repo", "Close Repository").build(app)?;
        let new_branch = MenuItemBuilder::with_id("new-branch", "New Branch\u{2026}")
            .accelerator("CmdOrCtrl+Shift+N")
            .build(app)?;
        let b = SubmenuBuilder::new(app, "File")
            .item(&open_repo)
            .item(&close_repo)
            .separator()
            .item(&new_branch)
            .separator()
            .close_window();
        // Quit lives in the macOS app menu only — Windows/Linux have no app
        // menu, so File is where users expect to find it there.
        #[cfg(not(target_os = "macos"))]
        let b = b.separator().quit();
        b.build()?
    };

    let repo_menu = {
        // No accelerators — same reasoning as View's Toggle Theme/Command
        // Palette below: these are mouse/menu-discoverable, not a second
        // keyboard binding competing with anything.
        let fetch = MenuItemBuilder::with_id("fetch", "Fetch").build(app)?;
        let pull = MenuItemBuilder::with_id("pull", "Pull").build(app)?;
        let push = MenuItemBuilder::with_id("push", "Push").build(app)?;
        SubmenuBuilder::new(app, "Repository").item(&fetch).item(&pull).item(&push).build()?
    };

    // Cut/Copy/Paste/Select All aren't decorative here: without them wired up
    // via a real menu, those OS-level shortcuts don't reach text inputs at
    // all in a Tauri webview. Undo/Redo deliberately omitted — see module doc.
    let edit_menu = SubmenuBuilder::new(app, "Edit").cut().copy().paste().separator().select_all().build()?;

    let view_menu = {
        let toggle_theme = MenuItemBuilder::with_id("toggle-theme", "Toggle Theme").build(app)?;
        // No accelerator: ⌘K already works via the existing JS keydown
        // listener (see cmdk.svelte.ts) — this is a mouse-clickable way to
        // find the palette, not a second binding for the same shortcut.
        let cmdk = MenuItemBuilder::with_id("cmdk", "Command Palette\u{2026}").build(app)?;
        SubmenuBuilder::new(app, "View").item(&toggle_theme).item(&cmdk).build()?
    };

    let tools_menu = {
        // No accelerators — same reasoning as Repository's Fetch/Pull/Push and
        // View's Toggle Theme/Command Palette above. These 4 used to live in
        // a permanent bottom drawer (4 tabs, always taking up a grid row);
        // now they're on-demand, opened from here or matched in ⌘K (see
        // cmdk.svelte.ts) — each forwards through the same menu-action path
        // as everything else in this file.
        let bisect = MenuItemBuilder::with_id("bisect", "Bisect\u{2026}").build(app)?;
        let reflog = MenuItemBuilder::with_id("reflog", "Reflog\u{2026}").build(app)?;
        let rerere = MenuItemBuilder::with_id("rerere", "Rerere\u{2026}").build(app)?;
        let plumbing = MenuItemBuilder::with_id("plumbing", "Plumbing\u{2026}").build(app)?;
        let remotes = MenuItemBuilder::with_id("remotes", "Manage Remotes\u{2026}").build(app)?;
        // Patch export/apply (backlog #9, format-patch/am): two dialog-openers,
        // same "…" ellipsis convention as bisect/reflog/rerere/plumbing/remotes
        // above — "Export as Patch…" (single-commit) lives on the commit-menu
        // instead (see commitmenu.svelte.ts), not here, since it needs a
        // right-clicked commit as its target; these two are repo-global.
        let export_patches = MenuItemBuilder::with_id("export-patches", "Export Patches\u{2026}").build(app)?;
        let apply_patch = MenuItemBuilder::with_id("apply-patch", "Apply Patch\u{2026}").build(app)?;
        // Pickaxe / diff-content search (backlog #10): searches the whole
        // history's DIFFS, not just commit messages — same dialog-opener
        // "…" convention as the items above; repo-global like Manage
        // Remotes/Export Patches/Apply Patch, not file-tree-scoped like
        // Blame/File History (see pickaxesearch.svelte.ts's own header doc).
        let pickaxe_search = MenuItemBuilder::with_id("pickaxe-search", "Search Commit Content\u{2026}").build(app)?;
        // Multi-repository dashboard (backlog #11): unlike every other item in
        // this submenu, this one does NOT need a repo open at all — it's the
        // one place to check on OTHER tracked repos without leaving (or
        // needing) whichever repo is currently open. Same dialog-opener "…"
        // convention as the items above it.
        let repositories = MenuItemBuilder::with_id("repositories", "Repositories\u{2026}").build(app)?;
        // Pluggable external diff/merge tools (backlog #12): a settings
        // modal, not a per-file action (those live on Detail.svelte/
        // Workdir.svelte's own file rows and Resolver.svelte instead) — same
        // dialog-opener "…" convention as the items above it, and same
        // "reachable any time, no repo needed" shape as Repositories just
        // above (see externaltools.svelte.ts's own header doc).
        let external_tools = MenuItemBuilder::with_id("external-tools", "External Tools\u{2026}").build(app)?;
        // App Settings (theme, cherry-pick record-origin default,
        // auto-check-updates toggle, and a Git Identity section scoped to
        // whichever repo is open) — same "reachable any time, no repo
        // needed" shape as Repositories/External Tools just above (see
        // settings.svelte.ts's own header doc).
        let settings = MenuItemBuilder::with_id("settings", "Settings\u{2026}").build(app)?;
        // fsck-based dangling-object recovery (backlog #13): commits `git
        // fsck` finds with no ref/reflog pointing at them anymore (a hard
        // reset, an amend, a dropped rebase commit, a deleted branch, …) —
        // same dialog-opener "…" convention as the items above it, repo-
        // scoped like Reflog/Rerere (not repo-independent like Repositories/
        // External Tools just above).
        let dangling_recovery = MenuItemBuilder::with_id("dangling-recovery", "Dangling Commits\u{2026}").build(app)?;
        // .gitignore / .mailmap in-app editors (backlog #14, the FINAL
        // backlog item): view/edit these repo-root text files without
        // leaving GitCat — same dialog-opener "…" convention as the items
        // above it, repo-scoped like Reflog/Rerere/Dangling Commits (not
        // repo-independent like Repositories/External Tools).
        let repo_files = MenuItemBuilder::with_id("repo-files", "Repo Files (.gitignore / .mailmap)\u{2026}").build(app)?;
        // Immediate-action items (no dialog, no ellipsis) — same convention
        // as Repository's Fetch/Pull/Push above. A separator sets them apart
        // from the dialog-openers above them.
        let pull_merge = MenuItemBuilder::with_id("pull-merge", "Pull (Merge)").build(app)?;
        let pull_rebase = MenuItemBuilder::with_id("pull-rebase", "Pull (Rebase)").build(app)?;
        // Opens a real OS terminal at the repo's root (see terminal.rs's own
        // module doc) — an immediate action like Pull above, not a dialog,
        // so no "…" ellipsis. Ranked below the two Pull variants but above
        // Force Push, matching this menu's increasing-order-of-risk ordering
        // (opening a terminal is safe; the items below it are not).
        let open_terminal = MenuItemBuilder::with_id("open-terminal", "Open Terminal").build(app)?;
        // Force push: TWO separate items (never one item + a checkbox) so a
        // user can never reach the destructive raw-force action by
        // fat-fingering the safer lease flow — see git_remote.rs's
        // `force_push` doc comment and forcepush.svelte.ts.
        let force_push_lease = MenuItemBuilder::with_id("force-push-lease", "Force Push (Safe)").build(app)?;
        let force_push_override =
            MenuItemBuilder::with_id("force-push-override", "Force Push (Override Remote)").build(app)?;
        // git-filter-repo: the one genuinely irreversible-by-normal-Undo
        // operation in the app (rewrites every commit hash in scope, expires
        // the reflog) — used to live as its own permanent red topbar button
        // instead of here, the ONE feature that wasn't reachable from Tools/
        // ⌘K like everything else above. Its own dedicated multi-step wizard
        // (scope/preview/typed-confirm/run, plus restore-from-backup) already
        // gates the actual danger, so this is just a menu entry like any
        // other dialog-opener — but its own trailing separator, after even
        // the force-push items, keeps it visually last/most-severe.
        let filter_repo = MenuItemBuilder::with_id("filter-repo", "Rewrite History (filter-repo)\u{2026}").build(app)?;
        SubmenuBuilder::new(app, "Tools")
            .item(&bisect)
            .item(&reflog)
            .item(&rerere)
            .item(&plumbing)
            .item(&remotes)
            .item(&export_patches)
            .item(&apply_patch)
            .item(&pickaxe_search)
            .item(&repositories)
            .item(&external_tools)
            .item(&settings)
            .item(&dangling_recovery)
            .item(&repo_files)
            .separator()
            .item(&pull_merge)
            .item(&pull_rebase)
            .item(&open_terminal)
            .separator()
            .item(&force_push_lease)
            .item(&force_push_override)
            .separator()
            .item(&filter_repo)
            .build()?
    };

    let window_menu = SubmenuBuilder::new(app, "Window").minimize().build()?;

    let help_menu = {
        let github = MenuItemBuilder::with_id("open-github", "GitCat on GitHub").build(app)?;
        let issue = MenuItemBuilder::with_id("report-issue", "Report an Issue\u{2026}").build(app)?;
        // Opens the SAME in-app About panel the update check/install UI lives
        // in (see src/islands/about/About.svelte + src/islands/updater) —
        // this item just also kicks off a check as soon as it opens, see
        // src/main.ts's "check-for-updates" case.
        let check_updates = MenuItemBuilder::with_id("check-for-updates", "Check for Updates\u{2026}").build(app)?;
        let b = SubmenuBuilder::new(app, "Help").item(&github).item(&issue).separator().item(&check_updates);
        // macOS already surfaces About in the app menu above; Windows/Linux
        // have no app menu, so Help is the conventional home for it there.
        #[cfg(not(target_os = "macos"))]
        let b = b.separator().item(&about_item);
        b.build()?
    };

    let builder = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    let builder = builder.item(&app_menu);
    builder
        .item(&file_menu)
        .item(&repo_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&tools_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()
}

pub fn handle_event(app: &AppHandle<Wry>, event: MenuEvent) {
    match event.id().as_ref() {
        "open-github" => {
            let _ = app.opener().open_url(REPO_URL, None::<&str>);
        }
        "report-issue" => {
            let _ = app.opener().open_url(ISSUES_URL, None::<&str>);
        }
        // Everything else is a frontend (Svelte controller / legacy chrome)
        // action — forward the id as a JS event rather than duplicating that
        // logic in Rust.
        id @ ("open-repo" | "close-repo" | "new-branch" | "toggle-theme" | "cmdk" | "fetch" | "pull" | "push" | "about"
        | "bisect" | "reflog" | "rerere" | "plumbing" | "remotes" | "export-patches" | "apply-patch" | "pickaxe-search"
        | "repositories" | "external-tools" | "settings" | "dangling-recovery" | "repo-files" | "pull-merge" | "pull-rebase"
        | "open-terminal" | "force-push-lease" | "force-push-override" | "filter-repo" | "check-for-updates") => {
            let _ = app.emit("menu-action", id);
        }
        _ => {}
    }
}
