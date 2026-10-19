# User interface

How the browser client should look and behave, the Player roadmap, and the open UI cleanup work. [The README](../README.md#using-it) describes what each page does today; this document owns the expectations those pages are held to. Priorities for larger work stay in [the roadmap](roadmap.md).

## Expectations and concepts

### Who it is for

One person (or a household) on a trusted local network, on a laptop, phone or TV-adjacent device. There is no login and no account state. Configuration is optional: everything works from env vars, and Settings (`/settings`) edits the same values in the browser, with env vars taking precedence. The interface should feel like a quiet utility: find something, see whether it will play here, play it.

### Pages and URLs

- Six pages, each with its own URL: Search (`/?q=`), Explore (`/explore`), Title (`/title/…`), Torrent (`/t/<infohash>`), Player (`/play/<infohash>/<file>`) and Settings (`/settings#<section>`). Back, reload, bookmarks and new tabs must all work, so state that matters (query, filters, selected file) lives in the URL, not only in memory.
- Every page shares the same top bar: the `magplay` home link, Explore, and a search box on the left, and the status button and the Settings gear on the right. The search box keeps the last query in this tab (`sessionStorage`), except on the home page.
- The right side has two controls, each at least 40 px square. The **status button** shows a status dot (green, amber, red, or a hollow ring while required checks haven't run) and a problem count (hidden at 375 px), and its accessible name carries the state ("Status: 2 problems"). It opens a panel with a headline, every check worst first (each problem with a plain message and one link to the setting that fixes it) and a Debug details link. The panel shows what is wrong now, not a history of changes. The **gear** is a plain link to `/settings`, named "Settings", with no menu. The status button never claims health it hasn't measured, and it polls only while the tab is visible. Page scripts add both by importing `lib/topbar.ts`.
- Settings (`/settings`) is one page, not panes: every section (Sources, Playback, Storage, Debug) is stacked in order in a single readable column, each a `<section>` with its own id, so `/settings#sources` scrolls to it and status fix links land there. There is no section menu; the section anchors remain available for direct links and status actions. Headings and spacing separate sections, without horizontal rules. It holds only what a person tunes: ports, job limits, timeouts and the like stay env-only. Section descriptions explain what each section contains, without device-scope notes. All editable settings on the page are server settings. A section with a failing check shows a dot by its heading. Server edits collect in a save bar and are saved together, with errors inline under their field, and the bar then says what was saved for four seconds. Starting another edit clears that confirmation; returning to the tab does not show an expired confirmation. The speed test is a card under Debug, with connection status actions linking to `/settings#debug`. Warnings name the failed download-speed or latency limit without guessing a cause. Its results stay in the browser that ran the test; the Player remembers its own preferences. A value set by an env var is read-only and names the variable; other rows carry no env-var notes. A field that can be left empty says "(optional)" next to its label, and source guidance follows the selected type, with an indexer filter only for Jackett and Prowlarr; switching types preserves entered values. Source headings update to the URL hostname while typing, without moving input focus. With no sources, the form to add one is already open.
- The status menu and Settings page were designed from [this mock-up](https://claude.ai/artifact/VGDQJ8ue6DFgcH7Mni2tuB); implementation details are in [architecture](architecture.md#settings-and-status).
- A source set in the environment shows “Set in the environment” beside its name, with a colored status dot, muted status text and a Test button alongside. Source status has no badge border or background, so it reads as information rather than an action. An empty API key renders as a password input, disabled without an edit prompt for an environment source; an existing key stays masked and is shown as “Saved”, with a Replace button when editable.
- Settings labels name the value or action directly: “Source URL”, “Convert unsupported video”, “Minimum free disk space” and “Conversion cache limit”. Help explains what changes, what to enter, or when a limit applies. Avoid conversational filler, vague quality claims and phrases such as “for everyone”.
- Playback contains server video conversion controls. Conversion resolution is disabled while video transcoding is off, follows unsaved toggle changes, and keeps its selected value. Actions name their operation: “Run speed test” and “Clear conversion cache”.
- Back links name where they go ("← Gladiator", "← Results", "← Explore") and only appear when that destination is the real previous step (`lib/back.ts`). After a direct visit the torrent page has none; the title page falls back to Explore.
- History is intentional: a new search and each Explore filter change (type, sort, genre, year, quality) is its own entry, so Back steps back through them before leaving the page. Switching a search's category replaces the entry, and "Show more" adds none.
- Malformed URLs fall back to defaults (for example an unknown Explore `type` becomes `movie`) instead of showing a validation error.

### Discovery types

Explore offers Movies and TV, Music and Audiobooks, Books and Comics, Games and Software, Adult and Uncategorized. BitMagnet supplies the classification. `content.showAdult` defaults to false and excludes classified adult Explore/title releases; requesting the Adult type while disabled returns a readable refusal. It does not filter generic Torznab/Prowlarr search results. Clarifying the setting's broader help text and finishing non-media download messaging remain in the [taxonomy plan](plans/generic-torrent-taxonomy.md).

### Honest states

Every list or panel has four states, and each is visible and distinct:

- **Loading:** a short label with a spinner. Controls that depend on the result (Show more, filters for the other type) are hidden or cleared, never left showing stale data from the previous request.
- **Empty:** a sentence that says what is empty and what to try next. A first-run page is never blank.
- **Error:** plain language, not raw API validation text, and visible without hovering (a failed search source says why under the chips). Offer a retry only when retrying can help; it reruns the request on the page (`setError` in `lib/ui.ts`) instead of reloading. A permanent error (no such file) offers the way back instead.
- **Ready:** the content.

Numbers shown side by side must mean the same thing. A seeder count, a release count or a genre count on one page should match what the next page shows for the same thing, or be labelled so the difference is obvious. A count the source only estimated is left out rather than shown as exact, and a list cut short by a limit says so.

### Playback first

- "Plays in browser" is the most important fact about a release and is shown wherever releases are listed. Browser-playable releases can be sorted first, but the release that **Best release** picks must be visible and explained.
- The external-player route (Open in, ⋯ menus, Copy stream link) is a first-class alternative, not an error path, and offers the same actions everywhere a file appears.
- On the Player page the video, its controls and the title row fit in the viewport together on common laptop and phone sizes. The video is as large as the viewport allows for its aspect ratio (see [Theater layout](#2-theater-layout-by-default)).
- Every playback mode (direct, remux, transcode) uses the same player chrome, and every control, including Audio and Subtitles, works in fullscreen (see [One player chrome](#1-one-player-chrome-for-every-mode)).
- Technical detail (codecs, container, peers) lives behind ⓘ Details and uses human labels ("MP4", "MP3 stereo"), not raw ffprobe strings. During a playback wait, show the evidence that explains the wait directly on the video, including file availability, conversion speed and buffered seconds.

### Playback wait explanations

Proposed follow-up, 2026-10-19: a stable four-stage flow for the wait/debug overlay is explored in the [design study and interactive mocks](research/player-debug-flow/proposal.md). It is a proposal, not an accepted change to the behavior below; presentation choice and implementation remain open in the roadmap.

The player uses the Reason first design: a centered cause, one short explanation, measured evidence and relevant recovery actions, with a Why disclosure for the playback decision and current diagnostics. The panel belongs to the video stage, so it and its external-player choices work in fullscreen. A quiet immediate preparation label expands after one second. Elapsed waiting time is shown without inventing a completion estimate or preparation percentage. Why and keyboard focus survive routine metric updates; assistive technology announces reason changes rather than every timer tick.

Reasons distinguish loading/checking a file, selecting a playback mode, waiting for torrent data or peers, converting/preparing playable segments, and waiting for the browser to buffer. Unsupported formats, failed/lost sessions and blocked autoplay have specific actions. Stale or inconclusive diagnostics say that the cause is not yet known. A deliberately paused or normally playing video has no blocking explanation. If sustained conversion capacity falls below the selected playback speed with little video prepared ahead, a compact advisory remains while playback continues.

Diagnostics use exact file completion and published HLS segment readiness, not rounded percentages or ffmpeg output timestamps alone. Low conversion speed does not establish CPU saturation. Partial input with peers is described as a possible source-data wait; zero peers does not mean a torrent is dead. Browser buffering does not establish whether delivery or decoding is responsible. The server reports active file-loading/probing phases, and the player polls status before a playback decision as well as during playback. Old-session responses cannot update the current explanation after an audio change or seek restart.

Playback explanations have a separate channel from transient speed, subtitle and mute notices. Explicit failures offer retry; ordinary buffering does not restart healthy conversion. External playback is offered for incompatible or slow conversion and browser delivery trouble, while source-data waits offer another release because external players also need the missing torrent data. Resume prompts and next-episode questions keep their existing actions.

### Shared building blocks

- One release row component (`releaseRow` in `apps/client/src/lib/ui.ts`) for every release list: Search, Explore "Just added" and Title releases. Name, badges, size and seeders always appear in the same places.
- One menu component, positioned so it never leaves the viewport, whichever side of the page its button is on.
- Shared formatting helpers for sizes, speeds, times and counts, including singular/plural ("1 seeder").
- Text from indexers is decoded once on the server (HTML entities) and treated as plain text in the client.
- The `hidden` attribute always hides an element, regardless of component styles.

### Visual and layout

- Dark, low-contrast chrome so video and titles stand out. One accent colour for actions and links; green only for "plays in browser".
- Same side gutter on every page, including the Player. The Player's video band is the one exception: it runs edge to edge, and everything under it keeps the gutter.
- Nothing is loaded from outside the server: no posters, fonts or scripts from third parties. Explore tiles have no posters, so their shape should earn its space instead of imitating a poster grid.
- Works at 375 px wide: no horizontal scroll, metadata wraps under names instead of squeezing them, and touch targets are comfortably sized.
- Search accepts a title or a pasted magnet link. A valid BitTorrent v1 magnet produces one result without contacting indexers, using its display name (or info hash when unnamed), with size and seeder counts left unknown. Opening it retains its trackers and web seeds. Category filters do not restrict a direct magnet lookup; malformed or unsupported magnets show a readable error.
- Search filters (All, Movies, TV, Audio, Software, Books, Other) appear only once there is a query; the home page shows just the search bar and recent items.
- Labels hide only what the source can't add to: show the source name on search results only when more than one source is configured.

### Accessibility and keyboard

- Controls have accessible names that match what is shown ("TV", not `tv_show`).
- Menus open and close with the keyboard, and Escape closes them.
- The player keeps its keys: space play/pause, ←/→ seek 10 s, M mute. The keys added by the new chrome are listed under [One player chrome](#1-one-player-chrome-for-every-mode), and **?** shows them all.

## Player roadmap

Decided on 2026-10-17: replace the Player's controls with one overlay chrome for every playback mode, make a theater layout the default, then add a playback performance graph. Build them in this order; each step ships on its own. The options are mocked in [the performance graphs artifact](https://claude.ai/artifact/8p2zDto3EHRTj8ja7kheTm); F, G and B were chosen. Not built: D (a throughput chart on the Torrent page), E (a "Now" panel on the home page), H (immersive) and I (a side rail). Open: whether the Performance lanes should eventually replace the snapshot rows in ⓘ Details.

### 1. One player chrome for every mode

**Today.** There are two chromes. `direct` files get the browser's native controls (`video.controls = !hlsMode` in `apps/client/src/player.js`). Remux and transcode get the custom `#controls` bar in `public/player.html`, because every seek outside what the browser can still play starts a new session and the native timeline only knows that session. As a result:

- Controls look and behave differently from one release to the next.
- Audio, Subtitles and Open in sit below the video, so fullscreen can't reach them.
- The seek bar doesn't show what's ready, so a separate 3 px `#pieces` strip under it shows the downloaded parts of the file on a different track.
- Icons are emoji (🔇 renders in colour, ⛶ is missing from some fonts), and volume is mute-only.
- The bar takes 40 px under the video at all times.

**Design.** One chrome, drawn over the bottom of the video on a dark gradient, with the native controls always off.

- **Visibility.** The chrome is visible while paused, while a menu is open, while focus is inside it, and for 2.5 s after the last pointer move, touch or key press. While playing it fades out and the cursor hides over the video. In fullscreen the same rules apply.
- **Left to right:** play/pause, back 10 s, forward 10 s, mute with a volume slider, `0:22 / 26:06`, a flexible gap, **Next: S01E02** (only when there is a next file), Subtitles, Audio, Speed, ⋯ More, Fullscreen. More holds the Open in items, Download file, Copy stream link and Picture in picture, so the Player offers the same file actions as the torrent page's ⋯ menu.
- **Menus** open upward inside the video, use the shared `menu()` from `lib/ui.ts` (extended to open upward and stay inside the stage), and close with Escape. Subtitles and Audio list the same choices as today's selects. Choosing an audio track still restarts the session at the current position, as `start(position())` does today.
- **Seek bar.** The full duration, with four layers drawn on one track from bottom to top:
  1. *On the server*: `status.file.ranges` (fractions of the file's bytes, used as an approximation of time).
  2. *Converted by ffmpeg* (remux and transcode only): from `cur.offset` to `cur.offset + produced`.
  3. *In the browser*: `video.buffered` ranges, shifted by `cur.offset` in HLS modes.
  4. *Played*: 0 to `position()`, in the accent colour.

  `#pieces` and its 2 s background-gradient update are removed.
- **Seek tooltip.** On hover or drag, show the time under the pointer and what a jump there will do. The rules mirror `seekTo()`:
  - Inside the browser buffer, or anywhere in `direct` mode when that part is on the server: just the time.
  - Inside the session's browser-seekable range (`video.seekable` shifted by `offset`): just the time.
  - Outside the converted range but on the server: "Restarts conversion here".
  - Not on the server: "Not downloaded yet. Starts when peers send it."
- **Seek feedback.** When a seek restarts ffmpeg, the overlay says "Starting at 14:20…" with the spinner instead of the generic "Buffering…".
- **Title overlay.** In fullscreen only, the top of the video shows the title (see step 2) on a gradient that fades with the controls.
- **End of video.** The existing 10 s countdown to the next file stays on the video, as a card with **Play now** and **Cancel**.
- **Icons** are inline SVG with `fill: currentColor`. No emoji and no icon font.
- **Keys.** Space or K play/pause, ←/→ or J/L ±10 s, ↑/↓ volume, M mute, F fullscreen, C subtitles on/off (last-used track), N next file, `<`/`>` speed, ? key sheet. Keys are ignored while typing in an input or select, as today.
- **Media Session.** Set `navigator.mediaSession.metadata` (title, episode) and handlers for play, pause, seekbackward, seekforward and nexttrack. Hardware media keys and the OS Now Playing panel then work.
- **Remember choices** in `localStorage`: volume, mute, speed, and the preferred audio and subtitle language. The next file picks a track by language before falling back to track 1.
- **Narrow screens.** Below 600 px of stage width, the ±10 s buttons, the volume slider, Speed and the Next label hide. Next becomes an icon, and Speed and Picture in picture move into More. Touch targets stay at least 40 px.
- **Accessibility.** Every control is a real `<button>` or range with an accessible name that matches its tooltip ("Subtitles: English"). The seek bar is an `input type="range"` with `aria-valuetext` such as "0:22 of 26:06". Focus stays visible on the dark gradient.

**Implementation checklist**

- [x] Replace `#controls` in `public/player.html` with the new chrome markup inside `#stage`, and move the Audio/Subtitles selects into chrome menus.
- [x] Turn native controls off in every mode, and route `direct` mode through the same seek, time and buffer code as HLS modes.
- [x] Add the SVG icon set and a `chromeVisible` timer with the visibility rules above. Hide the cursor while hidden.
- [x] Draw the four seek bar layers from `status.file.ranges`, `cur.offset`/`produced` and `video.buffered`. Delete `#pieces`.
- [x] Add the seek tooltip with the four outcomes, and the "Starting at…" message for restarts.
- [x] Add More (Open in, Download file, Copy stream link, Picture in picture) and Speed menus. Make `menu()` open upward and stay inside the stage.
- [x] Add Next to the chrome and remove the `#next` card. Keep the end-of-video countdown card.
- [x] Add the new keys and the ? key sheet. Update the keyboard expectation above if any key changes.
- [x] Add Media Session metadata and handlers.
- [x] Persist volume, mute, speed and audio/subtitle language. Pick tracks by language on the next file.
- [x] Narrow layout below 600 px, checked at 375 px in portrait and landscape. *e2e at 375 × 812 and 812 × 375 (both under 600 px of stage): ±10 s, volume and Speed hidden, Next as an icon, Speed in More, every control at least 40 px and inside the stage, no sideways scroll. Checked in Chromium only; real phones are roadmap item 1.*
- [x] e2e: the chrome appears in direct and HLS modes, Audio and Subtitles menus work in fullscreen, a seek outside the converted range restarts the session, and keys work.

### 2. Theater layout by default

**Why.** Today the video sits in the 1200 px `main.wide` column, capped at 80vh. That wastes width on 2.39:1 films (a 1440 × 900 laptop shows 1168 px of a possible 1440) and still pushes the options, Next and Details below the fold at 800 × 600. Going edge to edge only helps width-bound video. A 16:9 episode is height-bound, so the layout has to size the video by both.

**Design.**

- The stage moves out of `main` into a full-width black band directly under the top bar. Everything below stays in the 1200 px column with the normal gutter.
- The video gets the largest box that fits both limits:

  ```css
  #stage { --ar: 16 / 9; width: min(100%, calc((100dvh - var(--topbar-h) - var(--title-row-h)) * var(--ar))); margin-inline: auto; }
  ```

  `--ar` comes from the probe: `info.video.width / info.video.height`, corrected by the sample aspect ratio when ffprobe reports a non-square one. It stays 16:9 until the probe returns, so the page doesn't jump twice. `--topbar-h` and `--title-row-h` are measured once and on resize, not hard-coded.
- **Title row** under the band, one line where it fits:
  - Left: the back link to the torrent and the title. The title is the parsed name and episode ("Fleabag · S01E01"), using `episodeLabel`, with the file name moved into ⓘ Details.
  - Right: Open in, and the ⓘ Details toggle.
  - Audio, Subtitles and Next now live in the chrome, so they leave this row.
- ⓘ Details (and later Performance) stays below the title row.
- **Phones.** In portrait the band is full width and the title row wraps under it. In landscape the video fills the screen height, and the title row is one scroll away.
- **Fullscreen** uses the stage, as today, so the chrome and its menus come along.
- With a 2.39:1 film on 1440 × 900, the video is 1440 × 602 px. With 16:9 it is about 1305 × 734 px with black pillars. In both cases the title row and the Details link are above the fold.

**Implementation checklist**

- [x] Move `#stage` out of `main.wide` in `public/player.html` into a full-width band, and keep `main.wide` for the title row and Details.
- [x] Set `--ar` from the probe (with sample-aspect correction) and apply the sizing rule. Measure `--topbar-h` and `--title-row-h` on load and resize.
- [x] Build the title row with the parsed title, back link, Open in and Details. Move the file name into Details.
- [x] Check the layout at 1440 × 900, 1280 × 800, 800 × 600, and 375 × 812 in both orientations, with a 2.39:1 and a 16:9 file. Nothing scrolls sideways, and the title row is above the fold on laptops. *The layout e2e runs every size for a 16:9 and a 2.39:1 (478 × 200) fixture: aspect ratio kept, as large as fits, title row above the fold except in phone landscape, no sideways scroll. Chromium only.*
- [x] e2e: the video box keeps its aspect ratio and fits the viewport at desktop and phone sizes.
- [x] Close the related cleanup items below (Player fit, Player gutter, Open in without Download).

### 3. Playback performance graph

**Why.** ⓘ Details shows one snapshot of ffmpeg speed, peers and buffer. When playback stalls, nothing shows whether the swarm, the server CPU or the browser was to blame, or whether a release can keep up before you commit to it.

**Design.** A **Performance** disclosure next to ⓘ Details with three lanes on one 3-minute time axis:

1. **Swarm:** download speed as an area, with the peer count as a label.
2. **Transcoder:** ffmpeg speed as a line against a dashed 1× realtime line, with ffmpeg CPU as a faint area behind it and shaded spans where ffmpeg is paused 240 s ahead. CPU is a share of all cores, so 100% means the server is saturated.
3. **Buffer:** seconds converted ahead of the playhead as an area, the browser buffer as a line, and red spans for stalls (`waiting` until `playing`).

Each lane's label shows the current value. In `direct` mode the Transcoder lane is hidden and the Buffer lane shows only the browser buffer.

**Data.** Most of it already arrives in the 2 s `/api/torrents/:ih/status` poll. Keep the last 90 samples in memory on the page. A reload starts empty, which is acceptable for this step. Two server fields are new: `fps` and `cpu` in `sessionStats`. `fps` comes from ffmpeg's `-progress` output, which the HLS sessions (`packages/playback/src/hls.ts`) used to discard. `cpu` is the ffmpeg process's CPU-time delta between polls divided by `os.availableParallelism()`. On Linux it comes from `/proc/<pid>/stat`. Where `/proc` is missing (macOS development), it is `null` and the CPU area is hidden.

**Implementation checklist**

- [x] Keep `fps` from `-progress`, and add `cpu` (share of all cores, or `null`) to the session state and the session stats in `packages/playback/src/hls.ts` (formerly `apps/server/src/sessions.js`), with unit tests that use a fake `/proc` reader.
- [x] Add both fields to the shared API contract types.
- [x] Add a 90-sample ring buffer in `apps/client/src/player.js`, fed by `pollStatus` and by `waiting`/`playing` events for stalls.
- [x] Draw the three lanes as inline SVG with the shared sparkline helper, using theme colours and the existing tokens, and redraw only while the disclosure is open.
- [x] Hide the Transcoder lane in `direct` mode and the CPU area when `cpu` is `null`.
- [x] Keep the "converts slower than playback" warning, and link it to the Performance disclosure.
- [ ] Check it with a healthy remux, a transcode that falls behind, and a direct file. Healthy remux and direct were checked (screenshots in `docs/checkpoints/2026-10-17-player-redesign/`); a transcode that falls behind still needs a slow server, and CPU only shows on Linux. Moved to [roadmap item 2](roadmap.md#what-to-do-next).

### Later, if use calls for it

These were mocked alongside the steps above and are not scheduled.

- **Server-side history** (150 samples per loaded torrent, returned as `history` from `/status`). This lets the graph start filled after a reload, and it is a prerequisite for the next item.
- **Throughput chart on the Torrent page.** Download and upload areas, the peer count and an ETA for downloads that aren't being streamed.
- **"Now" panel on the home page.** A new `GET /api/activity` returns loaded torrents with their state and sparklines, live sessions, server load and cache use. Worth it once more than one person watches at a time.
- **Stats overlay** toggled with I, reusing the graph's samples, for fullscreen and TV use.
- **Side rail** on wide screens with the season's episodes and the graph in miniature. It suits series but leaves the rail empty for single films.
- **Immersive layout** toggled with T: the video fills the viewport and the top bar fades with the chrome. It needs an exception to the shared top bar rule above.

## Cleanup todo

Findings from a visual walkthrough on 2026-10-17 (local server against BitMagnet, Chromium at desktop and 375 px widths). Ordered by priority: broken behaviour first, then misleading information, then consistency and polish.

### P1: broken behaviour

- [x] **The torrent page's More menu runs off the left edge of the screen.** `.menu-items { right: 0 }` in `public/style.css` opens every menu leftward from its button, which clips "Download all", "Copy magnet link" and the rest. Position the menu against the side of the button that has room.
- [x] **`hidden` is overridden by `button.button { display: inline-block }`**, so Explore's "Show more" shows while loading and on errors. Add a global `[hidden] { display: none !important }`.
- [x] **Explore keeps the previous type's genres while the new type loads.** Switching Movies → TV kept film genre chips and counts for 10+ s while the first, uncached TV query ran. Clear chips and the year/quality options on a type change.
- [x] **Invalid Explore `type`** (`/explore?type=tv`) shows the raw message "type must be movie or tv_show", keeps "Movies" selected and shows "Show more". Fall back to `movie`.
- [x] **Unknown file number on the Player** (`/play/<ih>/9`) shows "No such file in this torrent" with a **Try again** button that can't help, leaves the Audio/Subtitles/Details controls showing with nothing in them, and the back link reads "← Files" instead of the torrent name. Offer only the way back and hide the controls.

### P2: misleading information

- [x] **HTML entities appear in titles** (`Beltesassar&#39;s Short Animation Festival`). Decode them in the source adapters (`src/sources/`), once, before normalizing.
- [x] **"1 seeders".** The plural is hard-coded in `apps/client/src/lib/ui.ts` (`releaseRow`) and `apps/client/src/explore.js` (`renderTile`). Add a shared count formatter.
- [x] **The Explore tile and the Title page disagree about seeders.** The Gladiator tile says 446 seeders, but the Title page sorts browser-playable releases first, so the top rows have 1–5 seeders and the 446-seeder release (the one **Best release** picks) is far down a 73-row list. Show the release count in the Releases heading, and say what Best release chose (or show it at the top). *Done: the Title page lists releases most seeded first, like the tile; the heading reads "73 releases", the chosen row has a **best** badge and a line under the buttons says what Best release picked and why.*
- [x] **Explore tiles report `releaseCount: 1`** for titles with many releases (Gladiator has 73). Nothing displays it yet; fix or drop the field before something does. *Dropped: a page of 100 releases only holds some of a title's releases, so no count is claimed; the Title page has the full list.*
- [x] **Film genre counts don't add up.** Drama shows 670 while the year menu shows 13,371 films for 2026 alone, and TV genres are in the tens of thousands. Find out whether film genre counts come from a capped sample or a different query, and make them comparable or label them. *Cause: BitMagnet answers within an aggregation budget and returns Postgres planner estimates (`isEstimate`) past it; film genre estimates were about 100× low (Drama ≈675, exact 82,587). Exact counts take 35–50 s per type and starved searches when both types warmed at once, so the server marks estimated counts and Explore shows those without a number.*
- [x] **No H.264 badge for one title.** `big_buck_bunny_1080p_h264.mov` gets no badge, probably because the name uses underscores, while another result in the same search does. Check the badge parser's separators.

### P3: consistency

- [x] **Release lists look different on each page.** Search uses a table with Size/Seeders columns (`renderResult` in `public/search.js`); Explore "Just added" and Title use `releaseRow`. Use `releaseRow` everywhere and delete `renderResult`.
- [x] **The header search box empties on every page except Search,** so the query disappears after opening a torrent. Keep the last query (URL or `sessionStorage`).
- [x] **"← Results" appears on torrent pages not reached from a search** (direct links, Explore, recent list). Show it only when there is a search to go back to; otherwise link to where the user came from.
- [x] **The Player page has a different side gutter** from the other pages. Fixed by [Theater layout](#2-theater-layout-by-default).
- [x] **Open in on the Player has no Download file option,** while the torrent page's ⋯ menu does. Offer the same file actions in both. Fixed by the More menu in [One player chrome](#1-one-player-chrome-for-every-mode).
- [x] **More → Copy infohash does the same thing as the clickable ID** next to the torrent's metadata. Keep one. *Already done in e19b257: only the ID button remains.*
- [x] **Screen readers hear "tv_show"** for the Explore Movies/TV switch. Give the radios proper labels.

### P4: polish

- [x] **The Player doesn't fit the viewport.** At 800×600 the full-width video pushes Audio/Subtitles/Open in below the fold. Fixed by the sizing rule in [Theater layout](#2-theater-layout-by-default).
- [x] **ⓘ Details shows raw ffprobe values.** Container reads `mov,mp4,m4a,3gp,3g2,mj2` and unnamed audio tracks read "1. Track (mp3 2ch)". Map them to "MP4" and "MP3 stereo". *Audio now reads "MP3 stereo" via `audioFormat` (Player step 1). The container now reads "MP4" via `containerLabel` (checked in the layout e2e).*
- [x] **The source label repeats on every search row** ("BitMagnet") with a single source configured. Show it only with more than one source.
- [x] **Odd spacing on the Torrent and Title pages.** The torrent page has an empty band between the title and "3 files · 276 MB", and the Title page has a large gap above "Releases".
- [x] **An unknown torrent's heading is the 40-character infohash** until metadata arrives. Shorten it (`dd8255ec…`).
- [x] **The Search home page is blank on first run.** With an empty cache there is nothing under the search bar. Add a line of help or a link to Explore. Recent items also can't be removed. *A removed item is hidden in this browser until it is opened again; the cache is untouched.*
- [x] **Mobile wrapping.** At 375 px "last played just now" wraps under the file name on the torrent page, and Explore's "Just added" meta line (time · size · seeders) squeezes release names until they break mid-word. Put meta under the name on narrow screens.
- [x] **Explore tiles are tall blocks of colour with only a name.** Without posters the 2:3 shape wastes most of the screen. Try a shorter tile or a dense list view so more titles fit. *Tiles are now 88 px cards, about twice as many per screen.*

### Discovery friction (roadmap item 7)

- [x] **Filter history.** Each Explore filter change and each new search is a history entry; Back steps back through them, and the page follows the URL on Back/Forward.
- [x] **Visible local retries.** Failed searches, Explore pages, genre counts, title and torrent loads show **Try again**, which reruns the request on the page.
- [x] **Selected genres outside the top chips.** A genre chosen from a link or a narrower filter keeps its chip even when it isn't among the 14 most common.
- [x] **Useful source errors.** A failed search source says why under the chips, with **Search again**, instead of a red chip with the reason on hover. A server with no sources configured says so (503) instead of an empty 502.
- [x] **Honest title-list truncation.** The Title page reads only the 100 most-seeded search hits for a name; when BitMagnet had more, the list says so and links to Search all sources.

## Debug logs

Settings → Debug shows time, severity and a readable message in each log summary; component and event identifiers stay in the expanded structured record with operation/request/error details. It also shows the server capture level and application-side loss count. Server facts and metrics use one label–value pair per row, with labels on the left and values on the right at every screen size. Resource metrics are grouped under “Active jobs and limits” and “Storage and caches” disclosures. Polling updates their values without closing the groups or moving keyboard focus, and leaves expanded log records readable. Its severity filter only narrows captured records. Copy diagnostics includes the same sanitized tail; see [logging](logging.md) for capture, retention and metrics behavior.
