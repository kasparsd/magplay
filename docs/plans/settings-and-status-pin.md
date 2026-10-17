# Settings page and status menu

A status menu at the right of every page's top bar, and a settings page at `/settings`. The menu is one button that shows overall health (green, amber, red, or a hollow ring while unchecked), lists the checks and recent status changes, and links to Settings. The settings page edits what `.env` sets today, holds this browser's preferences, and has a Debug section. Both are driven by small declarative registries (status checks, settings schema) with one generic renderer per control type, so a new check or setting is one entry and no new UI.

Mockup and proposal: [magplay Settings and Status](https://claude.ai/artifact/VGDQJ8ue6DFgcH7Mni2tuB) (clickable: switch between the all good, needs attention, problem and not checked yet states, and walk through each settings section).

Screenshots of the mockup (light theme unless noted):

- Status menu: [all good](settings-and-status-pin/settings-status-menu-ok.png), [needs attention](settings-and-status-pin/settings-status-menu-warn.png) ([dark](settings-and-status-pin/settings-status-menu-warn-dark.png)), [problem](settings-and-status-pin/settings-status-menu-error.png).
- Settings page: [Sources with a failing key](settings-and-status-pin/settings-page-sources.png), [Playback](settings-and-status-pin/settings-page-playback.png), [Connection](settings-and-status-pin/settings-page-connection.png), [Server](settings-and-status-pin/settings-page-server.png), [Server with unsaved changes](settings-and-status-pin/settings-page-server-unsaved.png), [Debug](settings-and-status-pin/settings-page-debug.png), [375 px](settings-and-status-pin/settings-page-mobile.png).

Status: built 2026-10-17 on branch `claude/settings-status-b42d44` (roadmap wave 1a), from scratch on `main`. Everything in the checklist is done except the Player reading its defaults, which belongs to the Player chrome session (see [Player integration](#player-integration)). This replaces the earlier link-only "status pin" draft of this plan; the bandwidth test design below is kept from it.

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

- **Button:** a status dot, a problem count when there are problems, and a gear icon, as one `<button>` with an accessible name that carries the state ("Status: 2 problems. Settings"). At 375 px the count hides and only the dot and gear remain. It replaces nothing: the right side of the top bar is empty today.
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

Sixth page, `/settings`, with `public/settings.html` and `apps/client/src/settings.js` (picked up by the esbuild entry glob; add the page route in `server.js`). The section nav is a side list on desktop and a horizontal scroller at 375 px. The hash selects the section (`/settings#debug`), so status actions deep-link. Each section header says where values are saved ("on the server, applies to everyone" or "in this browser"). Sections with a failing check show a dot in the nav.

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

- [x] `SettingDef` schema and the initial entries in `packages/api-contract/src/settings.ts`, with a `validate(def, value)` used by both sides. Status types and `overallLevel()` are in `status.ts` next to it.
- [x] `config.js` on top of `apps/server/src/settings-store.ts` (`resolve(env, file, readers)`), `<CACHE_DIR>/settings.json` read/atomic write, and a `changed` event. Sources, Explore, limits and timeouts rebuild on change. Unit tests for precedence, locking, masking, atomic saves and restart tracking (`settings-store.test.ts`, `settings-schema.test.ts`, `config.test.js`).
- [x] `GET`/`PATCH /api/settings` and `POST /api/settings/test`, with secret masking and the same-origin write guard (`isSameOrigin` in `http-kit`).
- [x] `status.ts` check registry with TTL cache, the initial checks (`status-checks.js`), the event ring buffer, and `GET /api/status`. Unit tests with fake checks and clocks (`status.test.ts`).
- [x] `GET /api/debug` with a log ring buffer (`logs.ts` copies console output) and redacted diagnostics (Copy diagnostics).
- [x] `GET /api/speedtest` faucet (`speedtest.ts`) and `lib/speedtest.ts`, with unit tests.
- [x] `lib/controls.ts` renderers for every type, with keyboard and accessible names.
- [x] Status button and panel in `lib/status-menu.ts` (built on the shared `menu()`, whose label may now be a node), mounted by `lib/topbar.ts`, which every page script imports. Client-check merging and unread tracking. Checked at 375 px. The Player page gets it once `player.js` imports `lib/topbar.ts`.
- [x] `/settings` page (`public/settings.html`, `apps/client/src/settings.ts`) with sections, hash navigation, the save bar, inline field errors and env-locked rows.
- [ ] Player reads its defaults (subtitle/audio language, speed, autoplay next) from browser settings. Left to the Player chrome session, which owns `player.js`; see [Player integration](#player-integration).
- [x] e2e (`tests/e2e/settings.test.js`): a broken source turns the dot red and its action deep-links to Sources. Saving a live setting applies without a restart. An env-set value is read-only. Cross-origin writes are refused. The speed test runs, and a slow result produces a warning on another page. Browser preferences save at once.
- [x] On ship: updated [user-interface.md](../user-interface.md) (six pages, the top bar's right side, the configuration wording), the README configuration section and API table (UI first, env as override), and [architecture.md](../architecture.md) (settings resolution and the status registry).

## As built

Decisions made while building, where they differ from or add to the design above:

- **Where the file lives.** `settings.json` is in the folder `CACHE_DIR` names at startup (`./data` by default). The Cache folder setting moves torrent and HLS data, not the settings file, so startup never depends on a saved value to find its settings.
- **Restart-only settings** are the web port, torrent port, cache folder, DHT and LSD (WebTorrent's client is created once at startup). `config` keeps their startup values until a restart, and the "Restart needed" check names them. There is no Restart button: exiting only restarts under Docker's restart policy, and would just stop a plain `npm start`.
- **Live settings** apply on next use: limits are functions read per job (`createLimiter(() => config.maxProbes)`), and search and Explore are rebuilt when sources, the search timeout or BitMagnet's address change.
- **List settings** (sources, extra trackers): env items are locked and listed first; items saved in the browser follow. With neither, the schema default is editable (the five default trackers). An empty `EXTRA_TRACKERS` means no env trackers, which differs from unset.
- **Sources** are items `{ id, type, name, url, apiKey, indexer }`; `indexer` is Jackett's indexer or filter, or Prowlarr's comma-separated ids. Every adapter has a cheap `check()` (Torznab `t=caps`, Prowlarr `/api/v1/health`, BitMagnet GraphQL `{ __typename }`). Secrets go out as `{ set }`; the browser sends `{ set: true }` back to keep one, matched by item id.
- **Volume and mute** are browser settings marked `hidden`: stored and validated, not shown on the page.
- **Units.** GB settings are binary gigabytes (1024³), as before, and the page's readouts use the same unit.
- **Problem count** on the button counts warnings and errors. Explore without BitMagnet is a warning, as designed, so a setup without BitMagnet shows amber until the address is set.

## Player integration

The Player chrome session owns `apps/client/src/player.js` and `public/player.html`. To finish this feature there:

1. Add `import './lib/topbar.ts'` to `player.js`, which puts the status menu in the Player's top bar.
2. Read defaults from `lib/preferences.ts`: `getPreference(PREFERENCE.subtitleLanguage)` and `PREFERENCE.audioLanguage` (ISO 639-1 codes, empty for off or original), `PREFERENCE.speed` (0.75, 1, 1.25, 1.5), `PREFERENCE.autoplayNext`, and `PREFERENCE.volume` (0–1) and `PREFERENCE.muted`. Write volume and mute back with `setPreference()`, which validates against the schema and returns false for a bad value.
3. Show the playback stats overlay when `getPreference(PREFERENCE.statsOverlay)` is true. "Log requests to the browser console" already works on every page through `lib/topbar.ts`.

All preferences are in one `localStorage` entry, `magplay:settings` (`STORAGE_KEYS.preferences`); the connection test result is `magplay:connection` and the menu's last-seen time is `magplay:status-seen`.

## Open questions

- Should the env-to-UI handover be explicit? An option is an "Import from .env" action that copies env values into `settings.json`, so the user can then remove them from compose. Or env always wins and that's the whole story.
- Is a toast warranted when the overall level gets worse while the user is on a page, or is the dot enough? The proposal is the dot only, plus a one-time `notify()` when the level becomes `error`.
- Do the poll interval (30 s) and the per-source check TTL (60 s) suit Prowlarr instances that rate-limit?
- Should the speed test ever run unprompted (once per browser per week) so the Connection check isn't `unknown` for most users?
- Exact connection thresholds: confirm against real NAS validation numbers (roadmap P1).
