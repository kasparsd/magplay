# Desktop packaging

Finalized 2026-10-18. Status: backburner; implementation has not started and is not scheduled. Decision: Electron with the existing interface in its own application window, the Node backend in a supervised process, and bundled FFmpeg/ffprobe. [Architecture](../architecture.md#desktop-distribution-direction) owns the architectural decision; [the roadmap](../roadmap.md#backburner) owns priority; this document owns delivery tasks and acceptance criteria. Resume at Phase 1 only when desktop distribution is explicitly prioritized.

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

## Primary references

- [Electron utility processes](https://www.electronjs.org/docs/latest/api/utility-process): supervised Node execution and the parent message channel.
- [Electron native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules/): native dependency ABI/rebuild requirements.
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security): renderer isolation, navigation and IPC boundaries.
- [Electron Forge](https://www.electronforge.io/): packaging and platform makers.
- [WebTorrent Desktop](https://github.com/webtorrent/webtorrent-desktop): comparable shipped torrent-streaming application, not proof that this app's current dependency versions work in Electron.
- [FFmpeg licensing](https://ffmpeg.org/legal.html): shipped build configuration and redistribution obligations must be checked for the selected binaries.
