fn main() {
    // tauri_build::build() only tells cargo to rerun on tauri.conf.json
    // changes, NOT on the icon files it points at — so regenerating icons
    // (e.g. via `tauri icon`) silently leaves the previous build's embedded
    // icon in place until something else happens to trigger a rebuild.
    // Verified empirically: touching icons/icon.icns alone still reports
    // "Fresh gitcat" from `cargo build -v`, while touching tauri.conf.json
    // reports "Compiling gitcat". Watch the whole icons/ directory so any
    // icon regeneration always re-embeds correctly.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
