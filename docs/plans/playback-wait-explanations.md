# Playback wait explanations

## Goal and approved design

Implement the Reason first player mock approved on 2026-10-18: a centered cause, evidence and relevant actions while waiting; progressive Why details; a small capacity warning during playback; no buffering message on an intentional pause. Keep the explanation in the video stage for fullscreen, independent of transient notices.

## Progress

- [x] Validate cached direct/remux playback and controlled slow conversion in the browser.
- [x] Compare centered, timeline-dock and readiness-path mocks; user selected Reason first.
- [x] Add explicit preparation and published-HLS readiness signals.
- [x] Implement evidence-based wait classification and the production overlay.
- [x] Verify delayed startup, recovery, stale data, rate changes, errors and lifecycle behavior.
- [x] Validate responsive/fullscreen behavior in the browser and update canonical UI documentation.

## Diagnostic rules

Use exact file completion, fresh status, published playable segments and browser buffer state. Sustain multiple samples before reporting insufficient conversion capacity, comparing it to the viewer's playback speed. A low ffmpeg speed alone does not prove CPU overload. Partial torrents without peers may be waiting for sources; external playback still needs missing pieces. Ready server output and an empty browser buffer indicate a browser/delivery wait without proving whether the network or decoder is responsible. Display an honest unknown state for stale or inconclusive evidence. Show elapsed waiting time without inventing an ETA or preparation percentage.

One owner renders playback state; errors and resume prompts take priority, and incidental speed/subtitle messages cannot clear playback explanations. Poll while preparing as well as playing, cancel work on pagehide and reset session evidence on seeks/audio changes. Preserve focus and disclosure state during live updates; announce reason changes without announcing each metric/timer tick.

Production checks cover pure classification boundaries, concurrent preparation ownership, published-segment readiness and real cached playback with controlled browser delivery delays. Test healthy play, explicit pause, blocked autoplay, seek/audio restart, recovery, failed/lost sessions, stale status, 1.5x/2x speed, mobile and fullscreen.

## Implementation and evidence

The client derives a single explanation in `lib/playback-status.ts`, renders it through `lib/playback-status-view.ts` and keeps it separate from incidental notices. The server reports reference-counted preparation phases per file and published HLS duration with its existing activity response. File-loading/cache-verification phases take precedence over peer inference because unverified local pieces can temporarily appear incomplete. No new transport or persistent job registry is needed.

Canonical behavior is documented in [user interface](../user-interface.md#playback-wait-explanations). [Validation evidence](../checkpoints/2026-10-18-playback-wait.md) records the automated cases and the implemented slow-conversion screenshot. The original three mock layouts were exploratory inputs; Reason first is the implemented choice.
