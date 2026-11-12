# Build and run Yogurt locally

## You need

- Node.js 24 and pnpm 10.7.0
- CMake
- **Mac:** Xcode Command Line Tools
- **Windows:** Rust, the Vulkan SDK, Visual Studio C++ Build Tools
- **Linux:** Rust, the Vulkan SDK, `libpulse-dev`, `pkg-config`

## Run it

```sh
git clone https://github.com/FrigadeHQ/yogurt.git
cd yogurt
pnpm install --frozen-lockfile
pnpm -C app native   # builds the audio, system and transcription helpers (first time, and after they change)
pnpm dev             # opens Yogurt from source
```

The first run downloads the AI models, like the installed app.

- **Separate profile:** `YOGURT_USER_DATA=/tmp/yogurt-dev pnpm dev` keeps your real meetings out of it.
- **Without models:** `YOGURT_FAKE=1 pnpm dev` swaps in a fake transcriber, notes model and call audio, so the whole app runs in seconds.

## Test

```sh
pnpm -C app typecheck
pnpm -C app test   # unit tests
pnpm -C app e2e    # builds, then drives the app with Playwright in fake mode
```

## Build an installer

```sh
pnpm -C app build
pnpm -C app exec electron-builder --mac   # or --win, --linux, on that platform
```

Installers land in `app/dist/`. They're unsigned unless signing is set up; see `app/scripts/release-mac.sh` for the Mac.

## Release

`sh app/scripts/release.sh X.Y.Z` sets the version, tags it and pushes. GitHub Actions builds Mac (signed and notarized), Windows and Linux, and publishes one release once all three pass. Installed copies update from it.
