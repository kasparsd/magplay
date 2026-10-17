# User interface

How the browser client should look and behave, and the open UI cleanup work. [The README](../README.md#using-it) describes what each page does today; this document owns the expectations those pages are held to. Priorities for larger work stay in [the roadmap](roadmap.md).

## Expectations and concepts

### Who it is for

One person (or a household) on a trusted local network, on a laptop, phone or TV-adjacent device. There is no login, no account state and nothing to configure in the browser. The interface should feel like a quiet utility: find something, see whether it will play here, play it.

### Pages and URLs

- Five pages, each with its own URL: Search (`/?q=`), Explore (`/explore`), Title (`/title/…`), Torrent (`/t/<infohash>`) and Player (`/play/<infohash>/<file>`). Back, reload, bookmarks and new tabs must all work, so state that matters (query, filters, selected file) lives in the URL, not only in memory.
- Every page shares the same top bar: the `magplay` home link, Explore, and a search box. The search box keeps the current query where there is one.
- Back links name where they go ("← Big Buck Bunny", "← Results") and only appear when that destination is the real previous step.
- Malformed URLs fall back to defaults (for example an unknown Explore `type` becomes `movie`) instead of showing a validation error.

### Honest states

Every list or panel has four states, and each is visible and distinct:

- **Loading:** a short label with a spinner. Controls that depend on the result (Show more, filters for the other type) are hidden or cleared, never left showing stale data from the previous request.
- **Empty:** a sentence that says what is empty and what to try next. A first-run page is never blank.
- **Error:** plain language, not raw API validation text. Offer a retry only when retrying can help; a permanent error (no such file) offers the way back instead.
- **Ready:** the content.

Numbers shown side by side must mean the same thing. A seeder count, a release count or a genre count on one page should match what the next page shows for the same thing, or be labelled so the difference is obvious.

### Playback first

- "Plays in browser" is the most important fact about a release and is shown wherever releases are listed. Browser-playable releases can be sorted first, but the release that **Best release** picks must be visible and explained.
- The external-player route (Open in, ⋯ menus, Copy stream link) is a first-class alternative, not an error path, and offers the same actions everywhere a file appears.
- On the Player page the video and its controls (Audio, Subtitles, Open in) fit in the viewport together on common laptop and phone sizes.
- Technical detail (codecs, container, peers, ffmpeg speed) lives behind ⓘ Details and uses human labels ("MP4", "MP3 stereo"), not raw ffprobe strings.

### Shared building blocks

- One release row component (`releaseRow` in `public/lib/ui.js`) for every release list: Search, Explore "Just added" and Title releases. Name, badges, size and seeders always appear in the same places.
- One menu component, positioned so it never leaves the viewport, whichever side of the page its button is on.
- Shared formatting helpers for sizes, speeds, times and counts, including singular/plural ("1 seeder").
- Text from indexers is decoded once on the server (HTML entities) and treated as plain text in the client.
- The `hidden` attribute always hides an element, regardless of component styles.

### Visual and layout

- Dark, low-contrast chrome so video and titles stand out. One accent colour for actions and links; green only for "plays in browser".
- Same side gutter on every page, including the Player.
- Nothing is loaded from outside the NAS: no posters, fonts or scripts from third parties. Explore tiles have no posters, so their shape should earn its space instead of imitating a poster grid.
- Works at 375 px wide: no horizontal scroll, metadata wraps under names instead of squeezing them, and touch targets are comfortably sized.
- Labels hide only what the source can't add to: show the source name on search results only when more than one source is configured.

### Accessibility and keyboard

- Controls have accessible names that match what is shown ("TV", not `tv_show`).
- Menus open and close with the keyboard, and Escape closes them.
- The player keeps its keys: space play/pause, ←/→ seek 10 s, M mute.

## Cleanup todo

Findings from a visual walkthrough on 2026-10-17 (local server against BitMagnet, Chromium at desktop and 375 px widths). Ordered by priority: broken behaviour first, then misleading information, then consistency and polish.

### P1: broken behaviour

- [ ] **The torrent page's More menu runs off the left edge of the screen.** `.menu-items { right: 0 }` in `public/style.css` opens every menu leftward from its button, which clips "Download all", "Copy magnet link" and the rest. Position the menu against the side of the button that has room.
- [ ] **`hidden` is overridden by `button.button { display: inline-block }`**, so Explore's "Show more" shows while loading and on errors. Add a global `[hidden] { display: none !important }`.
- [ ] **Explore keeps the previous type's genres while the new type loads.** Switching Movies → TV kept film genre chips and counts for 10+ s while the first, uncached TV query ran. Clear chips and the year/quality options on a type change.
- [ ] **Invalid Explore `type`** (`/explore?type=tv`) shows the raw message "type must be movie or tv_show", keeps "Movies" selected and shows "Show more". Fall back to `movie`.
- [ ] **Unknown file number on the Player** (`/play/<ih>/9`) shows "No such file in this torrent" with a **Try again** button that can't help, leaves the Audio/Subtitles/Details controls showing with nothing in them, and the back link reads "← Files" instead of the torrent name. Offer only the way back and hide the controls.

### P2: misleading information

- [ ] **HTML entities appear in titles** (`Beltesassar&#39;s Short Animation Festival`). Decode them in the source adapters (`src/sources/`), once, before normalizing.
- [ ] **"1 seeders".** The plural is hard-coded in `public/lib/ui.js` (`releaseRow`) and `public/explore.js` (`renderTile`). Add a shared count formatter.
- [ ] **The Explore tile and the Title page disagree about seeders.** The Gladiator tile says 446 seeders, but the Title page sorts browser-playable releases first, so the top rows have 1–5 seeders and the 446-seeder release (the one **Best release** picks) is far down a 73-row list. Show the release count in the Releases heading, and say what Best release chose (or show it at the top).
- [ ] **Explore tiles report `releaseCount: 1`** for titles with many releases (Gladiator has 73). Nothing displays it yet; fix or drop the field before something does.
- [ ] **Film genre counts don't add up.** Drama shows 670 while the year menu shows 13,371 films for 2026 alone, and TV genres are in the tens of thousands. Find out whether film genre counts come from a capped sample or a different query, and make them comparable or label them.
- [ ] **No H.264 badge for one title.** `big_buck_bunny_1080p_h264.mov` gets no badge, probably because the name uses underscores, while another result in the same search does. Check the badge parser's separators.

### P3: consistency

- [ ] **Release lists look different on each page.** Search uses a table with Size/Seeders columns (`renderResult` in `public/search.js`); Explore "Just added" and Title use `releaseRow`. Use `releaseRow` everywhere and delete `renderResult`.
- [ ] **The header search box empties on every page except Search,** so the query disappears after opening a torrent. Keep the last query (URL or `sessionStorage`).
- [ ] **"← Results" appears on torrent pages not reached from a search** (direct links, Explore, recent list). Show it only when there is a search to go back to; otherwise link to where the user came from.
- [ ] **The Player page has a different side gutter** from the other pages.
- [ ] **Open in on the Player has no Download file option,** while the torrent page's ⋯ menu does. Offer the same file actions in both.
- [ ] **More → Copy infohash does the same thing as the clickable ID** next to the torrent's metadata. Keep one.
- [ ] **Screen readers hear "tv_show"** for the Explore Movies/TV switch. Give the radios proper labels.

### P4: polish

- [ ] **The Player doesn't fit the viewport.** At 800×600 the full-width video pushes Audio/Subtitles/Open in below the fold. Cap the video height at roughly the viewport minus the top bar and controls.
- [ ] **ⓘ Details shows raw ffprobe values.** Container reads `mov,mp4,m4a,3gp,3g2,mj2` and unnamed audio tracks read "1. Track (mp3 2ch)". Map them to "MP4" and "MP3 stereo".
- [ ] **The source label repeats on every search row** ("BitMagnet") with a single source configured. Show it only with more than one source.
- [ ] **Odd spacing on the Torrent and Title pages.** The torrent page has an empty band between the title and "3 files · 276 MB", and the Title page has a large gap above "Releases".
- [ ] **An unknown torrent's heading is the 40-character infohash** until metadata arrives. Shorten it (`dd8255ec…`).
- [ ] **The Search home page is blank on first run.** With an empty cache there is nothing under the search bar. Add a line of help or a link to Explore. Recent items also can't be removed.
- [ ] **Mobile wrapping.** At 375 px "last played just now" wraps under the file name on the torrent page, and Explore's "Just added" meta line (time · size · seeders) squeezes release names until they break mid-word. Put meta under the name on narrow screens.
- [ ] **Explore tiles are tall blocks of colour with only a name.** Without posters the 2:3 shape wastes most of the screen. Try a shorter tile or a dense list view so more titles fit.
