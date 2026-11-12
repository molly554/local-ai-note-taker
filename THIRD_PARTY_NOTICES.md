# Third-party notices

Yogurt is MIT licensed (see [LICENSE](LICENSE)). It includes or uses third-party software under its own licences.

- Licence texts for bundled and statically linked code are in [app/resources/licenses](app/resources/licenses). Installers ship them in a `licenses` folder.
  - Fonts: Bricolage Grotesque (OFL).
  - UI: Base UI, Motion, Hugeicons, and `@animate-ui/react` (MIT + Commons Clause, not covered by Yogurt's MIT licence).
  - Speech: whisper.cpp / ggml, Silero VAD, cpp-httplib, nlohmann/json.
  - Audio recorders: libopus and the `ogg` crate (BSD-3-Clause).
  - Windows and Linux: the NVIDIA CUDA runtime inside node-llama-cpp's CUDA backends, and the web2 word list.
- The app's JavaScript dependencies are listed in `LICENSES.txt`, generated at build time next to the renderer bundle (`out/renderer`) and the main-process bundle (`out/main`).

## Models

Yogurt doesn't ship any models in this repo or the installers. It downloads them from their publishers' Hugging Face pages, and each keeps its own terms:

- Gemma 4 (E2B, E4B, 26B A4B), Qwen3 1.7B and gpt-oss (20B, 120B): Apache-2.0.
- Whisper (speech to text) and Silero VAD (voice detection): MIT.
- EmbeddingGemma 300M: provided under and subject to the [Gemma Terms of Use](https://ai.google.dev/gemma/terms).

