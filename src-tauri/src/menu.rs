// Native application menu — the "系统 menu" (system menu).
//
// Two kinds of items:
//  - predefined (Cut/Copy/Paste/Select All, Minimize, Close Window, Quit, and
//    on macOS Services/Hide/Hide Others/Show All): handled entirely by the
//    OS/webview, no event ever reaches Rust. These aren't just decorative —
//    without an Edit menu wiring Cut/Copy/Paste/Select All, those shortcuts
//    don't work at all in a Tauri webview's text inputs.
//  - custom (Open Repository…, New Branch…, Fetch/Pull/Push, Toggle Theme,
//    Command Palette, About, the two Help links): fire a MenuEvent caught in
//    handle_event() below. The two Help links (GitHub / Report an Issue) are
//    handled entirely in Rust via the opener plugin; the rest need the
//    frontend (they're Svelte controller / legacy chrome calls), so they're
//    forwarded as a "menu-action" JS event — see the listener in src/main.ts.
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
        let new_branch = MenuItemBuilder::with_id("new-branch", "New Branch\u{2026}")
            .accelerator("CmdOrCtrl+Shift+N")
            .build(app)?;
        let b = SubmenuBuilder::new(app, "File").item(&open_repo).item(&new_branch).separator().close_window();
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

    let window_menu = SubmenuBuilder::new(app, "Window").minimize().build()?;

    let help_menu = {
        let github = MenuItemBuilder::with_id("open-github", "GitCat on GitHub").build(app)?;
        let issue = MenuItemBuilder::with_id("report-issue", "Report an Issue\u{2026}").build(app)?;
        let b = SubmenuBuilder::new(app, "Help").item(&github).item(&issue);
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
        id @ ("open-repo" | "new-branch" | "toggle-theme" | "cmdk" | "fetch" | "pull" | "push" | "about") => {
            let _ = app.emit("menu-action", id);
        }
        _ => {}
    }
}
