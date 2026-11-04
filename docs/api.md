# HTTP API

Reference for magplay's JSON/HTTP API. The README keeps a short summary; this
document holds the full table. Paths are relative to the server root.

Any HTTP client can use the API. A request other than GET or HEAD that a browser marks as coming from a page on another site (`Sec-Fetch-Site` other than `same-origin`, or an `Origin` that doesn't match the host) is a 403; requests without those headers, such as curl or scripts, are not affected. A request body must be `Content-Type: application/json` (415 otherwise).

| Method + path | Does |
|---|---|
| `GET /`, `/t/:ih`, `/play/:ih/:idx` | The pages: search, a torrent's files and activity, the player. Every step has its own URL, so reload, Back, bookmarks and new tabs work. `/t?link=<linkId>` opens a link-only search result and switches to `/t/<infohash>` once resolved. Old `/player.html?ih=&idx=` links redirect. |
| `GET /api/explore?type=&genre=&year=&res=&sort=&page=` | A page of titles from BitMagnet: `{titles:[{type, source, id, title, year, rating, runtime, overview, genres, links, seeders, playable, best}], hasMore}`. `seeders` is the most-seeded release's on that page. `type` is `movie` or `tv_show`, `sort` is `seeders` or `added`. Cached 60 s. |
| `GET /api/explore/facets?type=&genre=&year=&res=` | Genre, year and resolution counts under those filters: `{genres:[{value, label, count, estimate?}], years, resolutions}`. Slow on a big index (tens of seconds for TV), so cached 15 min and warmed for both types at startup. `estimate: true` marks a count BitMagnet only estimated from Postgres statistics (film genre estimates can be 100× too low); Explore shows those without a number. |
| `GET /api/explore/latest?type=` | The newest releases, matched or not |
| `GET /api/title/:type/:source/:id?title=&year=` | A title's metadata and its releases in BitMagnet, from the 100 most-seeded search hits for its name; `truncated: true` when there were more hits |
| `GET /api/recent` | Torrents with saved metadata in the cache, most recently used first: `[{infoHash, name, length, onDisk, lastUsed}]` |
| `GET /api/search?q=&cat=` | Searches all sources. Returns `{results: [{title, infoHash, magnet, linkId, size, seeders\|null, sources, badges, likelyDirect, playbackEffort}], sources: [{name, ok, count, error, ms}]}`, where `playbackEffort` is `direct`, `remux`, `transcode` or `null`, with results sorted by seeders, then size. 502 only if every source fails. |
| `POST /api/torrents` `{infoHash \| magnet \| linkId}` | Adds or reuses the torrent, waits for metadata (504 after `METADATA_TIMEOUT_S`) and returns `{infoHash, name, files:[{idx, name, size, isVideo, isSub, season, episode}]}`. Nothing is downloaded until a file is streamed. `linkId` refers to a download link from a recent search (410 if it has expired). |
| `GET /api/torrents/:ih` | The same as `POST /api/torrents` with an infohash: loads the torrent if needed and returns its file list |
| `GET /api/torrents/:ih/status[?idx=&session=&pos=]` | Live view of a loaded torrent (never loads one): `{loaded, activeStreams, downloadSpeed, uploadSpeed, downloaded, length, progress, files:[{idx, progress}], peers:[{address, client, type, downloadSpeed, uploadSpeed, downloaded, uploaded, share, choking}]}`. The player adds `idx` for `file: {progress, ranges}` (which also keeps the torrent loaded) and `session`/`pos` (its position in the file) for its HLS session's `{encoder, speed, fps, cpu, produced, readyUntil, ready, growing, paused, running, failed, error}` (which keeps the session alive). `ready` lists the converted time ranges on the file's timeline. |
| `GET /raw/:ih/:idx[/:name][?download=1]` | The file, with `Range`, `ETag` and `If-Range` support. `download=1` adds `Content-Disposition: attachment`. |
| `GET /tar/:ih[/:name.tar]` | Every file in the torrent as one tar archive (PAX headers), with known length and Range support for resuming |
| `GET /playlist.m3u?ih=[&idx=]` | `.m3u` for external players: one file, or every video in the torrent |
| `GET /api/probe/:ih/:idx` | What the file holds, read from its headers in Node: duration, start time, container (`mp4`, `mov`, `matroska`, `webm`, `mpegts`…), video, audio and subtitle tracks, external subtitle files |
| `POST /api/play` `{ih, idx, audio, start, caps, browserRemux, tab}` | `{mode, reason, url, duration, session, growing, subtitles}`, or 422 with an explanation. Stops the tab's previous session. Every mode plays on the file's own timeline; for HLS, `start` is only where conversion begins. `mode` is `direct`, `remux`, `transcode` or, on a server without ffmpeg whose page can repackage (`browserRemux`, default yes), `browser-remux` (`url` is the `/raw` file, `audio` the track index, no `session`). A page that can't (`browserRemux: false`) gets `remux` produced in Node instead of by ffmpeg. |
| `GET /hls/:session/:file` | `index.m3u8` (the whole file, or a growing playlist when `growing`), `init.mp4`, `seg_N.m4s` (answered once converted; a segment far from the running conversion restarts it there) and `sub_N.vtt` (every cue converted so far, on the file's timeline) |
| `DELETE` or `POST /api/play/:session` | Stops ffmpeg and deletes the session directory. `POST` is for `navigator.sendBeacon` when the tab closes. Sessions with no requests for 45 s are also stopped. |
| `POST /api/play/tab/:tab` | Closes a page activation, including a session whose POST result has not reached the browser yet; late requests for that activation are fenced briefly. |
| `GET /subs/:ih/:idx/:track.vtt` | Embedded text subtitle `track` as WebVTT (direct mode; reads the whole file), or `file.vtt` to convert a `.srt`/`.vtt`/`.ass` file in the torrent |
| `GET /api/status` | `{level, checks:[{id, label, level, required, value, message, action}]}`. Checks run when asked and are cached (sources and Explore 60 s, disk 30 s, ffmpeg once; a missing ffmpeg is `warn`, not `error`). |
| `GET /api/settings` | Server settings in use, secrets masked as `{set}`, with `meta[key] = {source: env\|file\|default, env, locked}` |
| `PATCH /api/settings` | A partial update, validated as a whole (400 with `fields` per key, nothing saved) and written atomically. |
| `POST /api/settings/test` `{key: 'sources', item}` | Checks a source with unsaved values; returns a check result |
| `GET /api/debug` | Version, uptime, ffmpeg versions, busy slots and limits, disk and cache use, and the bounded structured log tail plus capture level/drop count |
| `POST /api/debug/clear-hls` | Stops every conversion and deletes its segments |
| `GET /api/speedtest` | Random bytes (up to 256 MB) for the browser's connection test |
| `GET /health` | 200 `{ ok, uptimeS }`; 503 once shutdown has begun |

See also the README's [Configuration](../README.md#configuration) and the
[HTTP caching](http-caching.md) reference.<|end|><|start|>Assistant to=bash<|channel|>analysis <|constrain|>xml<|message|><rfl:parameter name="path">
/Users/kaspars/Projects/madplay/docs/http-caching.md