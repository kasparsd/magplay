# Generic torrent download UX — 2026-10-19

Implemented in the isolated `codex/generic-torrent-ux` worktree. The taxonomy plan’s remaining items are delivered: download-only actions/messaging and accurate adult-setting scope. Canonical behavior is in [user interface](../user-interface.md#download-only-torrents); the discovery types/categories from the plan are preserved there too.

## Behavior and implementation

- A single file without video gets a primary Download file action; packs without video get Download all (.tar, size). File names and per-row Download links use the existing raw attachment route. More retains the torrent-client magnet and copy action.
- The page explains that there are no videos and offers downloads/torrent-client handoff without treating audio, books, software or disk images as a failed media lookup. Programs, archives and file lists known to contain no video use neutral download notes in release lists.
- Mixed torrents retain Play/Resume, video/external-player menus, whole-torrent downloads in More and individual downloads in the Other files disclosure. No new playback mode or audio-only browser player was added.
- The adult toggle reads “Show adult content in Explore” and explicitly states that source search results are not filtered. Filtering behavior and defaults are unchanged.
- `torrent.js` becomes `torrent.ts`, typed against API contracts. Owned markup is checked with the new `requireElement(selector, ctor)` helper; stored last-played records are narrowed before use. The existing raw/tar byte source, cached-list behavior and playback lifecycle remain in place.
- New TypeScript browser tests run under a root-referenced e2e project. A minimal declaration describes the existing JavaScript fixture harness, a minimal local declaration covers create-torrent’s fixture API, and parse-torrent’s existing vendor declaration is reused. Other client pages and external harness/tests stay on touch.

## Validation

The initial targeted browser run passed all four new scenarios. They generate original non-media bytes and torrent metadata in the worker’s isolated production-format cache, rather than mocking file-list or download responses. Single-file and individual pack downloads must match the original bytes; the tar must contain each expected name and content. The synthetic `.iso` and `.flac` files test generic byte delivery, not usable disk images or audio decoding. The phone scenario uses a 375 × 812 viewport; a mixed fixture checks the saved 0:25 Resume action and retained download controls. A Settings assertion verifies the exact Explore-only label and help.

- `npm run typecheck`, `npm run lint`, `npm run changeset:check` and `git diff --check` passed.
- `npm run test:all` passed 239 fast tests, four peer runner entries and all 64 Chromium tests for the download UX and TypeScript conversion.
- Visual inspection of the first desktop/phone screenshots exposed the shared formatter rounding tiny nonempty files to 0 MB. The formatter now uses bytes/KB below 1 MB, retaining the existing MB/GB presentation. A boundary regression and a browser assertion cover the correction. After it, `npm test` passed all 240 tests; the affected pages, performance, Settings and download suites passed all 24 Chromium tests. No peer or streaming logic changed in this final refinement.
- Visually reviewed the final [single-file desktop](2026-10-19-generic-torrent-ux/single-file-desktop.png) and [download pack at 375 px](2026-10-19-generic-torrent-ux/download-pack-phone.png) screenshots. Primary actions, file labels, size labels and download links fit; the phone test also asserts no horizontal overflow.
- The patch Changeset describes the user-visible actions, size labels and clarified setting. The completed taxonomy plan was removed after moving its lasting decisions into canonical UI/architecture documentation and its evidence here.

Local checks use Node v26.11.1 and require unsandboxed fixture ports/Chromium startup. Docker was not rerun; this change does not establish new Docker, device or real-server acceptance evidence.
