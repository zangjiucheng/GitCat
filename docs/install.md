# Install

Download the installer for your platform from the [Releases page](https://github.com/zangjiucheng/GitCat/releases). Every release is built from the same tag across a 6-platform matrix:

| Platform | Architectures | Format |
| --- | --- | --- |
| macOS | Apple Silicon, Intel | `.dmg` |
| Windows | x86_64, arm64 | `.msi` / `.exe` |
| Linux | x86_64, arm64 | `.deb`, `.rpm`, `.AppImage` |

## Unsigned builds

GitCat doesn't have a code-signing certificate configured yet, so your OS will flag the installer as coming from an unidentified developer. That's expected — here's how to get past it:

- **macOS** — right-click the app → **Open** the first time (only needed once). Double-clicking normally will refuse to launch it.
- **Windows** — click **More info** → **Run anyway** on the SmartScreen prompt.
- **Linux** — no OS-level gate, but make sure the `AppImage` is marked executable (`chmod +x`) before running it.

## Building from source

If you'd rather build it yourself (or want to run a development build), see [Development](https://github.com/zangjiucheng/GitCat#development) in the README — you'll need [Rust](https://www.rust-lang.org/tools/install), [Node](https://nodejs.org) 22+, and [pnpm](https://pnpm.io):

```bash
git clone https://github.com/zangjiucheng/GitCat.git
cd GitCat
pnpm install
pnpm tauri dev
```

Want a repo to poke around in instead of pointing GitCat at something real? `pnpm demo` builds one at `~/gitcat-demo` with branches, tags, a submodule, stashes, a diverged remote, an unmerged branch that conflicts with `main` on purpose, and a bisectable bug.
