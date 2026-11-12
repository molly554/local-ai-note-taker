# Build and run Lynote NoteTaker locally

## You need

- Node.js 24 and pnpm 10.7.0
- CMake
- **Mac:** Xcode Command Line Tools
- **Windows:** Rust, the Vulkan SDK, Visual Studio C++ Build Tools
- **Linux:** Rust, the Vulkan SDK, `libpulse-dev`, `pkg-config`

## Run it

```sh
git clone https://github.com/molly554/local-ai-note-taker.git
cd local-ai-note-taker
pnpm install --frozen-lockfile
pnpm -C app native   # builds the audio, system and transcription helpers (first time, and after they change)
pnpm dev             # opens the app from source
```

The first run downloads the AI models, like the installed app.

- **Separate profile:** `YOGURT_USER_DATA=/tmp/notetaker-dev pnpm dev` keeps your real meetings out of it.
- **Without models:** `YOGURT_FAKE=1 pnpm dev` swaps in a stand-in transcriber, notes model and call audio, so the whole app runs in seconds. It needs none of Rust, CMake or the Vulkan SDK: `pnpm install`, then `pnpm -C app exec electron-vite build` and `YOGURT_FAKE=1 YOGURT_USER_DATA=/tmp/notetaker-demo pnpm -C app exec electron out/main/index.js`.

The switches and the helper programs (`yogurt-audio`, `yogurt-system`, `yogurt-mcp`) keep the names they have in Yogurt, the app this is a fork of, so its changes stay easy to bring over.

## Test

```sh
pnpm -C app typecheck
pnpm -C app test   # unit tests
pnpm -C app e2e    # builds, then drives the app with Playwright in fake mode
```

## Measure

`bench/` holds the checks behind the numbers in the README, with their results: [real meetings](../bench/real-meetings/README.md) (455 public meeting transcripts through the notes pipeline, with the app's own tokenizers) and [the search index that was tried and dropped](../bench/cjk-search/README.md). Each README starts with the commands to run it again.

## Build an installer

```sh
pnpm -C app build
pnpm -C app exec electron-builder --win   # or --linux, --mac, on that platform
```

Installers land in `app/dist/`. They're unsigned unless signing is set up; see `app/scripts/release-mac.sh` for the Mac.

## Release

`sh app/scripts/release.sh X.Y.Z` sets the version, tags it and pushes. GitHub Actions builds Windows and Linux, and publishes one release once they pass. Installed copies update from it.

The Mac is only released signed and notarized. With the secrets `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` set in the repository, the same tag builds and adds it; without them the release carries Windows and Linux only.
