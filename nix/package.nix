{
  lib,
  rustPlatform,
  cargo-tauri,
  cmake,
  nodejs,
  pnpm,
  fetchPnpmDeps,
  pnpmConfigHook,
  pkg-config,
  glib-networking,
  webkitgtk_4_1,
  wrapGAppsHook3,
  libayatana-appindicator,
  gtk3,
  src,
}:
rustPlatform.buildRustPackage (finalAttrs: {
  pname = "gitcat";
  version = "1.3.0";

  inherit src;

  # No signing key available (or wanted) for a locally built package — Nix
  # itself is the update mechanism here, not tauri-plugin-updater.
  postPatch = ''
    substituteInPlace src-tauri/tauri.conf.json \
      --replace-fail '"createUpdaterArtifacts": true' '"createUpdaterArtifacts": false'
  '';

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    fetcherVersion = 4;
    hash = "sha256-0p8S9vIS594GEPBA8Z37Ksw32ZjG8/Seak9EW18i/Zc=";
  };

  cargoHash = "sha256-W8lJ4VfmNHzvwt86XLWetk5h6ow7+GL9zNuTza3ki9Q=";

  nativeBuildInputs = [
    cargo-tauri.hook
    cmake # libgit2-sys builds libgit2 from source (git2's vendored feature)
    pkg-config
    wrapGAppsHook3
    nodejs
    pnpm
    pnpmConfigHook
  ];

  buildInputs = [
    glib-networking
    gtk3
    libayatana-appindicator
    webkitgtk_4_1
  ];

  cargoRoot = "src-tauri";
  buildAndTestSubdir = finalAttrs.cargoRoot;

  # The Rust integration test suite shells out to a real `git` and includes
  # slow bisect tests (tens of minutes) unsuited to every package build; the
  # frontend/backend are already covered by CI (`pnpm test` + `cargo test`).
  doCheck = false;

  meta = {
    description = "A cozy, safety-first desktop Git client";
    homepage = "https://github.com/zangjiucheng/GitCat";
    license = lib.licenses.gpl3Plus;
    mainProgram = "gitcat";
    platforms = lib.platforms.linux;
  };
})
