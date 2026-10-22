{
  description = "GitCat dev environment (Tauri v2 + Svelte)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # tauri-runtime-wry links against WebKitGTK/GTK/GLib at build time on
        # Linux (see .github/workflows/*.yml for the apt equivalent); macOS
        # uses the system WebKit instead, so these are Linux-only.
        linuxDeps = with pkgs; [
          webkitgtk_4_1
          gtk3
          glib
          gdk-pixbuf
          librsvg
          libayatana-appindicator
        ];

        # bubblewrap: WebKitGTK's Web (render) process sandboxes itself via
        # bwrap on Linux and silently degrades without it — worth having on
        # PATH so the webview actually runs sandboxed rather than falling
        # back unsandboxed. git: the Rust core shells out to the `git` CLI
        # for writes (see README's Development section); mkShell doesn't
        # purify PATH, so this only matters on machines without an ambient
        # `git`.
        linuxRuntimeOnly = [ pkgs.bubblewrap pkgs.git ];

        darwinDeps = with pkgs.darwin.apple_sdk.frameworks; [
          WebKit
          AppKit
          Security
        ];
      in
      {
        # Only packaged for Linux for now — nix/package.nix links against
        # WebKitGTK/GTK3, which have no macOS nixpkgs equivalent (Tauri uses
        # the system WebKit there instead).
        packages = pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          default = pkgs.callPackage ./nix/package.nix { src = self; };
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            rustc
            cargo
            rustfmt
            clippy
            cmake # libgit2-sys builds libgit2 from source (git2's vendored feature)
            nodejs_22
            pnpm
            cargo-tauri
            pkg-config
          ] ++ lib.optionals stdenv.hostPlatform.isLinux (linuxDeps ++ linuxRuntimeOnly)
            ++ lib.optionals stdenv.hostPlatform.isDarwin darwinDeps;

          # Runtime libs (GTK modules, EGL/GL, gdk-pixbuf loaders, ...) that
          # WebKitGTK dlopen()s instead of linking at build time — without
          # this, `cargo tauri dev` builds fine but the window fails to open.
          LD_LIBRARY_PATH = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux
            (pkgs.lib.makeLibraryPath linuxDeps);

          # GSettings schemas (webkitgtk/gtk3 need these at runtime for e.g.
          # font/proxy settings) and icon themes.
          XDG_DATA_DIRS = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux
            (pkgs.lib.concatStringsSep ":" [
              "${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}"
              "${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}"
            ]);

          shellHook = ''
            export PATH="$PWD/node_modules/.bin:$PATH"

            # tauri-cli's own "is the frontend dev server up yet" readiness
            # check hangs indefinitely on some machines even once Vite is
            # confirmed reachable (curl/browser both succeed) — a known
            # upstream flakiness (tauri-apps/tauri#6413 and similar). Skip it;
            # `beforeDevCommand` already blocks until Vite prints "ready".
            export TAURI_CLI_NO_DEV_SERVER_WAIT=true
          '';
        };
      });
}
