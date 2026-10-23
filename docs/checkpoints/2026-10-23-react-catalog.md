# React catalog validation — 2026-10-23

Phase 4 of [the React client migration](../architecture.md#framework-and-browser-media-triggers), on `codex/react-phase4` from `claude/react-client` at `7eb3531`.

## Automated evidence

- `npm run typecheck`: passed.
- `npm run lint`: passed, zero warnings.
- Node tests: 321 passed.
- Loopback peer integration tests: 4 passed.
- `npm run test:all`: passed; final browser suite 83/83 passed (3.4 minutes).
- Three new catalog browser tests pass: navigation between Explore, Title and Search keeps the document; Back restores cached pagination and filters; Show more deduplicates titles and retries failed pages; type changes clear dependent filters; numeric years and categories keep plain query-string values; late search responses cannot replace a newer query.
- Existing search/torrent return, search history, retry, recent-item removal and pasted-magnet coverage retained.
- Catalog queries forward Query's AbortSignal. Search result and scroll caches and the last-query `sessionStorage` helpers are removed; the remaining `latestRequest` helper is still used by `serialLatest`.

## Visual evidence

Inspected the fixture catalog at 1100×800 and 375×812. Filters wrap within the phone width, tile names and badges remain readable, and the Title header, best-release action and release row retain their layout. These captures use local API fixtures, not live BitMagnet results.

- [Explore desktop](2026-10-23-react-catalog/explore-desktop.png)
- [Explore phone](2026-10-23-react-catalog/explore-phone.png)
- [Title desktop](2026-10-23-react-catalog/title-desktop.png)

## Validation notes

An earlier run missed the HLS resume button once; the final serial full-suite run passed without changing playback code.

The fresh worktree needed its locked dependencies installed and native torrent dependencies rebuilt before server tests could run. The new URL regression caught Router's default JSON quoting of numeric strings; the client now parses and serializes plain URLSearchParams. Torrent, Player and Settings remain on the vanilla bridge for the later phases.
