# README restructure for end-user goals

## Goal

Restructure `README.md` so its order and depth follow what an end user is trying
to do, instead of the project's historical prototype narrative. Technical and
contributor material moves out of the main reading path (into `docs/` or an
appendix) without being deleted.

## End-user goals

Primary persona: one person or household on a trusted local network, self-hosting
on a home server / homelab box / desktop. No login, no account state.

1. **Decide** whether magplay fits their setup (what it does, what it needs:
   indexer, ffmpeg, private network, no auth).
2. **Install and run** in a few minutes (Docker Compose, one image).
3. **Connect an indexer** (BitMagnet / Jackett / Prowlarr / any Torznab feed),
   including where to put the URL.
4. **Find and play** a video, in the browser or in an external player, and
   understand why something will not play here.
5. **Troubleshoot** common failures: `.local` names, reverse proxies, VPN,
   cache limits, browser codec limits.
6. **Operate** it over time: cache eviction, metrics, observability, backups of
   settings.

Secondary (contributor/operator) goals, not on the main path:

7. **Integrate** against the HTTP API.
8. **Develop / contribute**: build, test, architecture, release process.

## Problems in the current README

- `## Setup (Docker Compose)` arrives after `## Indexer sources`, `## Using it`,
  and the long `### Playing` / `### Torrent status` sections, so a new user
  reads ~150 lines of feature detail before learning how to run the app.
- The opening architecture diagram and the pointer to `docs/roadmap.md` precede
  any "what is this / should I use it" summary.
- `## HTTP caching and reverse proxies` (a large table) and `## HTTP API`
  (a large table) sit in the middle of the document, between Setup/VPN and
  Configuration, interrupting the install → configure → use flow.
- `## Dependencies` (maintainer table) and the very detailed `## Development`
  section dominate the tail, burying `## Known limits` and
  `## Trying it with Jackett and Prowlarr`.
- End-user troubleshooting (`.local`/avahi, macOS local-network permission) is
  split between Setup and Development.
- There is no single "Getting started" path; goals are scattered.

## Proposed structure (new order)

1. `# magplay` — tagline, screenshots, one-paragraph "what it is".
2. `## What it does` — 5-8 bullets (search indexer, pick torrent, play in
   browser/external player, one Node service, no login, private network).
3. `## Quick start` — minimal Compose snippet + `docker compose up -d` + open
   URL. (moved up)
4. `## First search and playback` — 6-10 lines: search, open torrent, Play,
   external player, Next episode. Link to `docs/user-interface.md` for depth.
5. `## Configuration`
   - `### Indexer sources` — condensed table + 2-3 examples; link to full
     adapter notes.
   - `### Settings page` — short: env vars win, saved to `settings.json`.
   - `### Environment variables` — keep the table, but maybe split into
     "common" vs "advanced" (advanced → `docs/configuration.md` or appendix).
6. `## Playback` — browser modes (direct/remux/transcode/refuse), external
   players, browser compatibility (Firefox/Safari/Chrome), keys. (condensed)
7. `## Known limits` — keep, trimmed.
8. `## Troubleshooting` — `.local`/avahi, reverse proxy buffering, VPN,
   macOS local-network permission, slow trackers.
9. `## Operating` — cache eviction, logs, metrics, observability profile. (new
   grouping of existing content)
10. `## Advanced` — HTTP caching table, reverse-proxy nginx example → move to
    `docs/http-caching.md` (link).
11. `## API reference` → move full table to `docs/api.md` (link); keep 3-line
    summary + link.
12. `## Development` — keep commands, move deep architecture notes to
    `docs/architecture.md` / `docs/development.md`.
13. `## Dependencies` — move to `docs/dependencies.md` or appendix.
14. `## License`

## What moves where (concrete)

- Full `## HTTP API` table → `docs/api.md` (new), README keeps summary + link.
- `## HTTP caching and reverse proxies` table + nginx block → `docs/http-caching.md`
  (new), README keeps one paragraph + link.
- `## Dependencies` table → `docs/dependencies.md` (new) or appendix.
- Deep `## Development` architecture bullets → already covered by
  `docs/architecture.md`; keep only commands + pointers.
- `## Indexer sources` long adapter notes → keep table + examples in README,
  move adapter-authoring paragraph to `docs/architecture.md` or a new
  `docs/indexers.md`.

## Benefits

- Time-to-first-run drops: install instructions in the first screenful.
- Each section maps to one end-user goal; headings become scannable.
- Technical reference preserved but no longer blocks the main path; contributors
  still reach it via links.
- Troubleshooting grouped, easier to find when something breaks.
- Less duplication with `docs/user-interface.md` (which already owns UI
  expectations) by linking instead of restating.

## Implementation plan

- [ ] Create `docs/api.md`, `docs/http-caching.md`, `docs/dependencies.md`
      (move content, keep links back to README).
- [ ] Rewrite README per proposed outline, preserving all facts.
- [ ] Update cross-links in `docs/` that point at README anchors.
- [ ] Add a changeset (`npm run changeset -- --empty` or docs bump).
- [ ] Verify `npm run changeset:check` and link integrity (grep for moved anchors).

## Open questions

- Should the env-var table stay in README or move to `docs/configuration.md`?
  (Recommend keep condensed "common" table in README, full table in docs.)
- Keep screenshots at top or move under "What it does"? (Recommend keep at top.)
