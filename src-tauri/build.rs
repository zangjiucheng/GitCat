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
    delay_load_comctl32_on_windows();
    tauri_build::build()
}

/// Let the library's unit-test binary START on Windows.
///
/// It could not. `cargo test --lib` exited with STATUS_ENTRYPOINT_NOT_FOUND
/// (0xC0000139) before the harness ran anything, which took `export_bindings`
/// — the test that regenerates `src/ipc/bindings.ts` — down with it. CI runs
/// the Rust suite on Linux, so nothing caught it.
///
/// Cause: this binary imports `comctl32!TaskDialogIndirect`, which exists only
/// in comctl32 **version 6**. `C:\Windows\System32\comctl32.dll` is v5 and does
/// not export it; v6 lives in a side-by-side assembly the loader binds only for
/// a process whose manifest declares a `Microsoft.Windows.Common-Controls`
/// 6.0.0.0 dependency. `tauri_build` embeds that manifest in the APP binary and
/// nothing embeds it in a test binary.
///
/// Scope, since the shape of this is easy to overstate: exactly TWO binaries in
/// the build carry comctl32 imports — the app and the lib unit-test exe.
/// `dumpbin /DEPENDENTS` over `target/debug/deps/*.exe` shows none of the
/// `tests/*.rs` integration binaries reference comctl32 at all, and a
/// pre-change integration exe still runs. What made the whole command report
/// `0 passed, 0 failed` was the separate compile error in `tests/submodule.rs`
/// (now `cfg(unix)`-gated): one non-compiling target makes `cargo test
/// --no-fail-fast` emit no test results whatsoever.
///
/// The import comes from `tauri-runtime-wry`'s own `dialog/windows.rs`, which
/// is compiled unconditionally on Windows, and from `muda`/`rfd` under the
/// dialog plugin — so it is not something a feature flag can drop.
///
/// ## Why delay-loading rather than embedding the manifest
///
/// There is no way to reach only the test binaries. All three alternatives
/// were measured, so nobody has to repeat them:
///
/// - `cargo:rustc-link-arg-tests` does NOT apply to the lib's own unit-test
///   target — the one that needs it. It covers `tests/*.rs` only. (Measured
///   with `/VERSION:7.7`: the integration exe is stamped, the lib-test exe is
///   not.)
/// - The unscoped `cargo:rustc-link-arg` does reach it, but also reaches the
///   app, where `/MANIFEST:EMBED` collides with the manifest resource
///   tauri-build already generated: `CVT1100: duplicate resource.
///   type:MANIFEST, name:1` then `LNK1123`. `/MANIFESTINPUT` without
///   `/MANIFEST:EMBED` is `LNK1220`, so the pair cannot be split.
/// - A side-by-side `<exe>.manifest` is not something a build script can
///   place: it cannot know the test binary's hashed filename.
///
/// The duplicate — not manifest embedding as such — is what blocks that route.
/// `tauri_build::WindowsAttributes::new_without_app_manifest()` would hand this
/// file ownership of the app manifest and let an unscoped `/MANIFEST:EMBED`
/// cover every target, keeping the app statically bound. That is a real option,
/// deliberately not taken: it makes this build script responsible for a
/// manifest tauri-build generates and evolves, which is a standing maintenance
/// cost for a test-only problem.
///
/// ## What delay-loading costs
///
/// The app still gets v6: its manifest is in force by the time the DLL is
/// actually loaded (verified by launching the built app and reading
/// `Process.Modules` — comctl32 resolves from the WinSxS 6.0 assembly). The
/// tests never call `TaskDialogIndirect`, so the import is never resolved and
/// the process starts.
///
/// The trade is fail-fast for fail-late. If the app's manifest were ever lost
/// — a tauri-build upgrade, a bundler or re-signing step that rewrites
/// resources — the old behaviour was a loader error at startup, before any user
/// data was in play. Now it is an unhandled structured exception
/// (`0xC06D007F`) at the moment a dialog opens. Worth knowing before blaming
/// the dialog code.
fn delay_load_comctl32_on_windows() {
    // TARGET, not HOST: a Windows cross-build from Linux still needs this, and
    // a Linux build hosted on Windows must not get MSVC linker flags. Both
    // shipped Windows targets are `*-pc-windows-msvc` (see release.yml);
    // `*-pc-windows-gnu` is deliberately excluded, since these are MSVC-only
    // flags — a GNU-toolchain Windows build is not something this repo ships,
    // and would need its own answer.
    if !std::env::var("TARGET").unwrap_or_default().contains("windows-msvc") {
        return;
    }
    println!("cargo:rustc-link-arg=/DELAYLOAD:comctl32.dll");
    // Provides __delayLoadHelper2, which the delay-load stubs call. Without it
    // the link fails with LNK2001 on that symbol.
    println!("cargo:rustc-link-arg=delayimp.lib");
    // LNK4199: "/DELAYLOAD:comctl32.dll ignored; no imports found". These flags
    // are unscoped because the target that needs them — the lib's own unittest
    // binary — cannot be addressed on its own (see above), so they also reach
    // targets that never touch comctl32. `examples/bisect_judge.rs`, which
    // links no part of the app, is one. The flag being a no-op there is the
    // intended outcome, not something to report on every build.
    println!("cargo:rustc-link-arg=/IGNORE:4199");
}
