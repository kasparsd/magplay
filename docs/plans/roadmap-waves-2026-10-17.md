# Roadmap waves (2026-10-17)

Coordination plan for the next set of [roadmap](../roadmap.md) work, approved by the owner on 2026-10-17. Each piece runs in its own git worktree and branch and is merged to `main` by the coordinating session, which resolves conflicts. Worktrees are kept after merging.

The Player chrome, theater layout and performance graph (roadmap items 5–6) run in parallel in the "Streaming performance graphs" session. Pieces below don't touch `apps/client/src/player.js` or `public/player.html`, and keep edits to shared files (`apps/client/src/lib/ui.ts`, `public/style.css`, `apps/server/src/sessions.js`) small and additive.

## Wave 1 (parallel)

- [x] **1a. Settings page and status menu**, built from scratch from [the settings plan](settings-and-status-pin.md) on branch `claude/settings-status-b42d44`. The earlier `fix/settings-reliability` branch is not used or referenced. The Player reading its defaults is left to the Player session ([integration notes](settings-and-status-pin.md#player-integration)).
- [ ] **1b. Dependency advisory triage** (roadmap item 2): reachability of the `ip` → `bittorrent-tracker` → `torrent-discovery` → `webtorrent` findings, then a compatible patch or a recorded mitigation.
- [ ] **1c. UI cleanup P2–P4 outside the Player** (roadmap item 7): the open items in [the cleanup todo](../user-interface.md#cleanup-todo), except the ones fixed by the Player roadmap.

## Wave 2

- [ ] **TypeScript Phases 3–4** (roadmap item 3): `indexers`, `torrent-engine` and `playback` packages, factories with `close()`, `main.ts` with graceful shutdown. Starts after 1a and the Player session's `sessions.js` change are on `main`, because it moves those files.

## Wave 3

- [ ] **Boundary/error hardening and long-session behaviour** (roadmap items 8–9), built on the Wave 2 factories.

## Log

- 2026-10-17: plan approved; Wave 1 started.
