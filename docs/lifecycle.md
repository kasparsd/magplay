# Targeted player lifecycle handling

The player stays imperative in `public/player.js`; no controller/framework migration is required for these fixes.

- Each page activation owns an AbortController for title/probe requests, playback requests and status polling. `pagehide` aborts them. A restored document starts one new polling loop with a fresh activation/tab ID.
- Each playback attempt owns playlist waiting, HLS callbacks and autoplay results. Superseded attempts cannot update the replacement UI. Playback POSTs remain serialized while the page is active, rather than cancelling them on every audio change and creating out-of-order server mutations.
- Each subtitle selection owns its request and delay. Switching tracks or leaving cancels both; aborts while reading the response body are handled too.
- Countdown ownership is explicit: restarting, resuming playback, cancelling or leaving clears its timer and listener.
- `POST /api/play/tab/:tab` closes a page activation even if the browser never received its session ID. A bounded, three-minute closed-tab fence rejects a late POST for that activation. A restored activation uses a new ID. The server also checks for a disconnected request before expensive probing/session creation.
- Known sessions are explicitly stopped on teardown. Server-side idle cleanup remains the fallback for browser crashes, dropped beacons or forced context disposal.

A cancelled HTTP consumer does not destroy a torrent/probe job shared with other consumers. Those jobs remain bounded by concurrency and discovery/checking/process deadlines. Raw/tar readers separately release their piece selection on cancellation.

Colocated timer/session tests and Chromium regressions cover leaving during probing, leaving before a playback result is known, restoration, countdown cleanup and stopped status polling. Synthetic page transition events exercise retained-document callbacks; real Back/Forward navigation is also covered, but browser BFCache eligibility itself is not guaranteed.
