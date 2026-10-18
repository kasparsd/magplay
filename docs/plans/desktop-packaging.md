# Desktop packaging

Finalized 2026-10-18. Status: backburner; implementation has not started and is not scheduled. Decision: Electron with the existing interface in its own application window, the Node backend in a supervised process, and bundled FFmpeg/ffprobe. [Architecture](../architecture.md#desktop-distribution-direction) owns the architectural decision; [the roadmap](../roadmap.md#backburner) owns priority; this document owns delivery tasks and acceptance criteria. Resume at Phase 1 only when desktop distribution is explicitly prioritized.

Research consolidated 2026-10-18: [WebTorrent Desktop comparison](#webtorrent-desktop-research) and [optional local playback and casting](#optional-local-playback-and-casting) are recorded below in this existing plan. They inform future work without expanding the initial desktop release or changing its backburner status.

## Goal and scope

Ship Magplay as a desktop application for Windows, macOS and Linux. Users launch an installed app without installing Node, npm, Docker or FFmpeg. Reuse the current multi-page interface, Node service, WebTorrent engine and media pipeline. Retain the headless Node/Docker distribution as a separate launch mode of the same backend.

“Standalone” means a self-contained application installation including Electron's Chromium and Node runtimes and the media tools. It does not mean one executable containing every running component. Installers may contain several binaries and resource files. Configured indexers remain external; pasted magnets work without one. Desktop VPN routing uses the user's system VPN; embedded VPN management is outside this work.

Initial release matrix (minimum versions confirmed in Phase 1):

| Platform | CPU | Artifact | Validation target |
| --- | --- | --- | --- |
| Windows | x64 | Installer `.exe` | Windows 11; select an Electron Forge installer maker in Phase 1 |
| macOS | arm64 and x64, separate builds | `.app` in `.dmg` | Select minimum OS after checking the pinned Electron and native dependency requirements |
| Linux | x64 | `.AppImage` and `.deb` | Ubuntu 24.04 LTS first; select the oldest build baseline supported by every bundled dependency |

Windows/Linux arm64, universal macOS binaries, stores, automatic updates, tray/background mode, autostart and OS magnet associations are followups. The first release exits when its main window closes and focuses the existing window on a second launch. Native process containment must also handle an unexpected shell crash.

## Why Electron

Electron is the selected desktop shell. It provides a bundled Chromium engine across platforms, fits the existing TypeScript/Node stack and has a directly comparable shipped application in WebTorrent Desktop. Prefer predictable playback and established desktop tooling over minimizing the shell's size. Codec and hardware-decoding support still require tests on each OS; a common Chromium version does not guarantee identical codec support.

| Option | Fit for this application |
| --- | --- |
| Electron | Selected: bundled Chromium, TypeScript shell and supervised Node backend; accept larger distribution and responsibility for runtime updates |
| Tauri 2 | Considered: smaller shell, but adds Rust plus system webview and Linux GStreamer variability while still needing Node |
| Native launcher opening the default browser | Considered: simplest UI shell, but the chosen product is a dedicated application window; retain an optional Open in browser action |
| Wails | Considered: introduces a Go shell plus system webview differences without a demonstrated advantage here |

Use Electron Forge for packaging, native module rebuild integration and per-platform makers. Measure actual download size, installed size and idle memory. Server FFmpeg/ffprobe remain separate executables: Electron's internal media libraries do not replace the existing probe/remux/transcode commands. Manual full-installer updates are the initial release policy; continue shipping supported Electron versions for runtime security fixes.

## Architecture and implementation decisions

```text
Electron main process (apps/desktop)
  ├─ starts the desktop backend in an Electron Node utility process
  │    ├─ serves public/ + dist/client/ on 127.0.0.1:<assigned port>
  │    ├─ owns indexers, torrent discovery, settings and cache
  │    └─ starts bundled ffprobe/ffmpeg using absolute paths
  └─ opens the existing UI in a sandboxed BrowserWindow after readiness
```

- Add `apps/desktop/` for Electron main/preload TypeScript, Forge configuration, icons and packaging metadata. Put artifact assembly helpers in `tools/scripts/`. Generated runtimes and staging directories remain gitignored.
- Use Electron's `utilityProcess.fork()` for backend isolation and its private message channel for supervision. Reuse Electron's Node runtime initially; do not add a second standalone Node distribution by default. Phase 1 must prove WebTorrent's native dependencies against the pinned Electron ABI. If a dependency cannot run there, use a separately bundled pinned Node child process while keeping Electron as the chosen shell; record that bounded runtime adjustment here before proceeding.
- Transpile server/workspace TypeScript to production JavaScript compatible with Electron's bundled Node version; do not assume the headless Node 24 type-stripping entry point works unchanged. Include production dependencies, frontend assets and explicit build metadata. Resolve workspace dependencies inside the staged artifact rather than relying on checkout symlinks. Keep native module files and their loading paths intact; bundle JS only where it reduces complexity. Rebuild native modules for the selected runtime and architecture, and unpack `.node` libraries and executable tools from ASAR where required.
- Refactor startup inputs to supply resource paths, version, data paths and listener host explicitly. Current `main.ts` and `app.ts` infer the repository root and read its manifest; production bundles must not depend on that layout or the working directory.
- Shell spawns the backend with a private parent/child control channel. Backend binds port `0` directly and reports readiness and its actual port over that channel. Do not reserve then release a port, and do not infer readiness from human log messages. Preserve JSON logging as a separate stream.
- Load UI, API and media from the same loopback HTTP origin, preserving relative links, Range requests, native HLS/hls.js selection and existing write-origin checks. Do not add permissive CORS to make the shell work. Keep `/raw` URLs usable by FFmpeg and local external players.
- Create the BrowserWindow with `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` and web security enabled. Restrict navigation and popups to the app's current origin. Open approved external HTTP(S) links and existing media-player schemes through a narrowly scoped native handler. Expose only typed operations through a preload bridge, validate IPC senders and payloads, and never give page JavaScript arbitrary shell execution or filesystem access. Verify the packaged renderer's origin headers and content security policy.
- Loopback binding limits LAN exposure; it is not authentication. Validate Host and write origins in desktop mode, ignore proxy headers there, and test unrelated websites cannot change settings. The desktop app is not a multi-user security boundary. Any later desktop session credential design must preserve FFmpeg and external-player access explicitly.
- Shell requests graceful shutdown through its control channel, allowing the backend to call `close()`. Use a bounded process-tree termination fallback on Windows and Unix. Parent death/control-channel EOF initiates cleanup; verify orphan FFmpeg processes are contained even when either process crashes. Do not rely on Unix signals on Windows.
- Resolve settings, desktop profile, logs and disposable cache through OS application directories, with writable user locations and an optional download/cache override. Never write into the installation. Keep browser preferences and resume positions durable across assigned port changes: introduce a desktop persistence adapter backed by an app-owned profile store instead of depending on origin-scoped localStorage. The browser distribution retains its browser storage adapter.
- Instantiate one backend per desktop profile. Report startup failures in a local shell screen with retry and access to redacted diagnostic logs. Backend crash recovery must stop remaining media children before restart. Keep window bounds in the desktop profile.

## Research and consolidation progress

- [x] Inspect Magplay's engine, playback, persistence, lifecycle, packaging and test boundaries.
- [x] Compare WebTorrent Desktop's product claims, release and development source; distinguish shared engine capabilities from application features.
- [x] Assess local playback and casting gaps, protocol constraints, acceptance scenarios and indicative effort.
- [x] Consolidate findings and source references into this plan and remove the separate comparison and casting notes.

## Phase 1: prove the Electron runtime and playback

- [x] Inspect repository startup, runtime dependencies, resource serving, CI and FFmpeg process management.
- [x] Compare Electron, Tauri and a browser launcher; finalize Electron and defer implementation on the roadmap.
- [ ] Pin supported Electron/Forge versions, confirm the bundled Node API baseline, choose target OS minimums and the Windows installer maker, and select a maintained AppImage packaging integration. Forge handles the other selected platform makers; keep any AppImage helper in the same staged-artifact pipeline.
- [ ] Assemble a disposable Electron artifact with the transpiled backend, real WebTorrent dependencies, FFmpeg/ffprobe, resources and build metadata; run it without a checkout, npm or tools on PATH.
- [ ] Start the backend in a utility process and open a minimal BrowserWindow on macOS, Windows and Linux; verify direct H.264/AAC MP4, MKV remux to HLS through hls.js, audio and text subtitles.
- [ ] Verify Linux playback in the installed AppImage and Debian package on clean machines. Test Electron's actual shipped codecs and hardware/software decoding paths; do not add WebKitGTK/GStreamer or assume system Chrome proves the artifact works.
- [ ] Audit `node-datachannel`, optional `utp-native` and their transitive native libraries on each target. Record what is included and prove actual peer discovery/download rather than just importing WebTorrent. Do not silently remove a transport to make packaging pass.
- [ ] Prototype a bounded Windows replacement for FFmpeg `SIGSTOP`/`SIGCONT` throttling. Choose a supported native suspension strategy or a redesigned bounded segment producer; merely disabling throttling fails disk/resource goals. Verify resume, seeking and forced cleanup.
- [ ] Verify playback settings writes, renderer isolation, scoped preload IPC and navigation in packaged Electron before committing to the full shell.
- [ ] Record packaged playback and utility-process/native-module results here, including any need for the separate Node fallback. Resolve blockers before expanding desktop behavior; the selected product remains Electron.

Acceptance: a packaged Electron prototype plays and seeks through a legal media fixture on each target, loads its native torrent engine, and leaves no backend or media child after quit. Record remaining platform limits explicitly; development-browser tests alone do not establish packaged acceptance.

## Phase 2: backend portability and runtime assembly

- [ ] Add explicit runtime/resource/version configuration and a desktop entry point sharing the same application factory as headless startup.
- [ ] Add listener host selection, desktop port `0`, readiness/control messages, shutdown requests and parent-disconnect handling. Keep headless/Docker binding configurable for its existing LAN use.
- [ ] Build production server/workspace output, rebuild native dependencies against the selected runtime and stage them without workspace symlinks pointing outside the artifact. Set up ASAR unpacking and executable resource paths. Exclude tests, fixtures, build tools and source maps unless deliberately shipped.
- [ ] Supply absolute bundled FFmpeg/ffprobe paths, hide console windows for child processes on Windows and handle non-ASCII/space-containing paths without shell interpolation.
- [ ] Implement Windows throttling and platform process cleanup with tests for resource limits, seek, track changes and process exit. Linux `/proc` CPU statistics may remain unavailable elsewhere; display this honestly.
- [ ] Add desktop application directories and the client persistence adapter; cover settings, resume positions and preferences surviving a changed listener port.
- [ ] Exercise Windows file locking, atomic settings writes, HLS cleanup and cache deletion; make existing Unix shell-based test fixtures portable where required.

Acceptance: the staged runtime works from an arbitrary working directory and a read-only install folder, with no development checkout or system media tools, and existing headless behavior passes its required checks.

## Phase 3: desktop application behavior

- [ ] Implement the single-instance shell, loading/failure screen, backend readiness and crash handling, window state and quit flow.
- [ ] Enforce renderer isolation, validated scoped IPC, app navigation and external URL handling; verify external players, copy links, file downloads and playlist downloads work in BrowserWindow.
- [ ] Implement desktop profile persistence and test restart, a different assigned port, cache clearing and update installation without losing settings or playback positions.
- [ ] Verify fullscreen, autoplay recovery, keyboard controls, clipboard, subtitles, audio selection and sleep/wake on each OS.
- [ ] Verify unexpected shell/backend death, quit during metadata lookup or transcode, and second launch during startup. No backend, torrent port or FFmpeg process may remain after shutdown completes.
- [ ] Provide an “Open in browser” escape hatch using the current loopback address while the app remains running.

Acceptance: an ordinary user can install, configure a source or paste a magnet, play, quit and reopen without a terminal.

## Phase 4: releases and verification

- [ ] Add per-OS/architecture CI jobs that install/build native dependencies on the target, stage the runtime, build Electron artifacts and upload checksums and provenance/version metadata. Integrate the selected AppImage helper with the same runtime staging used by Forge makers.
- [ ] Pin binary sources and verify checksums for Electron and media tools (plus standalone Node only if the Phase 1 fallback is needed); record dependency versions, licenses and relevant FFmpeg build flags/source availability. Match FFmpeg's encoder support to the existing `libx264` transcode path, or make an explicit media design change.
- [ ] Make installers work offline with bundled Electron/media runtimes and required redistributables; document any host-library prerequisites on Linux. No WebView2 bootstrap is required. Verify this with network access disabled during installation, independently of indexer/torrent network use.
- [ ] Sign Windows artifacts and sign/notarize macOS bundles including nested native code and bundled tools. Keep signing credentials in release secrets. Validate downloaded release artifacts on clean target machines.
- [ ] Add packaged backend smoke checks and Electron playback acceptance. Run meaningful unit, peer and playback checks plus typecheck/lint for runtime changes, and the isolated Docker check when shared startup/assembly changes affect it.
- [ ] Test Linux AppImage on an additional distribution beyond the build baseline; state supported distributions and any required host libraries instead of claiming all-Linux portability.
- [ ] Update README, architecture, lifecycle and deployment documentation in place with desktop install/use, data locations, cleanup, system VPN expectations and verified platform limits.
- [ ] Publish the release matrix only after each artifact passes its own installation and playback acceptance. Offer manual full-installer updates for v1.

## Acceptance scenarios

Use reproducible legal fixtures and a controlled torrent seeder. Test real packaged artifacts, with Node/npm/FFmpeg absent from PATH.

1. Fresh install and launch, magnet-only use, source settings save/test, search and actual torrent transfer.
2. H.264/AAC direct play; MKV remux; audio conversion; optional video transcode; unsupported codecs produce useful external-player choices.
3. Seeking before/after generated HLS output, changing audio/subtitles, next episode, fullscreen, and restart/resume.
4. Throttling beyond four minutes ahead, disk pressure and session limits, track changes while paused and quit while paused.
5. Unicode/space paths, non-writable install, normal user permissions, no admin requirement for ordinary running.
6. Startup failure, backend crash, shell crash, port changes, duplicate launch, sleep/wake and no leftover processes.
7. Browser preferences survive assigned port changes; writes from unrelated origins fail; LAN clients cannot reach the desktop listener; renderer Node access is disabled and unauthorized navigation/IPC/external URLs are rejected.
8. Installation of a newer full package preserves app data; uninstall behavior is documented and never silently deletes cached downloads.

## Estimate and unresolved choices

Budget roughly 2–4 engineering days for the three-platform Electron spike and 1–2 additional weeks for a robust initial release if native dependencies cooperate. This is a planning estimate, not measured delivery time or a scheduled commitment; certificate enrollment and unavailable test hardware add calendar delay.

Resolve in Phase 1: pinned versions and OS baseline, utility-process/native dependency compatibility, installer makers/AppImage integration and Windows throttling implementation. These are implementation details within the Electron decision. Automatic updates and deeper native integrations get their own subsequent scope. Backburner status means this plan creates no active implementation work or release deadline.

## WebTorrent Desktop research

Assessed 2026-10-18 against the then-current Magplay working tree, including in-progress observability work, and the retrieved WebTorrent Desktop sources. These are planning inputs; neither application benchmarks nor an installed Desktop binary were tested. The Electron decision and initial release scope above remain authoritative.

### Assessment

Magplay is a media service built around WebTorrent; WebTorrent Desktop is a desktop torrent client with media playback. They share the difficult torrent machinery already. Magplay's distinguishing features are indexer discovery, a shared server cache, device-specific playback decisions and FFmpeg conversion. Desktop's strongest examples concern persistent user intent, native application behavior and playback destinations.

Keep Magplay's core. Borrow small application concepts where they solve an actual problem. Forking Desktop would replace working search, media and lifecycle code with a different product architecture and create substantial integration work.

### Evidence and version boundaries

The [official product page](https://webtorrent.io/desktop/) and [latest-release redirect](https://github.com/webtorrent/webtorrent-desktop/releases/latest) identify v0.24.0. The release notes mention Electron 10.1.0. Retrieved [`master/package.json`](https://github.com/webtorrent/webtorrent-desktop/blob/master/package.json) instead pins Electron 27.3.11, WebTorrent 1.9.7 and React 17.0.2. Development source and downloadable binaries must therefore be treated separately. No installed Desktop binary was tested, and this report does not infer that the project is abandoned from its release version.

Magplay's engine manifest pins WebTorrent 3.0.21; its Node baseline is 24. Library versions matter: a method in Desktop's older engine integration is not automatically available or appropriate in ours.

### Product and feature comparison

| Concern | Magplay today | WebTorrent Desktop | Consequence |
| --- | --- | --- | --- |
| Primary workflow | Search sources → choose release → play | Add torrent → download/manage/play | Complementary products with substantial engine overlap |
| Deployment | Node/Docker service and browser pages | Installed desktop application | Magplay already serves phones and other LAN devices |
| Desktop distribution | Electron/supervised Node plan, deferred | Packaged desktop product | Desktop is useful acceptance evidence, not evidence that our packaging is complete |
| Discovery | Parallel Torznab/Prowlarr search; BitMagnet Explore | Torrent-oriented intake; no corresponding indexer layer in inspected application code | Preserve Magplay's discovery adapters |
| Input | Pasted v1 magnets; private indexer download links; engine accepts torrent bytes | Magnets, torrent files, native open/drop workflows | Engine support and a user-facing upload flow are different capabilities |
| Torrent engine | WebTorrent 3.0.21 behind an internal API | WebTorrent 1.9.7 in retrieved master | Piece transfer and streaming are shared-library capabilities |
| Download intent | Nothing selected initially; readers request needed bytes | Persistent file selections and torrent start/stop controls | A useful model if offline downloads become a requirement |
| Data retention | Sparse disk cache, idle unloading and LRU eviction | User-managed download locations and torrent list | Our cache is disposable, not a permanent library |
| Playback | Direct, HLS remux, optional video transcode, explicit refusal | HTML media playback and external-player fallback | Desktop's browser engine does not imply universal codec support |
| Audio-only media | Playback decision currently requires video | Audio playback and metadata handling in inspected controller | A concrete capability gap if music/audiobooks matter |
| Subtitles | Embedded/external torrent text tracks converted to WebVTT; image tracks delegated externally | Local SRT/VTT selection and completed torrent subtitle discovery | User-supplied subtitle files are worth considering |
| Remote playback | HTTP URLs, playlists, VLC/IINA/Infuse links | Advertises AirPlay, Chromecast and DLNA | URL handoff is not device discovery and remote control |
| Resume | Per-browser localStorage; server cache supplies recent torrents | Saved application state includes per-file playback information | Desktop profile persistence would remove origin dependence |
| Diagnostics | Peer/range details, preparation stages, FFmpeg speed/CPU, bounded resource stats; observability work in progress | Torrent progress, playback errors and documented aggregate telemetry | Compare measurable outcomes, not just status presentation |
| OS integration | Browser controls; native packaging not implemented | Single-instance behavior, native file handling and playback hooks | A focused shell capability layer would help |

Desktop evidence: [torrent management](https://github.com/webtorrent/webtorrent-desktop/blob/master/src/renderer/controllers/torrent-list-controller.js), [playback](https://github.com/webtorrent/webtorrent-desktop/blob/master/src/renderer/controllers/playback-controller.js), [subtitle handling](https://github.com/webtorrent/webtorrent-desktop/blob/master/src/renderer/controllers/subtitles-controller.js), [advertised features](https://webtorrent.io/desktop/).

Magplay evidence: `packages/torrent-engine/src/engine.ts`, `store.ts`, `packages/playback/src/media.ts`, `apps/server/src/http/media.ts`, `apps/client/src/lib/progress.ts`, `apps/client/src/search.js`, and the existing architecture and desktop packaging documents.

### Runtime architecture

```text
Magplay
  Browser pages ── HTTP API/media ── Node application
                                      ├─ indexers
                                      ├─ WebTorrent + cache
                                      └─ ffprobe/FFmpeg children → HLS/VTT

WebTorrent Desktop, retrieved master
  Electron main ── IPC ── visible React renderer
         └──────── IPC ── hidden WebTorrent renderer
                              └─ torrent HTTP server → player/device
```

Desktop separates torrent work from its visible UI process. Its [hidden-window implementation](https://github.com/webtorrent/webtorrent-desktop/blob/master/src/main/windows/webtorrent.js) exists to preserve responsiveness. Magplay already separates UI execution from backend execution through HTTP and runs FFmpeg as child processes. Adding another engine process would need evidence that torrent work interferes with backend responsiveness; it is not justified merely by Desktop's topology.

The selected Electron shell will supervise our existing Node backend rather than moving torrent ownership into an Electron renderer. HTTP continues to carry media and application contracts; a small native bridge owns window behavior and OS actions. The desktop packaging plan owns the utility-process choice and native dependency validation.

Desktop creates a torrent streaming server when playback starts. Magplay's stable `/raw` route instead serves every torrent and supplies browser playback, probes, conversion and downloads. That consolidation is valuable: it centralizes Range, validators, cancellation and stream lifetime. Replacing it with the library's convenience server would require preserving those semantics and the seekable tar integration.

### Ideas worth borrowing

#### 1. Separate durable user intent from disposable runtime state

Desktop's [state module](https://github.com/webtorrent/webtorrent-desktop/blob/master/src/renderer/lib/state.js) distinguishes saved JSON from live connections and player state, and debounces ordinary saves. Borrow the distinction rather than its mutable global state object.

For desktop Magplay, introduce a small persistence interface used by the existing preference/progress helpers. Keep browser localStorage for browser launches and an app-owned profile for desktop. Persist preferences, positions and window bounds independently of the assigned HTTP port. Continue using validated records and atomic writes; never serialize process handles, active HLS sessions or transient failures.

Cross-device resume is a separate product decision: it needs an explicit server-owned progress store and conflict policy. A desktop profile alone does not synchronize phones and laptops.

#### 2. Distinguish stream, download and retain

Desktop's persistent file choices suggest an explicit model for user intent. If requested, Magplay could offer streaming on demand, downloading selected files without an attached browser response, and retaining selected content against eviction. These are separate controls: starting a download should not silently pin it forever.

This would require durable job state, explicit cancellation, disk admission checks and a policy for retained data exceeding the cache budget. Existing HTTP downloads remain useful but their response lifetime is not a background job. Keep the current simple cache behavior unless this product capability is wanted.

#### 3. Prefer interactive playback over background transfer

Desktop's [torrent-list controller](https://github.com/webtorrent/webtorrent-desktop/blob/master/src/renderer/controllers/torrent-list-controller.js) records other active torrents, stops them during prioritized playback, and resumes them afterward. Borrow the policy goal, with a less disruptive implementation suited to Magplay.

Our range readers already drive piece demand. The missing layer is competition between torrents and consumers: playback, probes, subtitles and a tar download can all compete. First measure startup and stalls under a simultaneous large download. If needed, add bounded low-priority background demand and release priority with consumer ownership. Do not globally stop a torrent that another player still uses. Do not assume `torrent.pause()` stops transfer; the [WebTorrent API](https://webtorrent.io/docs) explicitly limits its semantics to new outgoing peer connections.

#### 4. Model playback destinations through a narrow interface

Desktop's [playback controller](https://github.com/webtorrent/webtorrent-desktop/blob/master/src/renderer/controllers/playback-controller.js) routes commands according to playback location. This suggests a small destination interface for load, play, pause, seek, stop and status, with explicit capability flags. A URL-only external-player handoff may support only load; it must not pretend to supply progress or seeking control.

Implement an adapter only when adding a second controllable destination. Casting additionally needs device discovery, receiver-reachable URLs, receiver codec decisions, disconnection handling and session ownership independent of a browser tab. A desktop loopback URL is unreachable from a TV: LAN media exposure would need to be explicit and scoped. The desktop plan's loopback-only control origin should remain separate from any casting media listener.

#### 5. Add a small native platform capability layer

Desktop's [main process](https://github.com/webtorrent/webtorrent-desktop/blob/master/src/main/index.js) queues open requests until readiness, handles second-instance launches and delays nonessential initialization. Its [IPC handlers](https://github.com/webtorrent/webtorrent-desktop/blob/master/src/main/ipc.js) connect playback state to sleep prevention and native controls.

Useful Magplay shell capabilities are opening a magnet/torrent, showing a download in its folder, choosing a directory, preventing sleep during active playback, and handling fullscreen. Keep a bounded startup queue and route second-instance requests to the running profile. Bind sleep prevention to actual playback and release it on pause, stop, failure and quit. Avoid arbitrary filesystem or shell access from page JavaScript.

#### 6. Keep startup lightweight and report readiness explicitly

Desktop's readiness messaging is a useful pattern. Our shell should receive the bound port over a private control channel and show loading/failure UI immediately. Indexer health and optional browse data should not block basic magnet playback. Existing startup behavior can be assessed against that acceptance condition before changing it.

#### 7. Explore cached-start optimization carefully

The older Desktop engine integration saves file modification times and passes them back on startup. Magplay already saves torrent metadata, but still waits for cached-piece verification. This points to a measurement opportunity, not a drop-in API: verify current WebTorrent support and benchmark a representative large cached file before designing persisted verification state. Never set `skipVerify` unconditionally; truncated, modified or partially written data must not be trusted.

#### 8. Add local subtitles and optional local thumbnails

Desktop supports user-selected SRT/VTT files; Magplay currently offers tracks from the torrent. A browser file input could add local subtitles without a server upload, with size limits and track cleanup. Desktop also generates cached torrent artwork; optional locally generated stills could improve Recent without external poster requests. Thumbnail work must remain bounded and low priority so it does not delay playback. Neither feature requires rewriting the UI framework.

### What Magplay should preserve

- Its indexer boundary, secret redaction and partial search results when a source fails.
- Pure playback policy based on actual client codec capabilities, with direct play before remux before optional transcode.
- The shared raw byte path and consistent streaming cancellation.
- Explicit factories and `close()` ownership, shared pending loads/probes, tab fencing and HLS session admission.
- Separate torrent/HLS storage budgets and conversion throttling.
- Ordinary page URLs, browser Back behavior and a client that needs no native runtime.
- Real local-peer and decoded-video regression tests, rather than treating screenshots as media correctness evidence.

The repository's peer suite exercises missing-piece transfer and cancellation. Its browser suite uses cached fixtures and verifies decoded frames. Neither establishes public-swarm performance or Safari/system-webview compatibility. Test counts and production benchmarks were not rerun for this research task.

### Ideas to avoid copying

Desktop's [visible renderer configuration](https://github.com/webtorrent/webtorrent-desktop/blob/master/src/main/windows/main.js) enables Node integration and disables context isolation. Its [message relay](https://github.com/webtorrent/webtorrent-desktop/blob/master/src/main/ipc.js) intercepts IPC emission and routes by message naming. Those implementation choices are unnecessary for Magplay's existing service boundary; preserve typed HTTP contracts and expose only scoped native actions.

Likewise, avoid adopting a hidden browser window solely to host Node work, whole-application mutable state, large progress payloads/full bitfields, old packaging scripts or unconditional torrent verification bypasses. The [packager](https://github.com/webtorrent/webtorrent-desktop/blob/master/bin/package.js) is useful as an inventory of installer/signing/file-association concerns, not as a current build template. A React migration has no demonstrated connection to torrent startup or codec support.

The [Desktop README](https://github.com/webtorrent/webtorrent-desktop#privacy) describes aggregate playback telemetry. Borrow outcome categories for local diagnostics if useful; adding remote collection is a separate choice and is unnecessary for the current private-LAN product.

### Implications for the Electron decision

Desktop establishes that an Electron torrent player is a viable product shape. It does not prove Tauri playback, current receiver compatibility or a performance advantage over Magplay.

The desktop decision has since been finalized as Electron, with implementation deferred. Electron offers a bundled Chromium target and Node runtime; the considered Tauri option introduces system-webview variance while our app still needs Node and FFmpeg. Both require native torrent dependency packaging, process cleanup, signed installers and real codec tests. Electron does not fix our Unix-specific FFmpeg `SIGSTOP`/`SIGCONT` throttling on Windows.

Use the same fixture matrix for any shell comparison: direct MP4, MKV remux, text subtitles, audio switching, seeking, paused conversion and forced quit. Measure installed/download size, idle memory, first frame and seek time on actual artifacts. Browser choice follows measured compatibility and maintenance cost, not framework marketing.

### Suggested order

| Priority | Recommendation | Completion evidence |
| --- | --- | --- |
| First | Keep the existing packaged playback/native dependency spike | Actual playback and cleanup on each proposed OS target |
| With desktop implementation | Profile persistence and scoped platform actions | Resume survives port changes; open requests survive startup; sleep inhibition releases correctly |
| When bandwidth contention is observed | Interactive priority and rate policy | Better startup/stalls under a controlled competing download; concurrent players remain functional |
| When permanent/offline content is requested | Durable download intent and retention | Jobs survive restart; cancellation and pinned-data budget behavior are explicit |
| When television playback is requested | One receiver adapter and capability-aware media delivery | Device loads a reachable URL, plays/seeks and survives controller loss |
| Optional polish | Local subtitles, cached local artwork | No leaked tracks, unbounded jobs or playback regression |
| After measurement | Verification reuse or richer progress transport | Representative latency/payload reduction with correctness retained |

## Optional local playback and casting

Assessed 2026-10-18. These followups are deferred research scope, not additions to the first desktop release or scheduled work. Server/browser casting can be developed independently of desktop distribution. Select a named device matrix and audit protocol libraries through real-hardware spikes before committing to receiver support. All implementation checkboxes below remain open.

### Goal and parity definition

Match the useful local-player and casting workflows advertised by WebTorrent Desktop: torrent video and audio, seek/resume, subtitles, external players, device selection, and controlled playback to Google Cast, AirPlay and DLNA targets. Preserve the browser/Node/Docker distribution. Parity means tested workflows on a named device matrix, not every receiver model or every codec, and does not imply VLC-level native decoding.

Local playback here means playback on the controlling computer, primarily from torrents. Opening arbitrary existing disk media would be an additional input adapter, not a requirement inferred from the comparison. Creating torrents, permanent downloads, a browsable DLNA server and screen mirroring are separate features.

### Reuse and changes

Reuse WebTorrent, cache/range readers, ffprobe, direct/remux/transcode policy, HLS generation, subtitles, resource admission and HTTP streaming. Extend their input and lifetime contracts rather than replacing the backend.

Suggested responsibility boundaries:

```text
Browser or Electron UI ── control API ── playback coordinator
                                           ├─ browser owner
                                           └─ receiver session → protocol adapter
Media preparation ── raw bytes / conversion ── scoped media URL → receiver
```

The coordinator belongs in application services; protocol discovery/control can become an internal `casting` package with explicit `close()`. Shared API contracts describe devices, commands and snapshots. Keep receiver transport details out of the torrent engine. The local browser's DOM/media state remains client-owned; a server receiver session is authoritative for remote playback.

#### Extension A: close local player gaps

- [ ] Add audio classification/listing, an audio-aware media decision and generation path, audio controls and basic title/artist metadata. Remove the current assumption that no video stream means unplayable without weakening video validation.
- [ ] Add user-selected SRT/VTT tracks with bounded reads, conversion where necessary, object-URL cleanup and timing checks. Casting a local subtitle requires making its bytes available to the receiver through a bounded temporary resource; a browser blob URL is insufficient.
- [ ] Provide native external-player discovery/launch through the desktop bridge when packaged; retain current URL/playlist handoffs for browser users.
- [ ] Verify seek/resume, next item, fullscreen, audio switching and cancellation for audio/video. Desktop persistence, sleep prevention, native open/drop and installers remain coordinated with the initial desktop phases above.

Do not add libmpv/libVLC just for parity. An embedded native decoding engine is a larger product choice with its own rendering, distribution and control work.

#### Extension B: shared receiver lifecycle and media delivery

- [ ] Add device snapshots and protocol adapters with load/play/pause/seek/stop/status plus capability flags. Commands must serialize per session; superseded connection/load results must not replace a newer session.
- [ ] Introduce receiver sessions independent of `createTabs()`. Preserve browser fencing. Closing a controller page must not stop a receiver-owned conversion, while Stop, receiver end, failure and bounded disconnect timeout must release it.
- [ ] Drive HLS keepalive and pause-ahead throttling from receiver status. Current sessions idle after 45 seconds without touch and conversion pauses four minutes ahead; merely keeping a media URL available will not keep a remote film playing.
- [ ] Translate absolute media time and generated-HLS offsets consistently. Seeking outside generated output must restart conversion and reload the receiver at the right timeline; track/subtitle changes may require the same operation. Do not assume a growing event playlist exposes the complete source duration to a receiver.
- [ ] Generalize browser capability decisions into playback-target profiles, including protocol/container delivery support and relevant codec profile, level, resolution and bit-depth constraints. Unknown hardware gets a conservative policy; retain external fallback and useful refusal.
- [ ] Resolve receiver-reachable URLs using the selected LAN interface or an explicit address. Keep desktop control APIs on loopback and add an opt-in media-only listener for cast resources. Use revocable session-scoped resource URLs with expiry compatible with long playback and reconnect; authorize every referenced HLS/subtitle resource and redact credentials in logs. Never expose settings/indexer APIs just to serve a TV.
- [ ] Add scoped receiver CORS/OPTIONS behavior where required for Cast HLS and subtitles, keeping normal application APIs same-origin. Verify MIME types, redirects, byte ranges, subtitle completion and actual receiver fetches.
- [ ] Browse mDNS for Cast/AirPlay and SSDP for DLNA, with bounded parsing/timeouts and controlled device endpoint handling. The current Avahi hostname resolver does not browse devices. Verify Docker multicast, VPN routes, firewalls and multiple interfaces; document a supported network topology and manual-address fallback where feasible.

#### Extension C: protocols in order of evidence

1. Google Cast: prove direct H.264/AAC and controls against the Default Media Receiver, then converted media, seeking, captions, reconnect and queues. Spike a Node Cast V2 adapter so HTTP LAN browser clients and Electron can share server-side control. Audit a candidate library before selecting it. The official browser sender is an alternative for supported browsers with HTTPS; do not assume bundled Chromium in Electron supplies the same Cast environment as Chrome.
2. DLNA: implement SSDP discovery and AVTransport/RenderingControl commands, metadata and receiver protocol negotiation. Start with direct media; select a compatible converted delivery format based on real hardware. Generic fMP4 HLS cannot be assumed. Report unsupported seeking/subtitle controls honestly. A ContentDirectory server for TV-side library browsing is outside this phase.
3. AirPlay: distinguish Safari/system route selection from a server-controlled receiver picker across operating systems. The first can reuse compatible HTML media but needs real Safari/AirPlay acceptance. The second requires a hardware spike for pairing, credentials, device status and video delivery on current receiver firmware. Native Apple integration or a dedicated helper may be preferable to an old Node library; adding a helper changes packaging and must be costed explicitly. No library is selected by this assessment.

#### Extension D: release acceptance

- [ ] Controlled peer tests for partial torrents during receiver reads; session cleanup and offset tests with fake adapters; real device playback tests for each advertised protocol.
- [ ] Direct media, MKV/audio conversion, long playback beyond pause-ahead and idle thresholds, seek before/after generated output, text captions, pause/resume, next item and stop.
- [ ] Controller closes/reopens, receiver sleeps/disappears, network interface changes, server restarts and a competing playback/download consumes resources. Reconnecting a controller should attach to an existing session, not start duplicate output.
- [ ] Exercise at least a named Cast device, an Apple TV/current AirPlay receiver and named DLNA renderers on the network layouts offered as supported. Desktop release claims additionally require packaged Windows/macOS/Linux acceptance under the initial desktop phases above.
- [ ] Define explicit desktop quit behavior during casting. Initial desktop close-to-quit may stop casting with a clear interaction; headless server casting can continue after browser close. Background/tray operation would expand desktop scope.

### Indicative effort

These are rough engineering estimates for one experienced engineer familiar with the code, with devices available. They are not measured delivery commitments. Workstreams overlap; do not add them mechanically to the initial desktop estimate above.

| Workstream | Indicative effort | Main uncertainty |
| --- | --- | --- |
| Audio/local subtitles and player parity | 3–5 working days | Player assumptions and track timing |
| Shared remote lifecycle/media and first Cast adapter | 5–10 days | HLS seek/reload behavior and receiver access |
| DLNA adapter and representative receiver acceptance | 3–7 days | Device delivery/seek/subtitle variability |
| Server-controlled AirPlay and acceptance | 5–15 days, subject to spike | Pairing, firmware and library/helper choice |
| Remaining desktop packaging/integration | 5–10 days if native dependencies cooperate | Windows process control, ABI, signing and clean-machine tests |

A narrow direct-MP4 Cast prototype could take roughly 2–4 days. It would not demonstrate converted-media or three-protocol parity. Budget roughly 6–10 engineering weeks for a bounded, packaged three-protocol release including integration and hardening; a failed modern AirPlay spike, missing hardware or signing enrollment can extend calendar time. Server/browser casting can ship without completing desktop distribution.

## Primary references

- [Electron utility processes](https://www.electronjs.org/docs/latest/api/utility-process): supervised Node execution and the parent message channel.
- [Electron native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules/): native dependency ABI/rebuild requirements.
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security): renderer isolation, navigation and IPC boundaries.
- [Electron Forge](https://www.electronforge.io/): packaging and platform makers.
- [WebTorrent Desktop](https://github.com/webtorrent/webtorrent-desktop): comparable shipped torrent-streaming application, not proof that this app's current dependency versions work in Electron.
- [FFmpeg licensing](https://ffmpeg.org/legal.html): shipped build configuration and redistribution obligations must be checked for the selected binaries.
- [Google supported media](https://developers.google.com/cast/docs/media): receiver-specific codec limits, HLS and CORS/subtitle requirements.
- [Google Web Receiver overview](https://developers.google.com/cast/docs/web_receiver): the Default Media Receiver does not require a custom receiver or app registration.
- [Google Web Sender setup](https://developers.google.com/cast/docs/web_sender): supported browser and HTTPS requirements; iOS Chrome is excluded.
- [Node Cast V2 client implementation](https://github.com/thibauts/node-castv2-client): candidate integration reference, not an adopted dependency or a maintenance endorsement.
- [Apple AirPlay overview, archived](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/AirPlayGuide/Introduction/Introduction.html): HTML media/HLS and system-controlled routing model, not evidence of current firmware compatibility.
- [pyatv supported features](https://pyatv.dev/documentation/supported_features/): pairing/protocol differences and implementation limitations on Apple receivers; evidence for a spike rather than a commitment to Python.
- [UPnP AVTransport](https://openconnectivity.org/wp-content/uploads/2015/11/UPnP-av-AVTransport-Service.pdf) and [ConnectionManager](https://www.upnp.org/specs/av/UPnP-av-ConnectionManager-v3-Service-20101231.pdf): control and protocol negotiation responsibilities.
