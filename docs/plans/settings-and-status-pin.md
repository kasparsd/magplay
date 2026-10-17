# Settings page and status menu

A status indicator and separate Settings button at the right of every page's top bar, and a settings page at `/settings`. The indicator shows overall health (green, amber, red, or a hollow ring while unchecked), opens the checks and recent status changes, and carries the problem count. The adjacent Settings button opens Settings directly. The settings page edits what `.env` sets today, holds this browser's preferences, and has a Debug section. Both are driven by small declarative registries (status checks, settings schema) with one generic renderer per control type, so a new check or setting is one entry and no new UI.

Mockup and proposal: [magplay Settings and Status](https://claude.ai/artifact/VGDQJ8ue6DFgcH7Mni2tuB) (clickable: switch between the all good, needs attention, problem and not checked yet states, and walk through each settings section).

Screenshots of the mockup (light theme unless noted):

- Status menu: [all good](settings-and-status-pin/settings-status-menu-ok.png), [needs attention](settings-and-status-pin/settings-status-menu-warn.png) ([dark](settings-and-status-pin/settings-status-menu-warn-dark.png)), [problem](settings-and-status-pin/settings-status-menu-error.png).
- Settings page: [Sources with a failing key](settings-and-status-pin/settings-page-sources.png), [Playback](settings-and-status-pin/settings-page-playback.png), [Connection](settings-and-status-pin/settings-page-connection.png), [Server](settings-and-status-pin/settings-page-server.png), [Server with unsaved changes](settings-and-status-pin/settings-page-server-unsaved.png), [Debug](settings-and-status-pin/settings-page-debug.png), [375 px](settings-and-status-pin/settings-page-mobile.png).

Status: initial Settings and Status implementation is in progress as of 2026-10-17. The shared schema, persisted server values, health registry, status indicator, Settings page, browser preferences and connection test are implemented. A 2026-10-17 review found reliability and interaction defects around source credentials, write atomicity, connection-test cancellation, restart/live boundaries and focus preservation; they are being remediated before this work is considered landed. The richer Debug log/resource views, cache-clear action and client-check merge remain follow-up work. This replaces the earlier link-only "status pin" draft of this plan; the bandwidth test design below is kept from it.

## Review remediation — 2026-10-17

- [ ] Make every dependency of the committed server/config/API surface present before committing the feature.
- [x] Send Torznab/Jackett credentials for health checks and source tests, preserve saved secrets by stable source identity, and show test results inline.
- [x] Cancel the speed-test reader/client request and stop the server stream when the response closes.
- [x] Reject malformed or `null` origins as a 403.
- [x] Correct numeric schema bounds, atomic persistence and restart/live setting behaviour.
- [x] Preserve keyboard focus and avoid refetching Debug while editing settings.
- [x] Introduce shared field anatomy for labels, visible descriptions, inline errors and optional `(i) More help` disclosures.
- [x] Add focused unit/browser regression coverage for the reviewed cases.

## Why

- **Configuration is invisible.** Every indexer URL, API key and limit is an env var. A wrong Prowlarr key shows up as "no results", and fixing it means editing compose and restarting the container. The server already knows when a source fails; nothing tells the user.
- **Stalls have an unmeasured link.** [The performance graphs plan](performance-graphs.md) wants every stall traceable to the swarm, the NAS CPU or the browser. The network between the NAS and the device is the fourth link, and nothing measures it today.
- **Player preferences need a home.** [One player chrome](../user-interface.md#1-one-player-chrome-for-every-mode) persists volume, speed and audio/subtitle language in `localStorage`. Users need one place to see and change those defaults.
- **Debugging needs a view.** Today, finding out what the server is doing means reading container logs.

[The user-interface doc](../user-interface.md) says "nothing to configure in the browser" and gives the top bar only the home link, Explore and the search box. This feature deliberately changes both.

## Goals and non-goals

**Goals**

- One always-visible indicator that answers "is anything wrong?" and says what to do about it.
- Every setting that is currently env-only is editable in the browser, with `.env` still taking precedence.
- Adding a setting or a check is one declarative entry. The page, validation, API and status menu pick it up.
- The bandwidth test from the earlier draft, as the Connection section and a client-side check.
- A Debug section with versions, resource use, live sessions, recent logs and copyable diagnostics.

**Non-goals**

- No accounts or per-user server settings. Server settings apply to everyone; browser settings apply to one browser.
- No push notifications, email or webhooks. Notifications are status changes shown in the menu.
- No upload test, and no passive capacity inference (see the speed test notes).
- No editing of `.env` itself: the server never writes env files.

## Design

### Status menu (top bar, right side)

- **Controls:** the status indicator is one accessible control with a dot and problem count ("Status: 2 problems"). The adjacent gear is a separate Settings link, so Settings is one direct activation away while status notifications stay independently available. Both remain visible at 375 px.
- **Levels:** each check is `ok | warn | error | unknown`. The overall level is the worst result. Green appears only when the required checks (indexers, ffmpeg, disk) have run and passed. Until then the dot is a hollow ring, so the menu never claims health it hasn't measured.
- **Panel** (shared `menu()` component, keyboard and Escape as today):
  1. A headline ("All good", "Needs attention", "Something isn't working") with a one-line summary.
  2. **Status:** every check, worst first, each with a short value ("84 ms", "41.8 GB free"). Problems add a plain message and one action link to the field that fixes it (`/settings#sources`, for example).
  3. **Recent:** the last few status changes ("Prowlarr returned 401", "Transcode fell behind playback (0.8×)", "Settings saved: web port 8090"). Unread ones are those newer than a per-browser `lastSeen` timestamp in `localStorage`.
  4. A footer with links to Settings and Debug.
- **Data:** the client polls `GET /api/status` every 30 s while the tab is visible, and on focus. Client-side checks (the connection test, later hls.js `bandwidthEstimate`) merge into the same list.

### Status checks (server)

`apps/server/src/status.js` holds a registry: `registerCheck({ id, label, ttl, required, run })`, where `run()` resolves to `{ level, value?, message?, action? }`. Checks run lazily when `/api/status` is requested and are cached per TTL, so polling never hammers indexers. A check that throws becomes `error` with a plain message.

Initial checks:

- One per source: a cheap request against the source (Torznab caps, Prowlarr `/api/v1/health`). 401/403 becomes "refused the API key".
- Explore: BitMagnet's GraphQL endpoint, or `warn` "Explore needs BitMagnet's address" when it isn't set.
- ffmpeg and ffprobe: present and their versions (run once at startup).
- Disk: free space against `MIN_FREE_GB` and the cache limit. `warn` near the floor.
- Restart needed: raised when a restart-only setting is saved.
- Later: transcode below realtime (from `sessions.js`), cache pressure.

**Events.** When a check's level changes, the server pushes `{ at, checkId, level, message }` onto an in-memory ring buffer (50 entries), along with "Settings saved: …" entries. `/api/status` returns the buffer. It is lost on restart, which is fine for status history.

### Settings schema

One schema in `packages/api-contract/src/settings.ts`, so the server validates with exactly what the client renders:

```ts
type SettingDef = {
  key: string                    // 'cache.maxGb'
  section: 'sources' | 'playback' | 'connection' | 'server' | 'debug'
  scope: 'server' | 'browser'
  type: 'text' | 'url' | 'secret' | 'number' | 'toggle' | 'select' | 'segmented' | 'list' | 'action' | 'readout'
  label: string
  help?: string
  default?: unknown
  env?: string | string[]        // env var(s) that override and lock it
  apply?: 'live' | 'restart'     // server scope only
  // type-specific: unit, min, max, step, options, item (for list), test (for a Test button)
}
```

**Resolution (server scope):** env var, then `data/settings.json`, then the default. A value set by env shows read-only with the variable's name, so compose setups keep working and the page explains why a field is locked. `config.js` becomes `resolve(schema, env, file)` and keeps its current shape for callers, plus a `settings:changed` event. The sources registry, limits and timeouts rebuild on that event. Restart-only keys (`PORT`, `TORRENT_PORT`, `CACHE_DIR`) are saved, and they raise the restart check.

**Browser scope:** saved in `localStorage` under `magplay:settings`, through the existing `load`/`save` helpers in `lib/ui.ts`, and parsed from `unknown` against the same schema. Changes apply immediately, with no save bar.

**Sources** are a `list` setting whose items are `{ type, name, url, apiKey, indexer? }`, replacing the `TORZNAB_URL_2…_9` numbering. When any source env var is set, the env sources show locked, and sources added in the UI are listed after them.

**Secrets** never leave the server. `GET /api/settings` returns `{ set: true }` for them, and the field shows "Saved" with a Replace button. Diagnostics redact them.

### Settings page

Sixth page, `/settings`, with `public/settings.html` and `apps/client/src/settings.js` (picked up by the esbuild entry glob; add the page route in `server.js`). Sources, Playback, Connection, Server and Debug appear as one readable page. There is intentionally no sidebar, hash navigation or in-page jump menu; the shared top bar remains available for future primary navigation. Each section header says where values are saved ("on the server, applies to everyone" or "in this browser").

- **Sources:** one group per source with type, address and API key, a Test button (`POST /api/settings/test` runs the check against unsaved values), and its live status. Also Add source, the BitMagnet address and the search timeout.
- **Playback:** on the server, allow transcoding, transcode resolution and simultaneous conversions. In this browser, preferred subtitles and audio, default speed, and autoplay next.
- **Connection:** the speed test (below).
- **Server:** cache limit with a usage meter, free-space floor, idle torrent timeout, DHT/LSD and trackers, and a "Needs a restart" group (web port, torrent port, cache folder).
- **Debug:** versions and uptime, resource meters (conversions, torrents, probes, HLS cache), a log tail filtered by level (`GET /api/debug`, the last 200 log lines in a ring buffer), and Copy diagnostics (JSON, secrets redacted). In this browser, toggles for a playback stats overlay and console request logging. Also Clear conversion cache, which asks for a second click before it runs.

**Saving server settings:** edits collect in a sticky save bar ("2 unsaved changes · Discard · Save"). `PATCH /api/settings` validates the whole patch and returns field errors, which show inline under the field. Nothing is half-applied.

**Honest states** apply as elsewhere: the page shows loading until `/api/settings` answers, a load error offers a retry, and a section whose settings are all env-locked says so in one line.

### Control renderers

`apps/client/src/lib/controls.ts` has one renderer per `type`, each `(def, value, meta) → HTMLElement` with a change callback. The page itself is a loop over the schema filtered by section. The types:

| Type | Renders as | Used for |
| --- | --- | --- |
| `text`, `url` | input, validated on blur | source name, BitMagnet address, ffmpeg path |
| `secret` | "Saved" + Replace, then a password input | API keys |
| `number` | numeric input with unit, min/max | cache GB, timeouts, limits |
| `toggle` | switch (`role="switch"`) | transcoding, DHT, debug overlays |
| `select`, `segmented` | select, or 2–4 segmented buttons | transcode height, languages, speed |
| `list` | repeatable group of other types | sources, extra trackers |
| `action` | button with inline busy/done/failed | Test, speed test, clear cache, copy diagnostics |
| `readout` | read-only value or meter, optionally live | disk use, sessions, versions |

### API

| Route | Purpose |
| --- | --- |
| `GET /api/status` | `{ level, checks[], events[] }` |
| `GET /api/settings` | resolved server values plus `meta[key] = { source: 'env' \| 'file' \| 'default', env? }` |
| `PATCH /api/settings` | validated partial update, atomic write (temp file + rename), emits `settings:changed` |
| `POST /api/settings/test` | run one setting's test against unsaved values, returns a check result |
| `GET /api/debug` | versions, limits in use, live sessions and torrents, log tail |
| `GET /api/speedtest` | byte faucet for the connection test |

**Write protection:** there is no login, but a web page in the same browser could POST to the NAS. Writes (`PATCH`, `POST /test`, clear cache) require `Sec-Fetch-Site: same-origin` or a matching `Origin`, and reject anything else with 403. This belongs in `http-kit` as a small guard.

### Connection test (from the earlier draft)

**Server:** `GET /api/speedtest` streams one reused 1 MB buffer of random bytes (random content defeats any compressing proxy), honors backpressure, stops on `close`, and caps at about 256 MB. It is chunked, `no-store` and `application/octet-stream`, and it counts against no session limit.

**Client:** `apps/client/src/lib/speedtest.ts` `measureConnection()` takes the median of 5 timed `/health` fetches for latency. For download, it runs one `/api/speedtest` fetch read through `getReader()`, excludes the first ~1 s as warmup, and aborts at ~5 s. It returns `{ at, downBytesPerSec, latencyMs }` and reports in MB/s through the shared `formatSpeed`, the same unit as swarm speed. The result is stored per browser and feeds the `connection` client check: `warn` below 10 MB/s or above 100 ms. It goes `unknown` when it has never run, and drops after 7 days. The test runs only on demand.

## Implementation checklist

- [x] `SettingDef` schema and initial entries in `packages/api-contract`, with `validateSetting()` shared by server and client.
- [x] `config.js` resolves environment, `settings.json` and defaults; it writes atomically, emits changes and rebuilds search/Explore services.
- [x] `GET`/`PATCH /api/settings` and `POST /api/settings/test`, with masked API keys and a same-origin write guard.
- [x] `status.js` TTL-cached registry, initial source/binary/disk/Explore/restart checks, event ring and `GET /api/status`, with fake-clock/cache coverage.
- [ ] Extend `GET /api/debug` from its current redacted runtime snapshot with a log ring, live resource meters and the cache-clear action.
- [x] `GET /api/speedtest` faucet and `lib/speedtest.ts` on-demand connection measurement.
- [x] `lib/controls.ts` renderers for the simple input controls, with accessible labels; sources use the repeatable editor on the Settings page.
- [x] Separate status indicator/panel and direct Settings button in `lib/ui.ts`, shared by every page, with unread event tracking and the 375 px layout.
- [x] `/settings` page with a source editor, sticky save bar, inline field errors and env-locked rows; no sidebar or in-page anchor navigation.
- [x] Player reads audio/subtitle language, playback speed and autoplay-next defaults from browser settings.
- [x] e2e: separate indicator/direct Settings control, readable menu rows, live save/persistence, env lock, no sidebar, cross-origin refusal and generated screenshots.
- [ ] e2e: broken-source error state/action and connection-warning coverage.
- [x] Update [user-interface.md](../user-interface.md), the README configuration section and [architecture.md](../architecture.md).

## Open questions

- Should the env-to-UI handover be explicit? An option is an "Import from .env" action that copies env values into `settings.json`, so the user can then remove them from compose. Or env always wins and that's the whole story.
- Is a toast warranted when the overall level gets worse while the user is on a page, or is the dot enough? The proposal is the dot only, plus a one-time `notify()` when the level becomes `error`.
- Do the poll interval (30 s) and the per-source check TTL (60 s) suit Prowlarr instances that rate-limit?
- Should the speed test ever run unprompted (once per browser per week) so the Connection check isn't `unknown` for most users?
- Exact connection thresholds: confirm against real NAS validation numbers (roadmap P1).
