# Cached torrent view — 2026-10-19

Torrent pages previously waited for full engine readiness and unconditionally displayed “Finding peers and the file list,” including while reopening saved metadata and checking cached pieces. Both torrent detail API entry points now use `engine.info()`, which reads ready torrents or saved metadata before falling back to activation. The page says “Loading the file list” while awaiting the response. The lasting behavior is documented in [architecture](../architecture.md).

Validation:

- `npm test`: 238 tests passed. Regression coverage compares active and restarted file lists, reads cached bytes after restart, preserves original multi-file indices through episode sorting, reads metadata with no data/peers/free initialization slots, and checks uncached loading and content warnings.
- `npx playwright test tests/e2e/pages.test.js tests/e2e/magnet-search.test.js tests/e2e/playback.test.js --output=/private/tmp/magplay-cached-torrent-browser-results`: 27 tests passed, covering cached listing/reload without activation, magnet navigation, direct playback, HLS, seeking, resume and playback cleanup. The first run passed 26 tests but failed during browser cleanup because a shared Playwright trace file disappeared; the isolated output run passed all 27.
- `npm run typecheck`, `npm run lint`, `npm run changeset:check` and `git diff --check` passed.
- Added patch release note `.changeset/thin-stars-battle.md`.
