# README screenshot refresh validation — 2026-10-19

Refreshed the README screenshots (search, player, settings, status panel) on desktop and phone using the isolated local fixture in `tools/scripts/screenshots.mjs` and a Big Buck Bunny 720p H.264 clip. Updated README image references and captions.

- `npm run build` passed.
- `node tools/scripts/screenshots.mjs path/to/big_buck_bunny_720p_h264.mov` completed and wrote `docs/screenshots/search.png`, `player.png`, `settings.png`, and `status.png`.
- `git diff --check` passed.