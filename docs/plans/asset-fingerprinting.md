# Asset fingerprinting

## Goal

Behind a caching reverse proxy, a new release must reach browsers on the next reload. Before this change, pages, bundles and the stylesheet lived at fixed URLs (`/search.js`, `/style.css`) with `no-cache` and a weak ETag built from file metadata, so any proxy or browser that kept a copy fresh (heuristically, through an overridden TTL, or by ignoring weak validators) served the previous release's assets.

## Design

- The build stays a single esbuild command: `public/style.css` joins the page entries, `--entry-names=[name]-[hash]` writes `dist/client/assets/`, and `--metafile=dist/client/meta.json` records which output each entry became. `npm run dev` uses `--watch=forever` (plain `--watch` stops when a backgrounded job has no stdin), which rewrites the metafile on each rebuild; esbuild never deletes earlier outputs, so old hashed files stay in `dist/client/assets/` (harmless: pages link only the current ones; Docker builds from a clean tree).
- Node rewrites each page's `src`/`href` links (`/search.js`, `/style.css`) to the hashed URLs from the metafile, re-reading it when its mtime changes. A link the build doesn't produce is an error. Pages are `no-cache` with a strong SHA-256 content ETag (`sendCached`).
- `/assets/:name` serves only `[name]-[HASH].{js,css}[.map]` with `public, max-age=31536000, immutable`. The old unversioned URLs are 404.
- A custom build script that wrote rewritten pages into `dist/` was tried first and dropped as too much tooling for the job. Vite would also do the hashing, but needs a dev plugin for the page routes and a proxy to Node; see the architecture notes.

## Todos

- [x] esbuild flags for hashed names and the metafile.
- [x] Static routes: metafile-linked content-ETag pages, immutable hashed assets, unversioned URLs removed.
- [x] Dockerfile build stage gets `public/style.css`; Docker smoke check expects hashed, immutable bundles.
- [x] App test: every linked asset is hashed and immutable, pages revalidate with strong ETags.
- [x] README cache-policy table and proxy guidance, architecture build notes.
