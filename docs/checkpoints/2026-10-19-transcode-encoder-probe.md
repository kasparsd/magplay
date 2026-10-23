# Transcode encoder probe validation — 2026-10-19

Hardware encoder detection now filters ffmpeg's compiled encoder list through parallel, three-second one-frame probes. VAAPI uses the configured render device and upload filter; NVENC, VideoToolbox and Quick Sync use their encoder-specific command. libx264 is retained without a hardware probe and is the fallback for `auto` or an unavailable configured encoder.

Validation passed:

- `node --test packages/playback/src/*.test.ts` — 27 passed.
- `npm run lint` — passed.
- `npm run typecheck` — passed.
- `npm test` — 266 passed.

No GPU-dependent test, full browser e2e suite or Docker image rebuild was run. Unit tests inject the ffmpeg command runner and cover failed and successful hardware probes, explicit fallback, encoder-list failure, the configured VAAPI device arguments and warning behavior.
