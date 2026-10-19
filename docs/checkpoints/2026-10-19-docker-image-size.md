# Image size — 2026-10-19

linux/arm64, Docker 29.9.1, branch `feat/lite-playback`. Unpacked is the sum of layer sizes (`docker history`). Pull is the compressed content size. Docker 29's image size adds those two together, so it overstates every image by its pull size.

## Before

| Image | Unpacked | Pull |
| --- | --- | --- |
| `magplay-core` | 274 MB | 88 MB |
| `magplay` | 383 MB | 136 MB |

Almost all of it was the base, not the app. The `node:24-alpine` layer was an unstripped Node binary (128 MB, 109 MB stripped) plus npm, yarn and headers (31 MB). Alpine's `ffmpeg` package added 109 MB, most of it libraries the server never calls (x265, AV1 encoders, Vulkan, X11, PulseAudio). Production `node_modules` was 79 MB, of which about 25 MB is what Node loads: `node-datachannel`'s prebuild ships debug info (20 MB, 6 MB stripped), Mediabunny publishes several builds of each module, and prebuilds for other platforms and the Bare runtime are never loaded. The client source maps are 13 MB and the server does serve them.

## After

The runtime stage is Alpine 3.24's `nodejs` (v24.18.1 here) and the dependency stage strips and prunes as described in [architecture](../architecture.md#build-and-tooling). Same machine:

| Image | Unpacked | Pull |
| --- | --- | --- |
| `magplay-core` | 123 MB | 40.5 MB |
| `magplay` | 231 MB | 88 MB |

`magplay-core` answered `/health` and `/`. Inside it, `packages/playback/src/probe.test.ts` and `node-remux.test.ts` passed (9 tests, including the AC-3 to AAC remux). `magplay` reported ffmpeg 8.1.2 on `/api/status`.

ffmpeg stays Alpine's package. Client source maps stay. Bundling the server into one file would drop a little more and belongs with [desktop packaging](../plans/desktop-packaging.md), which needs the same explicit resource paths.
