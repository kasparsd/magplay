# HTTP caching and reverse proxies

Successful GETs and HEADs use these policies (HEAD has no body). All errors,
including 404-before-ready and 416, use `no-store`; redirects and mutations do
too.

| Response class | Cache-Control | Validators / reason |
|---|---|---|
| HTML pages | `no-cache` | Content ETag; store, but revalidate on each use, so a release shows up on reload. |
| `/assets/…` bundles (including `hls.js`), stylesheet and source maps | `public, max-age=31536000, immutable` | Content-hashed file names: a release links new URLs, so any cache may keep these for good. Weak metadata ETag and Last-Modified. |
| Probe API summary | `private, no-cache` | Content ETag; stable media metadata, revalidated for software changes. |
| Raw torrent files and tar downloads | `private, max-age=3600, must-revalidate` | Strong content-identity ETag; one hour of browser reuse, then revalidate. Range/If-Range retained. |
| Completed `/subs/…` conversions | `private, no-cache` | Content ETag; revalidate generated output across releases. |
| HLS playlists, `init.mp4`, `.m4s` segments and `.vtt` | `no-store` | Made on demand per player session and gone when it closes; a growing playlist and the subtitles change as conversion goes on. |
| Other APIs (search, Explore/title, torrent description, recent, status, health), `.m3u` playlists | `no-store` | Mutable state, expiring link IDs, keepalive side effects or forwarded-host-dependent links. Explore's existing in-process cache is separate from HTTP caching. |

Conditional GET/HEAD supports weak/list/wildcard `If-None-Match`, which takes
precedence over `If-Modified-Since`. A matching validator returns a bodyless 304.
Raw/tar preconditions run before Range; If-Range requires the exact strong ETag
(weak or mismatched validators cause a full response). HEAD ignores Range.
Large files remain streamed: media is not buffered or hashed per request.
`private` intentionally permits browser caching but not shared proxy caches, even
on a single-user server. Cached raw bytes may remain usable for an hour after
origin cache eviction; HLS session media is never stored.

A conservative Nginx configuration needs no disk proxy cache:

```nginx
location / {
    proxy_pass http://magplay:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
}
```

Respect origin Cache-Control/Expires; do not use `proxy_ignore_headers` or a
blanket `expires`/`immutable` rule. Do not cache POST/DELETE, live endpoints,
redirects or errors (including missing HLS files). Preserve ETag, Last-Modified,
conditional request headers, Range/If-Range, Accept-Ranges, Content-Range and
Content-Disposition; Nginx's default proxy header forwarding does this. Do not
buffer media streams. This example intentionally does not enable shared caching
of any API/media.

A caching proxy in front of Node can follow these headers as sent: it must
revalidate the pages (`no-cache`) and may keep `/assets/…` indefinitely. Never
give the pages themselves a fresh TTL, or a release keeps serving old pages that
link the previous release's assets.

The built pages already link the hashed asset names, but the page routes
(`/play/…`, `/t/…`) live in Node, so let Node serve the pages. A frontend may serve `dist/client/assets/` itself with
`Cache-Control: public, max-age=31536000, immutable` and proxy everything else
to Node. Deploy the frontend and backend together. No Node/proxy speedup has been
benchmarked.

See also the README's [reverse proxy notes](../README.md#troubleshooting) and
[Configuration](../README.md#configuration).<|end|><|start|>Assistant to=bash<|channel|>analysis <|constrain|>xml<|message|><rfl:parameter name="path">
/Users/kaspars/Projects/madplay/docs/dependencies.md