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
        // Manual resync with the repo on disk — the menu-discoverable twin of
        // the topbar's own refreshBtn (see src/main.ts's
        // refreshFromExternalChange), for whenever the live file-watcher
        // (src-tauri/src/watch.rs) might have missed an external change.
        let refresh = MenuItemBuilder::with_id("refresh", "Refresh").build(app)?;
        SubmenuBuilder::new(app, "Repository")
            .item(&fetch)
            .item(&pull)
            .item(&push)
            .separator()
            .item(&refresh)
            .build()?
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
        // The Tools menu grew to ~22 flat items across this app's backlog
        // (#9-#14 plus several later additions) — genuinely too much to scan
        // as one list. Related dialog-openers are grouped into 3 nested
        // submenus below (Search/History/Patches); everything else stays a
        // flat top-level item, same as before. Nesting is purely a menu-
        // STRUCTURE change — every item keeps its own id/label/accelerator
        // unchanged, so handle_event()'s match arm and every frontend
        // reference to these ids (cmdk.svelte.ts, main.ts) need no changes
        // at all; only where an item lives in the tree moved.

        // "Search" ▸ — the two content-search tools (backlog #10 + its own
        // later full-text-code counterpart), a natural, already-documented
        // pair (see code_search.rs's own module doc on how they complement
        // each other). ⌘F/⌘⇧F stay on the individual items, not the submenu
        // itself (a submenu can't carry an accelerator) — same "Find" /
        // "Find in Files" pairing reasoning as before.
        let search_menu = {
            // Search Code: full-text search of the current checkout (or a
            // chosen historical commit's tree) via `git grep` — searches
            // file CONTENT, returns file+line+text (see code_search.rs's own
            // module doc). ⌘F: the near-universal "Find" binding, and this
            // is the closest thing GitCat has to it (no in-app text-search
            // elsewhere in the UI competes for it).
            let code_search = MenuItemBuilder::with_id("code-search", "Search Code\u{2026}")
                .accelerator("CmdOrCtrl+F")
                .build(app)?;
            // Pickaxe / diff-content search (backlog #10): searches the
            // whole history's DIFFS, not just commit messages — complements
            // Search Code above (which searches content, not diffs; see
            // pickaxesearch.svelte.ts's own header doc). ⌘⇧F mirrors the
            // "search across everything" binding several editors already
            // use for a project/history-wide search (e.g. VS Code's/Xcode's
            // own ⌘⇧F "Find in Files"), pairing with Search Code's plain ⌘F.
            let pickaxe_search = MenuItemBuilder::with_id("pickaxe-search", "Search Commit Content\u{2026}")
                .accelerator("CmdOrCtrl+Shift+F")
                .build(app)?;
            SubmenuBuilder::new(app, "Search").item(&code_search).item(&pickaxe_search).build()?
        };

        // "History" ▸ — every read-only investigation/recovery tool over
        // commit history. These 6 used to live in a permanent bottom drawer
        // (the original 4: Bisect/Reflog/Rerere/Plumbing) or as flat Tools
        // entries (Repository Summary, Dangling Commits) added later; all
        // forward through the same menu-action path as everything else in
        // this file, also matched in ⌘K (see cmdk.svelte.ts).
        let history_menu = {
            let bisect = MenuItemBuilder::with_id("bisect", "Bisect\u{2026}").build(app)?;
            let reflog = MenuItemBuilder::with_id("reflog", "Reflog\u{2026}").build(app)?;
            let rerere = MenuItemBuilder::with_id("rerere", "Rerere\u{2026}").build(app)?;
            let plumbing = MenuItemBuilder::with_id("plumbing", "Plumbing\u{2026}").build(app)?;
            // Repository Summary: a git-log-derived diagnostic (churn
            // hotspots, contributor ranking/bus factor, monthly activity,
            // problem areas). Also shown automatically once, the first time
            // a repo is opened (see reposummary.svelte.ts's maybeAutoShow),
            // independent of this menu item, which is just the on-demand
            // entry point.
            let repo_summary = MenuItemBuilder::with_id("repo-summary", "Repository Summary\u{2026}").build(app)?;
            // fsck-based dangling-object recovery (backlog #13): commits
            // `git fsck` finds with no ref/reflog pointing at them anymore
            // (a hard reset, an amend, a dropped rebase commit, a deleted
            // branch, …).
            let dangling_recovery = MenuItemBuilder::with_id("dangling-recovery", "Dangling Commits\u{2026}").build(app)?;
            SubmenuBuilder::new(app, "History")
                .item(&bisect)
                .item(&reflog)
                .item(&rerere)
                .item(&plumbing)
                .item(&repo_summary)
                .item(&dangling_recovery)
                .build()?
        };

        // "Patches" ▸ (backlog #9, format-patch/am) — export/apply, a
        // natural pair. "Export as Patch…" (single-commit) lives on the
        // commit-menu instead (see commitmenu.svelte.ts), not here, since it
        // needs a right-clicked commit as its target; these two are
        // repo-global.
        let patches_menu = {
            let export_patches = MenuItemBuilder::with_id("export-patches", "Export Patches\u{2026}").build(app)?;
            let apply_patch = MenuItemBuilder::with_id("apply-patch", "Apply Patch\u{2026}").build(app)?;
            SubmenuBuilder::new(app, "Patches").item(&export_patches).item(&apply_patch).build()?
        };

        let remotes = MenuItemBuilder::with_id("remotes", "Manage Remotes\u{2026}").build(app)?;
        // Multi-repository dashboard (backlog #11): unlike every other item
        // in this submenu, this one does NOT need a repo open at all — it's
        // the one place to check on OTHER tracked repos without leaving (or
        // needing) whichever repo is currently open.
        let repositories = MenuItemBuilder::with_id("repositories", "Repositories\u{2026}").build(app)?;
        // Pluggable external diff/merge tools (backlog #12): a settings
        // modal, not a per-file action (those live on Detail.svelte/
        // Workdir.svelte's own file rows and Resolver.svelte instead) — same
        // "reachable any time, no repo needed" shape as Repositories just
        // above (see externaltools.svelte.ts's own header doc).
        let external_tools = MenuItemBuilder::with_id("external-tools", "External Tools\u{2026}").build(app)?;
        // App Settings (theme, cherry-pick record-origin default,
        // auto-check-updates toggle, and a Git Identity section scoped to
        // whichever repo is open) — same "reachable any time, no repo
        // needed" shape as Repositories/External Tools just above (see
        // settings.svelte.ts's own header doc). ⌘, is a deliberate exception
        // to this submenu's usual "no accelerators" default — it's the
        // near-universal Preferences/Settings binding on macOS (same "too
        // standard to skip" reasoning as File's own ⌘O), kept here rather
        // than moving the item into the app menu (where macOS convention
        // usually places it) since that's a bigger, unrequested menu-
        // structure change than this binding itself calls for.
        let settings = MenuItemBuilder::with_id("settings", "Settings\u{2026}")
            .accelerator("CmdOrCtrl+,")
            .build(app)?;
        // .gitignore / .mailmap in-app editors (backlog #14, the FINAL
        // backlog item): view/edit these repo-root text files without
        // leaving GitCat — repo-scoped like History's own items above (not
        // repo-independent like Repositories/External Tools just above).
        let repo_files = MenuItemBuilder::with_id("repo-files", "Repo Files (.gitignore / .mailmap)\u{2026}").build(app)?;
        // Immediate-action items (no dialog, no ellipsis) — same convention
        // as Repository's Fetch/Pull/Push above. A separator sets them apart
        // from the dialog-openers/submenus above them.
        //
        // Jumps straight to the pinned "Uncommitted changes" row (equivalent
        // to clicking it directly) and resets scroll — see legacy/main.ts's
        // goToUncommitted() doc comment. First in this group: it's pure
        // navigation with zero side effects, safer than even Pull below it.
        let uncommitted_changes = MenuItemBuilder::with_id("uncommitted-changes", "Uncommitted Changes").build(app)?;
        let pull_merge = MenuItemBuilder::with_id("pull-merge", "Pull (Merge)").build(app)?;
        let pull_rebase = MenuItemBuilder::with_id("pull-rebase", "Pull (Rebase)").build(app)?;
        // Toggles the built-in terminal drawer at the repo's root (a real
        // PTY-backed shell embedded in GitCat's own UI — see terminal.rs's
        // own module doc); an immediate action like Pull above, not a
        // dialog, so no "…" ellipsis. Ranked below the two Pull variants but
        // above Force Push, matching this menu's increasing-order-of-risk
        // ordering (a terminal is safe; the items below it are not).
        // CmdOrCtrl+` mirrors the same shortcut's meaning in every other
        // editor with an integrated terminal (VS Code, JetBrains IDEs, …).
        let open_terminal = MenuItemBuilder::with_id("open-terminal", "Open Terminal").accelerator("CmdOrCtrl+`").build(app)?;
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
            .item(&search_menu)
            .item(&history_menu)
            .item(&patches_menu)
            .item(&remotes)
            .item(&repo_files)
            .separator()
            .item(&repositories)
            .item(&external_tools)
            .item(&settings)
            .separator()
            .item(&uncommitted_changes)
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

    let window_menu = {
        // Multi-window: spawns a genuinely separate OS PROCESS (a fresh
        // invocation of this same executable — see windows.rs's own module
        // doc for why: it must NOT be an additional window inside this
        // already-running process, sharing this process's backend/state),
        // empty hero state — pick a repo from ITS OWN Dashboard/repo-pick
        // button. Handled directly here (see handle_event's own "new-window"
        // arm), not forwarded to the frontend like almost everything else in
        // this file — there's nothing for JS to do here at all.
        // CmdOrCtrl+Shift+N is already File's "New Branch…" — CmdOrCtrl+N is
        // otherwise unused.
        let new_window = MenuItemBuilder::with_id("new-window", "New Window").accelerator("CmdOrCtrl+N").build(app)?;
        SubmenuBuilder::new(app, "Window").item(&new_window).separator().minimize().build()?
    };

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
        // Multi-window: spawns a fresh, fully independent OS process (see
        // windows.rs's own module doc) — handled directly here, not
        // forwarded to the frontend, since there's nothing for JS to do.
        "new-window" => {
            crate::windows::spawn_new_window(None);
        }
        // Everything else is a frontend (Svelte controller / legacy chrome)
        // action — forward the id as a JS event rather than duplicating that
        // logic in Rust.
        id @ ("open-repo" | "close-repo" | "new-branch" | "toggle-theme" | "cmdk" | "fetch" | "pull" | "push" | "refresh" | "about"
        | "bisect" | "reflog" | "rerere" | "plumbing" | "repo-summary" | "remotes" | "export-patches" | "apply-patch"
        | "pickaxe-search" | "code-search" | "repositories" | "external-tools" | "settings" | "dangling-recovery"
        | "repo-files" | "uncommitted-changes" | "pull-merge" | "pull-rebase" | "open-terminal" | "force-push-lease"
        | "force-push-override" | "filter-repo" | "check-for-updates") => {
            let _ = app.emit("menu-action", id);
        }
        _ => {}
    }
}
