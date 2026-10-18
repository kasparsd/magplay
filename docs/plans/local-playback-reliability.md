# Local playback reliability

## Goal

Deliver the revised local-first roadmap: bounded server work, real peer-failure coverage, targeted lifecycle ownership and useful resume/restart, without making a framework/controller migration a prerequisite.

## Progress

- [x] Commit the accumulated client/cache/test-layout work in verified checkpoints (`6a22187`, `747bec3`).
- [x] Add isolated local Docker media acceptance (`01efc89`).
- [x] Bound media/torrent initialization jobs and HLS disk use with retryable overload (`be0ece3`).
- [x] Exercise loopback transfer, disappearing/returning peers, raw/tar cancellation and metadata retry; fix reproduced stalls/progress and separate checking deadlines (`ad708e4`).
- [x] Cancel inactive-page requests/timers and close unknown server sessions without a controller rewrite (`7fa9d19`).
- [x] Add per-file absolute resume timestamps, explicit restart, completion handling and storage-failure regressions (`9d33199`).
- [x] Validate all suites under Node 22, repeat the final arm64 Docker check, and align the canonical roadmap/architecture guidance.
- [x] Fix HLS seeks clamping to the browser's seekable edge when it lagged ffmpeg progress; cover the restart path with a speed-independent capped-playlist e2e.
- [ ] Run representative acceptance on the actual server and browsers/devices used. Device access has not been provided.
- [ ] Address further discovery/navigation friction when actual use or reproducible tests identify it.

## Canonical behavior and evidence

- [Roadmap](../roadmap.md) and [architecture direction](../architecture.md).
- [Resource safeguards](../resources.md), [lifecycle ownership](../lifecycle.md), [resume rules](../progress.md).
- [Deployment acceptance](../deployment-acceptance.md) and [dated validation evidence](../checkpoints/2026-10-17-local-validation.md).

The feature was already underway when the project guidelines requiring feature plans appeared. This plan captures its handoff state rather than introducing another implementation wave. Unrelated indexer/example/fixture/release-publishing edits in the shared checkout are not owned by this work and must remain outside its commits.
