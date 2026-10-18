# Roadmap waves (2026-10-17)

Coordination plan for the next set of [roadmap](../roadmap.md) work, approved by the owner on 2026-10-17. Each piece runs in its own git worktree and branch and is merged to `main` by the coordinating session, which resolves conflicts. Worktrees are kept after merging.

The Player chrome, theater layout and performance graph (roadmap items 5–6) run in parallel in the "Streaming performance graphs" session. Pieces below don't touch `apps/client/src/player.js` or `public/player.html`, and keep edits to shared files (`apps/client/src/lib/ui.ts`, `public/style.css`, `apps/server/src/sessions.js`) small and additive.

## Wave 1 (parallel)

- [x] **1a. Settings page and status menu**, built from scratch from [the settings plan](settings-and-status-pin.md) on branch `claude/settings-status-b42d44`. The earlier `fix/settings-reliability` branch is not used or referenced. The Player reading its defaults is left to the Player session ([integration notes](settings-and-status-pin.md#player-integration)).
- [x] **1b. Dependency advisory triage** (roadmap item 2): reachability of the `ip` → `bittorrent-tracker` → `torrent-discovery` → `webtorrent` findings, then a compatible patch or a recorded mitigation. Accepted as unreachable (branch `claude/advisory-triage-3bd1d0`, see the roadmap's verification notes).
- [x] **1c. UI cleanup P2–P4 outside the Player** (roadmap item 7): the open items in [the cleanup todo](../user-interface.md#cleanup-todo), except the ones fixed by the Player roadmap. Branch `claude/ui-cleanup-e16272`; `containerLabel` in `lib/naming.ts` is ready for the Player's ⓘ Details.

## Wave 2

- [x] **TypeScript Phases 3–4** (roadmap item 3): `indexers`, `torrent-engine` and `playback` packages, factories with `close()`, `main.ts` with graceful shutdown. Starts after 1a and the Player session's `sessions.js` change are on `main`, because it moves those files. Branch `claude/ts-phase-3-4-84439f`, merged 2026-10-18.

## Wave 3

- [ ] **Boundary/error hardening and long-session behaviour** (roadmap items 8–9), built on the Wave 2 factories.

## Log

- 2026-10-17: plan approved; Wave 1 started.
- 2026-10-18: Wave 1 merged to main (typecheck, lint, 153 unit and 38 e2e tests pass); Wave 2 started.
- 2026-10-18: settings follow-ups (two top-bar buttons, one stacked page, trimmed to tunable settings) and Wave 2 merged; with both merged, typecheck, lint and the 178 unit, 4 peer and 40 e2e tests pass. Wave 3 started.
