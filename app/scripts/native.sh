#!/bin/sh
# Builds the Mac helpers (Apple Silicon) into resources/bin: yogurt-mac (calendar, mic apps, names from calls),
# yogurt-audio (recording), yogurt-mcp (AI apps reading meetings) and whisper-server (speech to text, built from a pinned whisper.cpp).
# Skipped off a Mac, or when a helper is newer than its source.
set -e
[ "$(uname)" = "Darwin" ] || exit 0
cd "$(dirname "$0")/.."
mkdir -p resources/bin
for name in yogurt-mac yogurt-audio yogurt-mcp; do
  src=native/$name/main.swift
  plist=native/$name/Info.plist
  out=resources/bin/$name
  if [ -f "$out" ] && [ "$out" -nt "$src" ] && [ "$out" -nt "$plist" ]; then continue; fi
  # the plist is embedded so the system's Calendar, Microphone and audio recording prompts have Yogurt's words.
  # 14.4: Core Audio process taps arrived in 14.2, their permission prompt in 14.4
  xcrun swiftc -O -target arm64-apple-macos14.4 "$src" -o "$out" -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$plist"
  echo "built $out"
done

# whisper-server: whisper.cpp at a pinned commit, Metal on, the Metal shaders embedded so it is one file.
# The clone and build live in native/.whisper-build (gitignored); only the finished program is copied out.
# native/whisper-server.patch is applied on top: with VAD on, a chunk with no speech in it crashed the server.
WHISPER_TAG=v1.9.5
WHISPER_COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037
out=resources/bin/whisper-server
if [ ! -f "$out" ] || [ "$0" -nt "$out" ] || [ native/whisper-server.patch -nt "$out" ]; then
  CMAKE=/opt/homebrew/bin/cmake
  [ -x "$CMAKE" ] || CMAKE=$(command -v cmake) || { echo "cmake is needed to build whisper-server (brew install cmake)" >&2; exit 1; }
  dir=native/.whisper-build
  if [ ! -d "$dir/.git" ]; then
    git clone --quiet https://github.com/ggml-org/whisper.cpp.git "$dir"
  fi
  git -C "$dir" checkout --quiet --force "$WHISPER_COMMIT"
  [ "$(git -C "$dir" rev-parse HEAD)" = "$WHISPER_COMMIT" ] || { echo "whisper.cpp is not at $WHISPER_COMMIT" >&2; exit 1; }
  git -C "$dir" apply "$PWD/native/whisper-server.patch"
  "$CMAKE" -S "$dir" -B "$dir/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DWHISPER_BUILD_TESTS=OFF \
    -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=14.4 >/dev/null
  "$CMAKE" --build "$dir/build" --config Release --target whisper-server -j "$(sysctl -n hw.ncpu)" >/dev/null
  cp "$dir/build/bin/whisper-server" "$out"
  echo "built $out"
fi

# Silero VAD for whisper-server (MIT, ggml-org/whisper-vad at a pinned commit): whisper only reads the stretches with
# speech in them, so a click or a notification on a quiet track is never turned into words. Checked against its sha256.
VAD_URL=https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin
VAD_SHA256=2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987
vad=resources/vad/ggml-silero-v6.2.0.bin
if [ ! -f "$vad" ] || [ "$(shasum -a 256 "$vad" | cut -d' ' -f1)" != "$VAD_SHA256" ]; then
  mkdir -p resources/vad
  curl -sSfL --retry 3 -o "$vad.part" "$VAD_URL"
  [ "$(shasum -a 256 "$vad.part" | cut -d' ' -f1)" = "$VAD_SHA256" ] || { rm -f "$vad.part"; echo "the VAD model's checksum is wrong" >&2; exit 1; }
  mv "$vad.part" "$vad"
  echo "fetched $vad"
fi
