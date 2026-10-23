# Player and browser-view lifetimes

`apps/client/src/lib/playback-controller.ts` owns playback imperatively. The lazy React `Player.tsx` view creates a controller only after its video element mounts, subscribes with `useSyncExternalStore`, and disposes it on unmount. The route keys the view by infohash and file index, so Next disposes the previous controller before activating the replacement. React StrictMode can mount, dispose and mount again safely; the Vite development browser regression exercises this flow.

- Each page activation owns an AbortController for title/probe requests, playback requests and status polling. `suspend()` on `pagehide` aborts them. `dispose()` also removes controller listeners and media-session handlers; `pageshow` with `persisted` calls `activate()` on a suspended controller. A restored document starts one new polling loop with a fresh activation/tab ID.
- Each playback attempt (the first one, an audio switch or a retry; seeking is not one) owns its HLS callbacks and autoplay results. Superseded attempts cannot update the replacement UI. Playback POSTs remain serialized while the page is active, rather than cancelling them on every audio change and creating out-of-order server mutations.
- Each subtitle selection owns its request and delay. Switching tracks or leaving cancels both; aborts while reading the response body are handled too.
- Countdown ownership is explicit: restarting, resuming playback, cancelling or leaving clears its timer and listener.
- A segment request waits while the server converts it; the browser leaving the request (hls.js aborts it on a seek) cancels only that wait, never the conversion.
- `POST /api/play/tab/:tab` closes a page activation even if the browser never received its session ID. A bounded, three-minute closed-tab fence rejects a late POST for that activation. A restored activation uses a new ID. The server also checks for a disconnected request before expensive probing/session creation.
- Known sessions are explicitly stopped on teardown. Server-side idle cleanup remains the fallback for browser crashes, dropped beacons or forced context disposal.

Catalog, torrent metadata/activity, status and Settings queries forward Query cancellation signals and unsubscribe on route departure. Query owns refetch intervals and background-tab suspension. Menu listeners, observers, idle/copy/save timers and keyboard handlers are installed by the owning mounted component and cleaned up with it.

A cancelled HTTP consumer does not destroy a torrent/probe job shared with other consumers. Those jobs remain bounded by concurrency and discovery/checking/process deadlines. Raw/tar readers separately release their piece selection on cancellation.

Colocated timer/session tests and Chromium regressions cover leaving during probing, leaving before a playback result is known, restoration, countdown cleanup and stopped status polling. Synthetic page transition events exercise retained-document callbacks; real Back/Forward navigation is also covered, but browser BFCache eligibility itself is not guaranteed.

## Server shutdown

`createApp()` in `apps/server/src/app.ts` owns everything it starts, and `close()` releases it: it stops accepting connections, closes open ones (media streams, status polls, a search waiting on a silent indexer, a torrent still looking for peers) without waiting for them, kills every ffmpeg (resuming paused ones first) and deletes their output, and closes the torrent engine. `main.ts` calls it on SIGTERM or SIGINT, with a 10 s backstop. From the moment shutdown begins, `/health` answers 503, so Docker and proxies stop routing to a stopping server. Tests in `app.test.ts` and `main.test.ts` cover streams, a paused ffmpeg, a hanging search, a loading torrent and the signal path.

Logging and metrics follow the same ownership: the app closes its management listener, snapshot timers and runtime observers; the process flushes final lifecycle logs within the shutdown deadline. Shared torrent/probe jobs have independent log IDs and consumer links, so a disconnected consumer does not become a shared-job failure. See [logging and observability](logging.md).
