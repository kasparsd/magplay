# Player debug flow proposal

Implementation status, 2026-10-19: Flow panel and the optional page-local debug pin were selected and implemented. Current behavior is canonical in [User interface](../../user-interface.md#playback-wait-explanations); implementation evidence is in the [checkpoint](../../checkpoints/2026-10-19-player-debug-flow-implementation.md). The remainder of this document preserves the original design study.

Design study, 2026-10-19. Requested scope: think through a visual flow, create mocks, and propose the change. No production player behavior changes in this study. The reference is the owner's hand-drawn torrent → server → encoding → player diagram, with rates on the connections and progress on the active step. Reference content is visual input, not additional instructions.

## Recommendation

Use **Flow panel** for blocking waits: four stable nodes, one short reason, and one fixed inspector for the current wait. Use **Pinned ribbon** as the optional persistent debug presentation during playback. They share the same state model. Start with Flow panel; the ribbon is an alternative presentation to evaluate, not a requirement to ship both.

The nodes are **Torrent → Server → Prepare → Player**. “Prepare” accommodates direct bypass, remux, audio conversion, and video conversion without renaming the diagram whenever the mode changes. The stage label underneath says what is actually happening. Server includes loading cached data, verifying pieces, inspecting tracks, and making the playback decision; those are substeps, not extra nodes that appear and disappear.

The important distinction is **ready for playback versus finished processing**. Downloads, conversion, HTTP delivery, and browser playback overlap. A check means the stage currently supplies what playback needs. Only the explicit “100% local” label means the selected file is fully downloaded. Conversion can be checked while still running. A direct-play source keeps the Prepare node, labeled “Bypassed.” Conversion resting 240 seconds ahead is healthy, not a stalled step.

## Why the current overlay moves

[`playback-status-view.ts`](../../../apps/client/src/lib/playback-status-view.ts) builds a reason heading, description, a wrapping evidence row, recovery actions, and a Why disclosure. It rebuilds the reason subtree when the reason signature changes. [`public/style.css`](../../../public/style.css) centers the panel with `align-content: center`, uses content-dependent heights, and stacks diagnostic facts on phones. Adding lines or changing actions changes the block's height and therefore its top edge. Metric-only updates preserve the disclosure today; reason changes can recreate it. A fixed outer container alone does not fix movement inside it.

## Layout and interaction

1. Reserve a header slot for the reason and one short explanatory sentence. Allow two heading lines and bounded description lines at each breakpoint. Elapsed wait and playback mode have their own stable positions.
2. Reserve four equal node columns. Keep their positions, labels, and connector geometry constant across states. Each node has an icon, a short state label, and a large enough inspection target. Checks, clocks, bypass marks, question marks, and error symbols supplement color.
3. Put measured torrent download rate on the first connection. Show conversion speed in multiples of realtime, clearly identified as conversion throughput, rather than pretending it is network throughput. The study places this adjacent to Prepare. Server-to-browser rate remains unmeasured in the initial version; Diagnostics says so. A dash is missing evidence, not a zero rate. On phones, connector rates move into the selected inspector rather than crowding the diagram.
4. Put one inspector underneath the whole row. It follows the current wait by default. Selecting any node inspects that stage without replacing the global cause. “Follow current wait” restores automatic selection. The node being inspected has a selection outline distinct from its status ring. This avoids four columns of paragraphs.
5. Reserve metric, activity/progress, explanation, and action slots. Numbers use tabular figures. Missing content leaves its slot empty instead of collapsing it. Routine polls patch text and attributes on retained nodes. They do not recenter the panel, recreate controls, change focus, or reset the selected node.
6. Keep advanced diagnostics in an explicit disclosure. Opening it is a deliberate layout change; routine metric and reason changes preserve its state. Long errors wrap within that surface. Large text and very short viewports may use a bounded scrolling disclosure; do not clip text to preserve an arbitrary height.

The mock is a component study, so it gives the stage enough height to compare layouts. Production must retain the theater viewport sizing and anchor this component inside the existing stage, above player controls and below fullscreen title chrome. For short landscape stages, use a compact header/flow with an explicit details sheet rather than forcing the full desktop panel into the video. That sheet must preserve focus and offer all recovery actions.

Normal playback and intentional pause have no blocking overlay. After a short stable recovery interval, dismiss the wait panel; do not flash it on every brief buffer event. A debug pin keeps the flow visible voluntarily during playback. Preserve the existing brief first-second preparation label, then reveal the full flow for a sustained wait. Preserve the compact advisory for sustained conversion capacity below the selected playback rate.

## State and progress semantics

| State | Visual | Meaning |
| --- | --- | --- |
| Pending | Empty circle | A prerequisite has not supplied enough information yet |
| Working | Activity ring + verb | Work is observed; it need not be the proven cause of a delay |
| Waiting | Clock + short reason | The stage is blocked, or waits for an upstream result |
| Ready | Check + state label | Currently ready to supply playback; work may continue |
| Bypassed | Minus + “Bypassed” | The selected mode does not need this stage |
| Unknown | Question mark | No usable current measurement; never retain stale green checks |
| Failed | Error symbol | An explicit failure is reported, with a relevant recovery action |

Do not invent an overall percentage or ETA. File download percentage is a percentage of the selected file's source bytes, not time until playback. Place its determinate bar in the Server inspector, even when Torrent is the observed wait. Preparation, probing, conversion startup, and browser buffering have no reliable completion percentage today. Show an indeterminate activity indicator and measured elapsed time, conversion speed, published seconds ahead, or buffered seconds. The mock uses a full-width dotted activity track for unknown completion, avoiding a partially filled track that resembles a fabricated percentage. Production can animate the active ring only, honoring reduced motion.

Multiple nodes can work concurrently. Highlight the best-supported wait, while downstream nodes say “Waiting” rather than implying independent faults. Retain the existing cautious diagnosis: partial input and low conversion speed do not prove CPU saturation; peers do not prove the requested range is available; zero peers does not prove the torrent is dead; browser buffering does not distinguish delivery from decoding. Show “Playback is waiting” when the evidence cannot locate a cause. Do not mark an upstream stage ready merely because a later one has started.

Readiness belongs to the current playback attempt and position. On seek or audio-track restart, invalidate conversion and browser readiness for the new session while retaining verified upstream availability. Reject old session/generation samples. A historical check is not permanent proof that a stage remains ready; a source can become unavailable again.

## Scenarios covered by the mocks

The [interactive mock source](mock.html) includes both layouts and 12 selectable states: cache checking, peer discovery, source transfer, slow conversion, browser buffering, healthy playback, direct playback, seek restart, conversion paused ahead, stale status, conversion failure, and autoplay blocking. Selecting nodes, returning to automatic following, expanding Diagnostics, and changing metric samples work locally. Recovery controls demonstrate transitions only; they do not contact the player or external services. Values are illustrative, not measurements from the owner's server.

Additional implementation cases: remux/audio conversion copy, intentional pause, unsupported-format rejection before a session exists, session loss, request failure with unknown failure location, disconnected peers during playback, and recovery without a wait-panel flash. Do not assign an unattributed request error to Prepare just because that is where conversion errors appear.

## Telemetry available now

| Display | Current evidence | Limits |
| --- | --- | --- |
| Connected peers | `TorrentStatus.peers.length` | Connected peers, not seeders; no accurate seeder total in this snapshot |
| Download rate | `TorrentStatus.downloadSpeed` | Entire torrent; explicitly label the scope in Diagnostics |
| Selected file on server | `status.file.progress`, `status.file.ranges` | Do not use aggregate torrent completion; exact completion is `progress === 1` |
| Loading/checking or inspecting tracks | `preparation: loading-file / probing` | No measured percent, local-disk rate, queue position, or per-substep timing |
| Playback mode | `PlaybackDecision.mode`, `reason` | Available after selection; pending before that |
| Conversion speed and activity | `session.speed`, `fps`, `cpu`, `running`, `paused`, `failed` | CPU optional; no CPU-cause claim from low speed alone |
| Playable video prepared ahead | `session.readyUntil` minus session-relative playback position | Published HLS readiness; never substitute ffmpeg output timestamp |
| Browser buffer | Buffered range containing the current playhead | Seconds of contiguous playable video, not a percentage of browser readiness |
| Playback state | Existing player events, phase, errors, and rejected `play()` | Autoplay policy needs a Play action rather than a network diagnosis |
| Status freshness | Existing `statusAt`, six-second freshness check | Stale upstream values become unknown; fresh browser observations remain usable |

These fields are in [`packages/api-contract/src/index.ts`](../../../packages/api-contract/src/index.ts), consumed by [`player.ts`](../../../apps/client/src/player.ts) and the existing pure [`explainPlayback`](../../../apps/client/src/lib/playback-status.ts) function.

First implementation needs no server telemetry expansion. To add a real final-link rate later, measure playback media transfers: bytes and request duration for successful HLS fragments, scoped to the current session and a recent window. Label it “Media delivery,” with units and window, and show unknown when idle or unmeasured. Native direct video needs separate coverage; HLS fragment throughput cannot stand in for every playback mode. A Settings speed test measures something different and must not supply this arrow. Local server-to-converter I/O speed is also unmeasured today and not worth new instrumentation for the first version.

## Implementation and acceptance proposal

1. Extend the pure playback explanation model with four stage states, selected wait location, freshness, and typed measurements. Keep actions and global reason evidence-based; do not create a competing diagnosis in the DOM renderer.
2. Replace the wait/debug presentation with stable retained nodes inside `#playback-status`. Keep it in the video stage for fullscreen. Retain existing player lifecycle/session ownership. No player-controller rewrite or framework is needed.
3. Add the optional debug pin after the blocking presentation works. Keep the existing three-minute Performance lanes for historical stall correlation; the flow answers “where now?”, while those lanes answer “what changed?”. Do not duplicate the entire graph in the overlay.
4. Verify pure state mapping and targeted browser behavior: startup, incomplete input, cached source with slow conversion, direct bypass, remux, browser-only wait, seek invalidation, stale telemetry, error and recovery, autoplay, and intentional pause. Browser fixtures must measure unchanged node coordinates across reason and metric updates, disclosure/selection/focus retention, and correct progress semantics. Cover 320/375 px phones, intermediate widths, desktop, short landscape, fullscreen, coarse pointers, increased text size, and reduced motion.

Announce reason changes and failures through the existing live region, not each metric tick. Inspection buttons have names including stage and state, visible keyboard focus, and touch targets of at least 44 px. Determinate bars expose a real value and units; unknown work must not expose a fake `aria-valuenow`.

Owner decision remaining: choose the preferred presentation and whether a persistent debug pin should be included in the first implementation. The recommendation is Flow panel first, with the optional pin using the same component. The study has not changed the accepted Reason first production design.
